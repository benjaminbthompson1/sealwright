const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const mammoth = require('mammoth');
const { pool } = require('../db');
const { sendMail } = require('../mailer');
const { buildFinalPdf, buildDocxDraftPdf } = require('../pdf');
const { findUserById } = require('../auth');
const { signRequestEmail, completionEmail, cancelledEmail } = require('../emailTemplates');

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
  await pool.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), envelopeId, text]);
}

async function senderDisplayName(ownerId) {
  if (!ownerId) return null;
  const owner = await findUserById(ownerId);
  if (!owner) return null;
  const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ');
  return name || null;
}

async function getSavedSignature(email) {
  const r = await pool.query('SELECT * FROM saved_signatures WHERE email=$1', [String(email).trim().toLowerCase()]);
  return r.rows[0] || null;
}

// kind: 'signature' | 'initial'
async function upsertSavedSignature(email, kind, bytes, mime) {
  const normalized = String(email).trim().toLowerCase();
  const col = kind === 'initial' ? 'initial_bytes' : 'signature_bytes';
  const mimeCol = kind === 'initial' ? 'initial_mime' : 'signature_mime';
  await pool.query(
    `INSERT INTO saved_signatures (email, ${col}, ${mimeCol}, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (email) DO UPDATE SET ${col}=$2, ${mimeCol}=$3, updated_at=now()`,
    [normalized, bytes, mime]
  );
}

async function emailSignerTurn(req, envelope, signer, senderName) {
  const link = `${baseUrl(req)}/sealwright/sign/${signer.sign_token}`;
  const t = signRequestEmail({ signerName: signer.name, envelopeTitle: envelope.title, senderName, signUrl: link });
  await sendMail({ to: signer.email, subject: t.subject, text: t.text, html: t.html });
}

