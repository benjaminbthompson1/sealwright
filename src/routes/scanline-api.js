const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { pool } = require('../db');
const { hashPassword, verifyPassword } = require('../auth');
const { buildScanPdf } = require('../scanline-pdf');
const scanlineOcr = require('../scanline-ocr');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 40 } });

// Unlike Sealwright's API, nothing under /scanline/api is ever reached by a
// public/unauthenticated party (no signer-style magic links here) — every
// route needs the same platform session, so it's simplest to gate the whole
// router in one place rather than list routes individually in server.js.
router.use((req, res, next) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

async function loadDocRow(id) {
  const r = await pool.query('SELECT * FROM scanline_documents WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function loadPageRows(documentId) {
  const r = await pool.query('SELECT * FROM scanline_document_pages WHERE document_id=$1', [documentId]);
  return r.rows;
}

// Orders a set of page rows (id-keyed) by a document's page_order array,
// dropping any id that no longer exists and appending any orphaned page
// that isn't in the order yet (belt-and-braces against a partial write).
function orderPages(pageOrder, pageRows) {
  const byId = new Map(pageRows.map(p => [p.id, p]));
  const ordered = pageOrder.map(id => byId.get(id)).filter(Boolean);
  const seen = new Set(ordered.map(p => p.id));
  for (const p of pageRows) if (!seen.has(p.id)) ordered.push(p);
  return ordered;
}

function isOwner(req, doc) {
  return !!doc && doc.owner_id === req.session.userId;
}
function isUnlocked(req, doc) {
  return !doc.password_hash || !!(req.session.scanlineUnlocked && req.session.scanlineUnlocked[doc.id]);
}
// For routes that touch document content (page bytes, PDF, OCR): owner AND,
// if the document is locked, unlocked earlier in this session.
async function requireContentAccess(req, res, id) {
  const doc = await loadDocRow(id);
  if (!doc) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!isOwner(req, doc)) { res.status(403).json({ error: 'Not authorized' }); return null; }
  if (!isUnlocked(req, doc)) { res.status(423).json({ error: 'This document is locked', locked: true }); return null; }
  return doc;
}

function docSummary(doc, pageCount) {
  return {
    id: doc.id, title: doc.title, page_count: pageCount,
    locked: !!doc.password_hash, created_at: doc.created_at, updated_at: doc.updated_at
  };
}

// ---------- create ----------
router.post('/documents', upload.array('pages', 40), async (req, res) => {
  const client = await pool.connect();
  try {
    const title = (req.body.title || '').trim() || 'Untitled scan';
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'At least one page is required' });

    await client.query('BEGIN');
    const documentId = crypto.randomUUID();
    const pageIds = files.map(() => crypto.randomUUID());
    // The parent row must exist before any child page row can reference it
    // via the document_id foreign key, so insert scanline_documents first —
    // page_order can hold these ids right away since it's a plain UUID[]
    // column, not itself a foreign key.
    await client.query(
      'INSERT INTO scanline_documents (id, owner_id, title, page_order) VALUES ($1,$2,$3,$4)',
      [documentId, req.session.userId, title, pageIds]
    );
    for (let i = 0; i < files.length; i++) {
      await client.query(
        'INSERT INTO scanline_document_pages (id, document_id, mime_type, image_bytes) VALUES ($1,$2,$3,$4)',
        [pageIds[i], documentId, files[i].mimetype || 'image/jpeg', files[i].buffer]
      );
    }
    await client.query('COMMIT');
    res.json({ id: documentId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('create scan document failed', err);
    res.status(500).json({ error: 'Could not save the scan' });
  } finally {
    client.release();
  }
});

// ---------- list (owner only) ----------
router.get('/documents', async (req, res) => {
  const docs = await pool.query(
    `SELECT d.*, cardinality(d.page_order) AS page_count
     FROM scanline_documents d WHERE d.owner_id=$1 ORDER BY d.updated_at DESC`,
    [req.session.userId]
  );
  res.json(docs.rows.map(d => docSummary(d, d.page_count)));
});

// ---------- detail ----------
// Metadata is visible to the owner even while locked (so it still shows up
// in the list with a lock icon); OCR text, summary, and the page thumbnails
// themselves are withheld until unlocked.
router.get('/documents/:id', async (req, res) => {
  const doc = await loadDocRow(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!isOwner(req, doc)) return res.status(403).json({ error: 'Not authorized' });
  const unlocked = isUnlocked(req, doc);
  const out = {
    ...docSummary(doc, doc.page_order.length),
    page_ids: unlocked ? doc.page_order : [],
    ocr_text: unlocked ? doc.ocr_text : null,
    ocr_generated_at: unlocked ? doc.ocr_generated_at : null,
    summary_text: unlocked ? doc.summary_text : null,
    summary_generated_at: unlocked ? doc.summary_generated_at : null
  };
  res.json(out);
});

// ---------- rename / reorder ----------
router.patch('/documents/:id', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const sets = [], vals = []; let i = 1;
  if (typeof req.body.title === 'string') {
    const title = req.body.title.trim() || 'Untitled scan';
    sets.push(`title=$${i++}`); vals.push(title);
  }
  if (Array.isArray(req.body.page_order)) {
    const rows = await loadPageRows(doc.id);
    const validIds = new Set(rows.map(r => r.id));
    const cleanOrder = req.body.page_order.filter(id => validIds.has(id));
    if (cleanOrder.length !== rows.length) return res.status(400).json({ error: 'page_order must list every existing page exactly once' });
    sets.push(`page_order=$${i++}`); vals.push(cleanOrder);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at=now()`);
  vals.push(doc.id);
  await pool.query(`UPDATE scanline_documents SET ${sets.join(', ')} WHERE id=$${i}`, vals);
  res.json({ updated: true });
});

// ---------- delete document ----------
router.delete('/documents/:id', async (req, res) => {
  const doc = await loadDocRow(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!isOwner(req, doc)) return res.status(403).json({ error: 'Not authorized' });
  // ON DELETE CASCADE on scanline_document_pages removes every stored page
  // image along with the document row in one statement.
  await pool.query('DELETE FROM scanline_documents WHERE id=$1', [doc.id]);
  res.json({ deleted: true });
});

// ---------- add pages ----------
router.post('/documents/:id/pages', upload.array('pages', 40), async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No pages provided' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const newIds = [];
    for (const f of files) {
      const pageId = crypto.randomUUID();
      await client.query(
        'INSERT INTO scanline_document_pages (id, document_id, mime_type, image_bytes) VALUES ($1,$2,$3,$4)',
        [pageId, doc.id, f.mimetype || 'image/jpeg', f.buffer]
      );
      newIds.push(pageId);
    }
    const newOrder = [...doc.page_order, ...newIds];
    await client.query('UPDATE scanline_documents SET page_order=$1, updated_at=now() WHERE id=$2', [newOrder, doc.id]);
    await client.query('COMMIT');
    res.json({ added: newIds.length, page_order: newOrder });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('add scan pages failed', err);
    res.status(500).json({ error: 'Could not add pages' });
  } finally {
    client.release();
  }
});

// ---------- replace one page's image (retake / annotate / page-numbers) ----------
router.put('/documents/:id/pages/:pageId', upload.single('page'), async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  if (!doc.page_order.includes(req.params.pageId)) return res.status(404).json({ error: 'Page not found on this document' });
  if (!req.file) return res.status(400).json({ error: 'No image provided' });
  await pool.query('UPDATE scanline_document_pages SET mime_type=$1, image_bytes=$2 WHERE id=$3', [req.file.mimetype || 'image/jpeg', req.file.buffer, req.params.pageId]);
  await pool.query('UPDATE scanline_documents SET updated_at=now() WHERE id=$1', [doc.id]);
  res.json({ updated: true });
});

// ---------- delete one page ----------
router.delete('/documents/:id/pages/:pageId', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const newOrder = doc.page_order.filter(id => id !== req.params.pageId);
  await pool.query('DELETE FROM scanline_document_pages WHERE id=$1 AND document_id=$2', [req.params.pageId, doc.id]);
  await pool.query('UPDATE scanline_documents SET page_order=$1, updated_at=now() WHERE id=$2', [newOrder, doc.id]);
  res.json({ deleted: true, page_order: newOrder });
});

// ---------- thumbnail (first page) — lets the list screen show a cover
// image per document without the client needing to know page ids ----------
router.get('/documents/:id/thumbnail', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const firstId = doc.page_order[0];
  if (!firstId) return res.status(404).end();
  const r = await pool.query('SELECT mime_type, image_bytes FROM scanline_document_pages WHERE id=$1 AND document_id=$2', [firstId, doc.id]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime_type);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(r.rows[0].image_bytes);
});

// ---------- serve a page image ----------
router.get('/documents/:id/pages/:pageId', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const r = await pool.query('SELECT mime_type, image_bytes FROM scanline_document_pages WHERE id=$1 AND document_id=$2', [req.params.pageId, doc.id]);
  if (!r.rows[0]) return res.status(404).end();
  res.setHeader('Content-Type', r.rows[0].mime_type);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(r.rows[0].image_bytes);
});

// ---------- download assembled PDF ----------
router.get('/documents/:id/download', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  const rows = await loadPageRows(doc.id);
  const pages = orderPages(doc.page_order, rows);
  try {
    const { bytes } = await buildScanPdf(doc, pages);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${doc.title.replace(/[^a-z0-9\-_ ]/gi, '')}.pdf"`);
    res.send(bytes);
  } catch (err) {
    console.error('scan pdf assembly failed', err);
    res.status(500).json({ error: 'Could not build the PDF' });
  }
});

