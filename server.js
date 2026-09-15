require('dotenv').config();
const express = require('express');
const path = require('path');
const { pool, ensureSchema } = require('./src/db');
const { sessionMiddleware, requireAuth } = require('./src/auth');
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(sessionMiddleware());
app.use(express.json());

app.use('/api', (req, res, next) => {
  // dashboard-only writes require a session; envelope creation is the one write route
  // that must come from the authenticated sender.
  if (req.method === 'POST' && req.path === '/envelopes') return requireAuth(req, res, next);
  if (req.method === 'GET' && req.path === '/envelopes') return requireAuth(req, res, next);
  next();
});
app.use('/api', apiRouter);
app.use('/', pagesRouter);

async function start() {
  try {
    await ensureSchema();
    console.log('Database schema ready.');
  } catch (err) {
    console.error('Failed to prepare database schema:', err.message);
    process.exit(1);
  }
  app.listen(PORT, HOST, () => {
    console.log(`Sealwright listening on ${HOST}:${PORT}`);
  });
}

start();