async function emailCompletion(req, envelope, signer, pdfBuffer, fingerprint) {
  const t = completionEmail({ signerName: signer.name, envelopeTitle: envelope.title, fingerprint });
  await sendMail({
    to: signer.email, subject: t.subject, text: t.text, html: t.html,
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
    if (!Array.isArray(signers) || signers.length < 1) return res.status(400).json({ error: 'At least one signer is required' });
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
    const envelopeId = crypto.randomUUID();
    // Field placement (docx only) needs the sender to see real, paginated
    // pages before signers are notified — so this envelope is created in a
    // 'preparing' state with no emails sent yet, and only flips to 'sent'
    // once POST /envelopes/:id/send is called after fields are placed.
    const prepareFields = sourceType === 'docx' && (req.body.prepareFields === 'true' || req.body.prepareFields === true);
    const initialStatus = prepareFields ? 'preparing' : 'sent';
    const envRes = await client.query(
      `INSERT INTO envelopes (id, owner_id, title, source_type, file_name, mime_type, original_bytes, plain_text, sequential, current_turn_index, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10) RETURNING id, created_at`,
      [envelopeId, req.session.userId, title, sourceType, fileName, mimeType, originalBytes, plainText, sequential, initialStatus]
    );

    if (sourceType === 'image') {
      let idx = 0;
      for (const f of pageFiles) {
        await client.query(
          'INSERT INTO envelope_pages (id, envelope_id, page_index, mime_type, image_bytes) VALUES ($1,$2,$3,$4,$5)',
          [crypto.randomUUID(), envelopeId, idx++, f.mimetype, f.buffer]
        );
      }
    }

    const insertedSigners = [];
    let orderIdx = 1;
    for (const s of signers) {
      const token = genToken();
      const r = await client.query(
        `INSERT INTO signers (id, envelope_id, name, email, order_index, status, sign_token)
         VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
        [crypto.randomUUID(), envelopeId, s.name.trim(), s.email.trim(), orderIdx++, token]
      );
      insertedSigners.push(r.rows[0]);
    }

    if (prepareFields) {
      await client.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), envelopeId, 'Envelope created — placing fields before sending.']);
      await client.query('COMMIT');
      return res.json({ id: envelopeId, status: 'preparing' });
    }

    await client.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), envelopeId, 'Envelope created and sent for signature.']);
    await client.query('COMMIT');

    const toEmail = sequential ? [insertedSigners[0]] : insertedSigners;
    if (toEmail.length) {
      const senderName = await senderDisplayName(req.session.userId);
      for (const s of toEmail) {
        emailSignerTurn(req, { title }, s, senderName).catch(e => console.error('email failed', e.message));
      }
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

// ---------- field placement (docx envelopes only, while status='preparing') ----------
router.get('/envelopes/:id/draft-pdf', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.source_type !== 'docx') return res.status(404).end();
  try {
    const bytes = await buildDocxDraftPdf(env.plain_text);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(bytes);
  } catch (err) {
    console.error('draft pdf failed', err);
    res.status(500).end();
  }
});

router.get('/envelopes/:id/fields', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).json({ error: 'Not authorized' });
  const r = await pool.query('SELECT * FROM envelope_fields WHERE envelope_id=$1 ORDER BY page_index, y', [req.params.id]);
  res.json(r.rows.map(f => ({
    id: f.id, signer_id: f.signer_id, field_type: f.field_type, page_index: f.page_index,
    x: f.x, y: f.y, width: f.width, height: f.height,
    filled: !!(f.filled_image_bytes || f.filled_text !== null || f.filled_bool !== null),
    filled_text: f.filled_text, filled_bool: f.filled_bool, has_filled_image: !!f.filled_image_bytes
  })));
});

router.get('/envelopes/:id/fields/:fieldId/image', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
  const r = await pool.query('SELECT filled_image_bytes, filled_image_mime FROM envelope_fields WHERE id=$1 AND envelope_id=$2', [req.params.fieldId, req.params.id]);
  if (!r.rows[0] || !r.rows[0].filled_image_bytes) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].filled_image_mime || 'image/png');
  res.send(r.rows[0].filled_image_bytes);
});

const FIELD_TYPES = ['signature', 'initial', 'date', 'title', 'checkbox'];

router.post('/envelopes/:id/fields', express.json(), async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  if (env.status !== 'preparing') return res.status(400).json({ error: 'Fields can only be placed before sending' });
  const { signer_id, field_type, page_index, x, y, width, height } = req.body || {};
  if (!FIELD_TYPES.includes(field_type)) return res.status(400).json({ error: 'Invalid field type' });
  const signerCheck = await pool.query('SELECT 1 FROM signers WHERE id=$1 AND envelope_id=$2', [signer_id, env.id]);
  if (!signerCheck.rows.length) return res.status(400).json({ error: 'Invalid signer' });
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO envelope_fields (id, envelope_id, signer_id, field_type, page_index, x, y, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, env.id, signer_id, field_type, page_index, x, y, width, height]
  );
  res.json({ id });
});

router.delete('/envelopes/:id/fields/:fieldId', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  if (env.status !== 'preparing') return res.status(400).json({ error: 'Fields can only be edited before sending' });
  await pool.query('DELETE FROM envelope_fields WHERE id=$1 AND envelope_id=$2', [req.params.fieldId, env.id]);
  res.json({ deleted: true });
});

router.patch('/envelopes/:id/fields/:fieldId', express.json(), async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  if (env.status !== 'preparing') return res.status(400).json({ error: 'Fields can only be edited before sending' });
  const fieldRes = await pool.query('SELECT * FROM envelope_fields WHERE id=$1 AND envelope_id=$2', [req.params.fieldId, env.id]);
  const field = fieldRes.rows[0];
  if (!field) return res.status(404).json({ error: 'Not found' });
  // Re-clamp server-side too — the client already keeps the box on the page
  // during the drag, but this is the actual source of truth for the value
  // that ends up in the final PDF, so it shouldn't blindly trust the client.
  const x = Math.max(0, Math.min(1 - field.width, Number(req.body.x)));
  const y = Math.max(0, Math.min(1 - field.height, Number(req.body.y)));
  if (Number.isNaN(x) || Number.isNaN(y)) return res.status(400).json({ error: 'Invalid position' });
  await pool.query('UPDATE envelope_fields SET x=$1, y=$2 WHERE id=$3', [x, y, field.id]);
  res.json({ x, y });
});

router.post('/envelopes/:id/send', express.json(), async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  if (env.status !== 'preparing') return res.status(400).json({ error: 'This envelope has already been sent' });

  const signers = await loadSigners(env.id);
  const fieldsRes = await pool.query('SELECT signer_id FROM envelope_fields WHERE envelope_id=$1', [env.id]);
  const signersWithFields = new Set(fieldsRes.rows.map(f => f.signer_id));
  const missing = signers.filter(s => !signersWithFields.has(s.id));
  if (missing.length) {
    return res.status(400).json({ error: `Add at least one field for: ${missing.map(s => s.name).join(', ')}` });
  }

  await pool.query(`UPDATE envelopes SET status='sent' WHERE id=$1`, [env.id]);
  await addAudit(env.id, 'Envelope sent for signature.');

  const toEmail = env.sequential ? [signers[0]] : signers;
  const senderName = await senderDisplayName(req.session.userId);
  for (const s of toEmail) {
    emailSignerTurn(req, env, s, senderName).catch(e => console.error('email failed', e.message));
  }
  res.json({ status: 'sent' });
});

// ---------- list ----------
router.get('/envelopes', async (req, res) => {
  // Includes envelopes this user owns (sent) AND envelopes where they appear
  // as a signer under the same email as their account (received) — matched
  // case-insensitively since signer emails are typed freely at creation time
  // and aren't normalized the way account emails are.
  const envs = await pool.query(
    `SELECT e.id, e.title, e.status, e.sequential, e.current_turn_index, e.created_at,
            (e.owner_id = $1) AS is_owner
     FROM envelopes e
     WHERE e.owner_id = $1
        OR EXISTS (SELECT 1 FROM signers s WHERE s.envelope_id = e.id AND LOWER(s.email) = LOWER($2))
     ORDER BY e.created_at DESC`,
    [req.session.userId, req.session.userEmail || '']
  );
  const out = [];
  for (const e of envs.rows) {
    const signers = await pool.query('SELECT id, name, email, status, order_index FROM signers WHERE envelope_id=$1 ORDER BY order_index', [e.id]);
    out.push({ ...e, signers: signers.rows });
  }
  res.json(out);
});

// ---------- detail (owner via session, a recipient whose account email
// matches a signer on the envelope, OR a signer via their own token) ----------
async function resolveAccess(req, envelopeId) {
  if (req.session && req.session.userId) {
    const ownerCheck = await pool.query('SELECT 1 FROM envelopes WHERE id=$1 AND owner_id=$2', [envelopeId, req.session.userId]);
    if (ownerCheck.rows.length > 0) return { ok: true, isOwner: true };
    if (req.session.userEmail) {
      const recipientCheck = await pool.query(
        'SELECT 1 FROM signers WHERE envelope_id=$1 AND LOWER(email)=LOWER($2)',
        [envelopeId, req.session.userEmail]
      );
      // A logged-in recipient gets read access (view, download) but never
      // isOwner — that flag is what unlocks other signers' tokens and the
      // delete action, and must stay reserved for the actual sender.
      if (recipientCheck.rows.length > 0) return { ok: true, isOwner: false };
    }
  }
  const token = req.query.token;
  if (token) {
    const r = await pool.query('SELECT 1 FROM signers WHERE envelope_id=$1 AND sign_token=$2', [envelopeId, token]);
    if (r.rows.length > 0) return { ok: true, isOwner: false };
  }
  return { ok: false, isOwner: false };
}

router.get('/envelopes/:id', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).json({ error: 'Not authorized' });
  // Only the owning sender may see signing tokens/links — a signer's own token
  // must never unlock another signer's token, or they could sign on someone else's behalf.
  const isSender = access.isOwner;
  const env = await loadEnvelopeRow(req.params.id);
  if (!env) return res.status(404).json({ error: 'Not found' });
  const signers = await loadSigners(env.id);
  const pages = await loadPages(env.id);
  const audit = await pool.query('SELECT ts, text FROM audit_log WHERE envelope_id=$1 ORDER BY ts ASC', [env.id]);
  res.json({
    id: env.id, title: env.title, source_type: env.source_type, file_name: env.file_name,
    sequential: env.sequential, current_turn_index: env.current_turn_index, status: env.status,
    created_at: env.created_at, completed_at: env.completed_at, fingerprint: env.fingerprint,
    has_final: !!env.final_pdf_bytes, page_count: pages.length, is_owner: isSender,
    signers: signers.map(s => ({
      id: s.id, name: s.name, email: s.email, order_index: s.order_index, status: s.status,
      signed_at: s.signed_at, method: s.method, has_signature: !!s.signature_bytes,
      sign_token: isSender ? s.sign_token : undefined
    })),
    audit: audit.rows
  });
});

// ---------- delete (owner only — session gated in server.js, ownership checked here) ----------
router.delete('/envelopes/:id', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env) return res.status(404).json({ error: 'Not found' });
  if (env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  // ON DELETE CASCADE on signers, envelope_pages, and audit_log means this one
  // statement removes the whole envelope and everything tied to it, including
  // every stored document byte, signature image, and the audit trail itself.
  await pool.query('DELETE FROM envelopes WHERE id=$1', [env.id]);
  console.log(`Envelope deleted: ${env.id} ("${env.title}")`);
  res.json({ deleted: true });
});

// Cancel is deliberately different from delete: the record, audit trail, and
// any signatures already collected all stay — only the ability to keep
// signing it stops. Signers who already have the link open get a real,
// server-side block (see the guards in the signing endpoints below), not
// just a UI that hides the button.
router.post('/envelopes/:id/cancel', express.json(), async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const env = await loadEnvelopeRow(req.params.id);
  if (!env) return res.status(404).json({ error: 'Not found' });
  if (env.owner_id !== req.session.userId) return res.status(403).json({ error: 'Not authorized' });
  if (env.status !== 'sent' && env.status !== 'preparing') {
    return res.status(400).json({ error: 'Only an in-progress envelope can be cancelled' });
  }
  await pool.query(`UPDATE envelopes SET status='cancelled' WHERE id=$1`, [env.id]);
  await addAudit(env.id, 'Envelope cancelled by the sender.');

  const signers = await loadSigners(env.id);
  const senderName = await senderDisplayName(req.session.userId);
  for (const s of signers) {
    cancelledEmailIfPossible(s, env, senderName);
  }
  res.json({ status: 'cancelled' });
});

function cancelledEmailIfPossible(signer, env, senderName) {
  const t = cancelledEmail({ recipientName: signer.name, envelopeTitle: env.title, senderName });
  sendMail({ to: signer.email, subject: t.subject, text: t.text, html: t.html }).catch(e => console.error('cancellation email failed', e.message));
}

// ---------- file / page / signature serving ----------
router.get('/envelopes/:id/file', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
  const env = await loadEnvelopeRow(req.params.id);
  if (!env || !env.original_bytes) return res.status(404).end();
  res.setHeader('Content-Type', env.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${env.file_name}"`);
  res.send(env.original_bytes);
});

router.get('/envelopes/:id/pages/:idx', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
  const r = await pool.query('SELECT * FROM envelope_pages WHERE envelope_id=$1 AND page_index=$2', [req.params.id, req.params.idx]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime_type);
  res.send(r.rows[0].image_bytes);
});

router.get('/envelopes/:id/signers/:sid/signature', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
  const r = await pool.query('SELECT signature_bytes, signature_mime FROM signers WHERE id=$1 AND envelope_id=$2', [req.params.sid, req.params.id]);
  if (!r.rows[0] || !r.rows[0].signature_bytes) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].signature_mime || 'image/png');
  res.send(r.rows[0].signature_bytes);
});

