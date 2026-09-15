const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { pool } = require('../db');
const { sendMail } = require('../mailer');
const { buildFinalPdf } = require('../pdf');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function baseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

async function loadEnvelopeRow(id) {
  const r = await pool.query('SELECT * FROM envelopes WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function loadSigners(envelopeId) {
  const r = await pool.query('SELECT * FROM signers WHERE envelope_id=$1 ORDER BY order_index ASC', [envelopeId]);
  return r.rows;
}

async function loadPages(envelopeId) {
  const r = await pool.query('SELECT * FROM envelope_pages WHERE envelope_id=$1 ORDER BY page_index ASC', [envelopeId]);
  return r.rows;
}

async function addAudit(envelopeId, text) {
  await pool.query('INSERT INTO audit_log (envelope_id, text) VALUES ($1,$2)', [envelopeId, text]);
}

function emailHtml(bodyLines) {
  return `<div style="font-family:sans-serif; font-size:14px; color:#1C2B3A;">${bodyLines.map(l => `<p>${l}</p>`).join('')}</div>`;
}

async function emailSignerTurn(req, envelope, signer) {
  const link = `${baseUrl(req)}/sign/${signer.sign_token}`;
  await sendMail({
    to: signer.email,
    subject: `Please sign: ${envelope.title}`,
    text: `You've been asked to sign "${envelope.title}". Open this link to review and sign: ${link}`,
    html: emailHtml([
      `You've been asked to sign <strong>${envelope.title}</strong>.`,
      `<a href="${link}">Open the document and sign</a>`
    ])
  });
}

async function emailCompletion(req, envelope, signer, pdfBuffer) {
  await sendMail({
    to: signer.email,
    subject: `Completed: ${envelope.title}`,
    text: `All parties have signed "${envelope.title}". The executed document is attached.`,
    html: emailHtml([`All parties have signed <strong>${envelope.title}</strong>. The executed document is attached.`]),
    attachments: [{ filename: `${envelope.title} - executed.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
  });
}

// ---------- create envelope ----------
router.post('/envelopes', upload.fields([{ name: 'document', maxCount: 1 }, { name: 'pages', maxCount: 20 }]), async (req, res) => {
  const client = await pool.connect();
  try {
    const title = (req.body.title || '').trim() || 'Untitled document';
    const sequential = req.body.sequential === 'true' || req.body.sequential === true;
    let signers;
    try { signers = JSON.parse(req.body.signers || '[]'); } catch (e) { return res.status(400).json({ error: 'Invalid signers payload' }); }
    if (!Array.isArray(signers) || signers.length < 2) return res.status(400).json({ error: 'At least two signers are required' });
    for (const s of signers) {
      if (!s.name || !s.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) {
        return res.status(400).json({ error: 'Every signer needs a name and a valid email' });
      }
    }

    const docFile = req.files.document && req.files.document[0];
    const pageFiles = req.files.pages || [];
    if (!docFile && !pageFiles.length) return res.status(400).json({ error: 'No document uploaded' });

    let sourceType, fileName, mimeType, originalBytes = null, plainText = null;
    if (docFile) {
      fileName = docFile.originalname;
      mimeType = docFile.mimetype;
      originalBytes = docFile.buffer;
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.pdf')) {
        sourceType = 'pdf';
      } else if (lower.endsWith('.doc') || lower.endsWith('.docx')) {
        sourceType = 'docx';
        try {
          const textRes = await mammoth.extractRawText({ buffer: docFile.buffer });
          plainText = textRes.value;
        } catch (err) { console.warn('mammoth extract failed', err.message); }
      } else {
        return res.status(400).json({ error: 'Unsupported file type — use PDF or Word' });
      }
    } else {
      sourceType = 'image';
      fileName = 'Scanned document';
      mimeType = null;
    }

    await client.query('BEGIN');
    const envRes = await client.query(
      `INSERT INTO envelopes (title, source_type, file_name, mime_type, original_bytes, plain_text, sequential, current_turn_index, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,'sent') RETURNING id, created_at`,
      [title, sourceType, fileName, mimeType, originalBytes, plainText, sequential]
    );
    const envelopeId = envRes.rows[0].id;

    if (sourceType === 'image') {
      let idx = 0;
      for (const f of pageFiles) {
        await client.query(
          'INSERT INTO envelope_pages (envelope_id, page_index, mime_type, image_bytes) VALUES ($1,$2,$3,$4)',
          [envelopeId, idx++, f.mimetype, f.buffer]
        );
      }
    }

    const insertedSigners = [];
    let orderIdx = 1;
    for (const s of signers) {
      const token = genToken();
      const r = await client.query(
        `INSERT INTO signers (envelope_id, name, email, order_index, status, sign_token)
         VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
        [envelopeId, s.name.trim(), s.email.trim(), orderIdx++, token]
      );
      insertedSigners.push(r.rows[0]);
    }

    await client.query('INSERT INTO audit_log (envelope_id, text) VALUES ($1, $2)', [envelopeId, 'Envelope created and sent for signature.']);
    await client.query('COMMIT');

    const toEmail = sequential ? [insertedSigners[0]] : insertedSigners;
    for (const s of toEmail) {
      emailSignerTurn(req, { title }, s).catch(e => console.error('email failed', e.message));
    }

    res.json({ id: envelopeId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('create envelope failed', err);
    res.status(500).json({ error: 'Could not create envelope' });
  } finally {
    client.release();
  }
});

// ---------- list ----------
router.get('/envelopes', async (req, res) => {
  const envs = await pool.query('SELECT id, title, status, sequential, current_turn_index, created_at FROM envelopes ORDER BY created_at DESC');
  const out = [];
  for (const e of envs.rows) {
    const signers = await pool.query('SELECT id, name, email, status, order_index FROM signers WHERE envelope_id=$1 ORDER BY order_index', [e.id]);
    out.push({ ...e, signers: signers.rows });
  }
  res.json(out);
});

// ---------- detail (session OR token) ----------
async function resolveAccess(req, envelopeId) {
  if (req.session && req.session.authed) return true;
  const token = req.query.token;
  if (!token) return false;
  const r = await pool.query('SELECT 1 FROM signers WHERE envelope_id=$1 AND sign_token=$2', [envelopeId, token]);
  return r.rows.length > 0;
}

router.get('/envelopes/:id', async (req, res) => {
  const ok = await resolveAccess(req, req.params.id);
  if (!ok) return res.status(403).json({ error: 'Not authorized' });
  // Only the authenticated sender may see signing tokens/links — a signer's own token
  // must never unlock another signer's token, or they could sign on someone else's behalf.
  const isSender = !!(req.session && req.session.authed);
  const env = await loadEnvelopeRow(req.params.id);
  if (!env) return res.status(404).json({ error: 'Not found' });
  const signers = await loadSigners(env.id);
  const pages = await loadPages(env.id);
  const audit = await pool.query('SELECT ts, text FROM audit_log WHERE envelope_id=$1 ORDER BY ts ASC', [env.id]);
  res.json({
    id: env.id, title: env.title, source_type: env.source_type, file_name: env.file_name,
    sequential: env.sequential, current_turn_index: env.current_turn_index, status: env.status,
    created_at: env.created_at, completed_at: env.completed_at, fingerprint: env.fingerprint,
    has_final: !!env.final_pdf_bytes, page_count: pages.length,
    signers: signers.map(s => ({
      id: s.id, name: s.name, email: s.email, order_index: s.order_index, status: s.status,
      signed_at: s.signed_at, method: s.method, has_signature: !!s.signature_bytes,
      sign_token: isSender ? s.sign_token : undefined
    })),
    audit: audit.rows
  });
});

// ---------- file / page / signature serving ----------
router.get('/envelopes/:id/file', async (req, res) => {
  const ok = await resolveAccess(req, req.params.id);
  if (!ok) return res.status(403).end();
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || !env.original_bytes) return res.status(404).end();
  res.setHeader('Content-Type', env.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${env.file_name}"`);
  res.send(env.original_bytes);
});

router.get('/envelopes/:id/pages/:idx', async (req, res) => {
  const ok = await resolveAccess(req, req.params.id);
  if (!ok) return res.status(403).end();
  const r = await pool.query('SELECT * FROM envelope_pages WHERE envelope_id=$1 AND page_index=$2', [req.params.id, req.params.idx]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime_type);
  res.send(r.rows[0].image_bytes);
});

router.get('/envelopes/:id/signers/:sid/signature', async (req, res) => {
  const ok = await resolveAccess(req, req.params.id);
  if (!ok) return res.status(403).end();
  const r = await pool.query('SELECT signature_bytes, signature_mime FROM signers WHERE id=$1 AND envelope_id=$2', [req.params.sid, req.params.id]);
  if (!r.rows[0] || !r.rows[0].signature_bytes) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].signature_mime || 'image/png');
  res.send(r.rows[0].signature_bytes);
});

router.get('/envelopes/:id/download', async (req, res) => {
  const ok = await resolveAccess(req, req.params.id);
  if (!ok) return res.status(403).end();
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.status !== 'completed' || !env.final_pdf_bytes) return res.status(409).json({ error: 'Not yet completed' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${env.title.replace(/[^a-z0-9\-_ ]/gi, '')} - executed.pdf"`);
  res.send(env.final_pdf_bytes);
});

// ---------- public: signer context ----------
router.get('/sign/:token/context', async (req, res) => {
  const sr = await pool.query('SELECT * FROM signers WHERE sign_token=$1', [req.params.token]);
  const signer = sr.rows[0];
  if (!signer) return res.status(404).json({ error: 'Invalid or expired link' });
  const env = await loadEnvelopeRow(signer.envelope_id);
  const signers = await loadSigners(env.id);
  const pages = await loadPages(env.id);
  const myTurn = !env.sequential || signer.order_index === env.current_turn_index;
  res.json({
    envelope: { id: env.id, title: env.title, source_type: env.source_type, file_name: env.file_name, sequential: env.sequential, status: env.status, page_count: pages.length },
    you: { id: signer.id, name: signer.name, email: signer.email, order_index: signer.order_index, status: signer.status },
    myTurn,
    signers: signers.map(s => ({ id: s.id, name: s.name, email: s.email, order_index: s.order_index, status: s.status, signed_at: s.signed_at, has_signature: !!s.signature_bytes }))
  });
});

// ---------- public: submit signature ----------
router.post('/sign/:token', upload.single('signature'), async (req, res) => {
  const client = await pool.connect();
  try {
    const sr = await client.query('SELECT * FROM signers WHERE sign_token=$1 FOR UPDATE', [req.params.token]);
    const signer = sr.rows[0];
    if (!signer) return res.status(404).json({ error: 'Invalid or expired link' });
    if (signer.status === 'signed') return res.status(409).json({ error: 'Already signed' });

    const envRes = await client.query('SELECT * FROM envelopes WHERE id=$1 FOR UPDATE', [signer.envelope_id]);
    const env = envRes.rows[0];
    if (env.sequential && signer.order_index !== env.current_turn_index) {
      return res.status(403).json({ error: 'It is not your turn yet' });
    }
    if (req.body.consent !== 'true') return res.status(400).json({ error: 'Consent is required' });
    if (!req.file) return res.status(400).json({ error: 'No signature provided' });

    await client.query('BEGIN');
    await client.query(
      `UPDATE signers SET status='signed', signed_at=now(), signature_bytes=$1, signature_mime=$2, method=$3 WHERE id=$4`,
      [req.file.buffer, req.file.mimetype, req.body.method || 'drawn', signer.id]
    );
    await client.query('INSERT INTO audit_log (envelope_id, text) VALUES ($1,$2)', [env.id, `${signer.name} signed via ${req.body.method || 'electronic signature'}.`]);

    let nextTurnIndex = env.current_turn_index;
    if (env.sequential && signer.order_index === env.current_turn_index) {
      nextTurnIndex = env.current_turn_index + 1;
      await client.query('UPDATE envelopes SET current_turn_index=$1 WHERE id=$2', [nextTurnIndex, env.id]);
    }

    const remaining = await client.query(`SELECT count(*)::int AS n FROM signers WHERE envelope_id=$1 AND status<>'signed'`, [env.id]);
    const allSigned = remaining.rows[0].n === 0;

    if (allSigned) {
      await client.query(`UPDATE envelopes SET status='completed', completed_at=now() WHERE id=$1`, [env.id]);
      await client.query('INSERT INTO audit_log (envelope_id, text) VALUES ($1,$2)', [env.id, 'All parties signed. Document executed.']);
    }
    await client.query('COMMIT');

    if (allSigned) {
      const freshEnv = await loadEnvelopeRow(env.id);
      const pages = await loadPages(env.id);
      const signers = await loadSigners(env.id);
      try {
        const { bytes, fingerprint } = await buildFinalPdf(freshEnv, pages, signers);
        await pool.query('UPDATE envelopes SET final_pdf_bytes=$1, fingerprint=$2 WHERE id=$3', [bytes, fingerprint, env.id]);
        for (const s of signers) {
          emailCompletion(req, freshEnv, s, bytes).catch(e => console.error('completion email failed', e.message));
        }
      } catch (err) {
        console.error('final pdf assembly failed', err);
        await addAudit(env.id, 'The final PDF could not be fully assembled: ' + err.message);
      }
      return res.json({ status: 'signed', allSigned: true });
    } else if (env.sequential) {
      const nextSigner = (await loadSigners(env.id)).find(s => s.order_index === nextTurnIndex);
      if (nextSigner) emailSignerTurn(req, env, nextSigner).catch(e => console.error('email failed', e.message));
    }

    res.json({ status: 'signed', allSigned: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign failed', err);
    res.status(500).json({ error: 'Could not record signature' });
  } finally {
    client.release();
  }
});

module.exports = router;