// ---------- lock / unlock ----------
// A document password is a second layer on top of account login (useful on
// a shared device) — it is NOT how exported PDFs are protected; the download
// route above still needs the account session AND an unlocked document.
router.post('/documents/:id/lock', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id); // must already be unlocked (or unlocked-by-default) to set/replace a password
  if (!doc) return;
  const password = req.body.password || '';
  if (password.length < 4) return res.status(400).json({ error: 'Use at least 4 characters' });
  await pool.query('UPDATE scanline_documents SET password_hash=$1, updated_at=now() WHERE id=$2', [hashPassword(password), doc.id]);
  if (!req.session.scanlineUnlocked) req.session.scanlineUnlocked = {};
  req.session.scanlineUnlocked[doc.id] = true;
  res.json({ locked: true });
});

router.post('/documents/:id/unlock', async (req, res) => {
  const doc = await loadDocRow(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (!isOwner(req, doc)) return res.status(403).json({ error: 'Not authorized' });
  if (!doc.password_hash) return res.json({ unlocked: true }); // nothing to unlock
  if (!verifyPassword(req.body.password || '', doc.password_hash)) return res.status(401).json({ error: 'Incorrect password' });
  if (!req.session.scanlineUnlocked) req.session.scanlineUnlocked = {};
  req.session.scanlineUnlocked[doc.id] = true;
  res.json({ unlocked: true });
});

router.post('/documents/:id/remove-lock', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  await pool.query('UPDATE scanline_documents SET password_hash=NULL, updated_at=now() WHERE id=$1', [doc.id]);
  res.json({ locked: false });
});