router.get('/envelopes/:id/download', async (req, res) => {
  const access = await resolveAccess(req, req.params.id);
  if (!access.ok) return res.status(403).end();
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
  const fieldsRes = await pool.query('SELECT * FROM envelope_fields WHERE envelope_id=$1 ORDER BY page_index, y', [env.id]);
  const myTurn = !env.sequential || signer.order_index === env.current_turn_index;
  const saved = await getSavedSignature(signer.email);
  res.json({
    envelope: { id: env.id, title: env.title, source_type: env.source_type, file_name: env.file_name, sequential: env.sequential, status: env.status, page_count: pages.length },
    you: { id: signer.id, name: signer.name, email: signer.email, order_index: signer.order_index, status: signer.status },
    myTurn,
    hasFields: fieldsRes.rows.length > 0,
    savedSignature: { hasSignature: !!(saved && saved.signature_bytes), hasInitial: !!(saved && saved.initial_bytes) },
    fields: fieldsRes.rows.map(f => ({
      id: f.id, signer_id: f.signer_id, field_type: f.field_type, page_index: f.page_index,
      x: f.x, y: f.y, width: f.width, height: f.height,
      filled_text: f.filled_text, filled_bool: f.filled_bool, has_filled_image: !!f.filled_image_bytes
    })),
    signers: signers.map(s => ({ id: s.id, name: s.name, email: s.email, order_index: s.order_index, status: s.status, signed_at: s.signed_at, has_signature: !!s.signature_bytes }))
  });
});

