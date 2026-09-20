require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, ensureSchema } = require('./src/db');
const { sessionMiddleware, requireAuth } = require('./src/auth');
const portalRouter = require('./src/routes/portal');
const pagesRouter = require('./src/routes/pages');
const apiRouter = require('./src/routes/api');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.set('trust proxy', 1); // behind Traefik

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// Static assets: Toolkit AI's own portal assets, and Sealwright's, kept in
// separate folders/URL prefixes so a second app can be added later without
// any filename collisions between apps' CSS/JS.
app.use('/portal-assets', express.static(path.join(__dirname, 'public/portal')));
app.use('/sealwright', express.static(path.join(__dirname, 'public/sealwright')));

app.use(sessionMiddleware());
app.use(express.json());

// Sealwright's API lives under /sealwright/api/*. Envelope creation, listing,
// and deletion must come from a signed-in platform user, never a signer's
// magic-link token; everything else in api.js (signing, file/signature
// serving) does its own per-request access check since signers reach those
// routes without ever having a platform account at all.
app.use('/sealwright/api', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/envelopes') return requireAuth(req, res, next);
  if (req.method === 'GET' && req.path === '/envelopes') return requireAuth(req, res, next);
  if (req.method === 'DELETE' && /^\/envelopes\/[^/]+$/.test(req.path)) return requireAuth(req, res, next);
  next();
});
app.use('/sealwright/api', apiRouter);
app.use('/sealwright', pagesRouter);
app.use('/', portalRouter);

async function start() {
  try {
    await ensureSchema();
    console.log('Database schema ready.');
  } catch (err) {
    console.error('Failed to prepare database schema:', err.message || err.code || String(err));
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
  app.listen(PORT, HOST, () => {
    console.log(`Sealwright listening on ${HOST}:${PORT}`);
  });
}

start();