// ---------- OCR / summarize ----------
router.post('/documents/:id/ocr', async (req, res) => {
  const doc = await requireContentAccess(req, res, req.params.id);
  if (!doc) return;
  if (!scanlineOcr.isConfigured()) return res.status(503).json({ error: 'AI features are not configured on this server' });
  const kind = req.body.kind === 'summary' ? 'summary' : 'text';
  const rows = await loadPageRows(doc.id);
  const pages = orderPages(doc.page_order, rows);
  if (!pages.length) return res.status(400).json({ error: 'This document has no pages' });

  const result = kind === 'summary' ? await scanlineOcr.summarize(pages) : await scanlineOcr.extractText(pages);
  if (!result.ok) {
    const status = result.reason === 'not-configured' ? 503 : 502;
    return res.status(status).json({ error: 'Could not complete that request. Please try again.' });
  }
  const column = kind === 'summary' ? 'summary_text' : 'ocr_text';
  const tsColumn = kind === 'summary' ? 'summary_generated_at' : 'ocr_generated_at';
  await pool.query(`UPDATE scanline_documents SET ${column}=$1, ${tsColumn}=now() WHERE id=$2`, [result.text, doc.id]);
  res.json({ text: result.text, truncated: !!result.truncatedPages });
});

module.exports = router;