router.get('/sign/:token/saved-image', async (req, res) => {
  const sr = await pool.query('SELECT * FROM signers WHERE sign_token=$1', [req.params.token]);
  const signer = sr.rows[0];
  if (!signer) return res.status(404).end();
  const saved = await getSavedSignature(signer.email);
  const kind = req.query.type === 'initial' ? 'initial' : 'signature';
  const bytes = saved && (kind === 'initial' ? saved.initial_bytes : saved.signature_bytes);
  if (!bytes) return res.status(404).end();
  const mime = kind === 'initial' ? saved.initial_mime : saved.signature_mime;
  res.setHeader('Content-Type', mime || 'image/png');
  res.send(bytes);
});

async function finishSignerTurn(req, client, env, signer) {
  let nextTurnIndex = env.current_turn_index;
  if (env.sequential && signer.order_index === env.current_turn_index) {
    nextTurnIndex = env.current_turn_index + 1;
    await client.query('UPDATE envelopes SET current_turn_index=$1 WHERE id=$2', [nextTurnIndex, env.id]);
  }

  const remaining = await client.query(`SELECT count(*)::int AS n FROM signers WHERE envelope_id=$1 AND status<>'signed'`, [env.id]);
  const allSigned = remaining.rows[0].n === 0;

  if (allSigned) {
    await client.query(`UPDATE envelopes SET status='completed', completed_at=now() WHERE id=$1`, [env.id]);
    await client.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), env.id, 'All parties signed. Document executed.']);
  }
  await client.query('COMMIT');

  if (allSigned) {
    const freshEnv = await loadEnvelopeRow(env.id);
    const pages = await loadPages(env.id);
    const signers = await loadSigners(env.id);
    const fieldsRes = await pool.query('SELECT * FROM envelope_fields WHERE envelope_id=$1', [env.id]);
    try {
      const { bytes, fingerprint } = await buildFinalPdf(freshEnv, pages, signers, fieldsRes.rows);
      await pool.query('UPDATE envelopes SET final_pdf_bytes=$1, fingerprint=$2 WHERE id=$3', [bytes, fingerprint, env.id]);
      for (const s of signers) {
        emailCompletion(req, freshEnv, s, bytes, fingerprint).catch(e => console.error('completion email failed', e.message));
      }
      // The creator gets a copy too, at the account email on file — unless
      // that email already matches one of the signers above (e.g. someone
      // signing their own single-party document), which would double-send.
      if (freshEnv.owner_id) {
        const owner = await findUserById(freshEnv.owner_id);
        const alreadyEmailed = owner && signers.some(s => s.email.toLowerCase() === owner.email.toLowerCase());
        if (owner && !alreadyEmailed) {
          emailCompletion(req, freshEnv, { name: owner.first_name || 'there', email: owner.email }, bytes, fingerprint)
            .catch(e => console.error('creator completion email failed', e.message));
        }
      }
    } catch (err) {
      console.error('final pdf assembly failed', err);
      await addAudit(env.id, 'The final PDF could not be fully assembled: ' + err.message);
    }
    return { allSigned: true };
  }
  if (env.sequential) {
    const nextSigner = (await loadSigners(env.id)).find(s => s.order_index === nextTurnIndex);
    if (nextSigner) {
      const senderName = await senderDisplayName(env.owner_id);
      emailSignerTurn(req, env, nextSigner, senderName).catch(e => console.error('email failed', e.message));
    }
  }
  return { allSigned: false };
}

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
    if (env.status === 'cancelled') return res.status(410).json({ error: 'This envelope has been cancelled by the sender' });
    if (env.sequential && signer.order_index !== env.current_turn_index) {
      return res.status(403).json({ error: 'It is not your turn yet' });
    }
    if (req.body.consent !== 'true') return res.status(400).json({ error: 'Consent is required' });

    let sigBytes, sigMime, method;
    if (req.file) {
      sigBytes = req.file.buffer; sigMime = req.file.mimetype; method = req.body.method || 'drawn';
    } else if (req.body.useSaved === 'true') {
      const saved = await getSavedSignature(signer.email);
      if (!saved || !saved.signature_bytes) return res.status(400).json({ error: 'No saved signature on file' });
      sigBytes = saved.signature_bytes; sigMime = saved.signature_mime; method = 'saved signature';
    } else {
      return res.status(400).json({ error: 'No signature provided' });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE signers SET status='signed', signed_at=now(), signature_bytes=$1, signature_mime=$2, method=$3 WHERE id=$4`,
      [sigBytes, sigMime, method, signer.id]
    );
    await client.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), env.id, `${signer.name} signed via ${method}.`]);

    if (req.body.saveForFuture === 'true') {
      upsertSavedSignature(signer.email, 'signature', sigBytes, sigMime).catch(e => console.error('save signature failed', e.message));
    }

    const result = await finishSignerTurn(req, client, env, signer);
    res.json({ status: 'signed', allSigned: result.allSigned });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sign failed', err);
    res.status(500).json({ error: 'Could not record signature' });
  } finally {
    client.release();
  }
});

// ---------- public: submit placed fields (docx envelopes that used field placement) ----------
router.post('/sign/:token/fields', upload.any(), async (req, res) => {
  const client = await pool.connect();
  try {
    const sr = await client.query('SELECT * FROM signers WHERE sign_token=$1 FOR UPDATE', [req.params.token]);
    const signer = sr.rows[0];
    if (!signer) return res.status(404).json({ error: 'Invalid or expired link' });
    if (signer.status === 'signed') return res.status(409).json({ error: 'Already signed' });

    const envRes = await client.query('SELECT * FROM envelopes WHERE id=$1 FOR UPDATE', [signer.envelope_id]);
    const env = envRes.rows[0];
    if (env.status === 'cancelled') return res.status(410).json({ error: 'This envelope has been cancelled by the sender' });
    if (env.sequential && signer.order_index !== env.current_turn_index) {
      return res.status(403).json({ error: 'It is not your turn yet' });
    }
    if (req.body.consent !== 'true') return res.status(400).json({ error: 'Consent is required' });

    const fieldsRes = await client.query('SELECT * FROM envelope_fields WHERE envelope_id=$1 AND signer_id=$2', [env.id, signer.id]);
    const myFields = fieldsRes.rows;
    if (!myFields.length) return res.status(400).json({ error: 'No fields are assigned to you on this document' });

    const filesByName = {};
    for (const f of (req.files || [])) filesByName[f.fieldname] = f;
    const saved = await getSavedSignature(signer.email);
    let newSignature = null, newInitial = null; // track newly-drawn values, for saveForFuture below

    await client.query('BEGIN');
    for (const field of myFields) {
      if (field.field_type === 'signature' || field.field_type === 'initial') {
        const file = filesByName['image_' + field.id];
        let bytes, mime;
        if (file) {
          bytes = file.buffer; mime = file.mimetype;
          if (field.field_type === 'signature') newSignature = { bytes, mime }; else newInitial = { bytes, mime };
        } else if (req.body['useSaved_' + field.id] === 'true' && saved) {
          bytes = field.field_type === 'initial' ? saved.initial_bytes : saved.signature_bytes;
          mime = field.field_type === 'initial' ? saved.initial_mime : saved.signature_mime;
        }
        if (!bytes) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Please fill every ${field.field_type} field` }); }
        await client.query('UPDATE envelope_fields SET filled_image_bytes=$1, filled_image_mime=$2, filled_at=now() WHERE id=$3', [bytes, mime, field.id]);
      } else if (field.field_type === 'date' || field.field_type === 'title') {
        const text = (req.body['text_' + field.id] || '').trim();
        if (!text) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Please fill every ${field.field_type} field` }); }
        await client.query('UPDATE envelope_fields SET filled_text=$1, filled_at=now() WHERE id=$2', [text, field.id]);
      } else if (field.field_type === 'checkbox') {
        const boolVal = req.body['bool_' + field.id] === 'true';
        await client.query('UPDATE envelope_fields SET filled_bool=$1, filled_at=now() WHERE id=$2', [boolVal, field.id]);
      }
    }

    if (req.body.saveForFuture === 'true') {
      if (newSignature) upsertSavedSignature(signer.email, 'signature', newSignature.bytes, newSignature.mime).catch(e => console.error('save signature failed', e.message));
      if (newInitial) upsertSavedSignature(signer.email, 'initial', newInitial.bytes, newInitial.mime).catch(e => console.error('save initial failed', e.message));
    }

    await client.query(`UPDATE signers SET status='signed', signed_at=now(), method=$1 WHERE id=$2`, ['placed fields', signer.id]);
    await client.query('INSERT INTO audit_log (id, envelope_id, text) VALUES ($1,$2,$3)', [crypto.randomUUID(), env.id, `${signer.name} completed their fields.`]);

    const result = await finishSignerTurn(req, client, env, signer);
    res.json({ status: 'signed', allSigned: result.allSigned });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('field sign failed', err);
    res.status(500).json({ error: 'Could not record your fields' });
  } finally {
    client.release();
  }
});

module.exports = router;
