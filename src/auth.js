const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');

function sessionMiddleware() {
  return session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'toolkitai.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
    }
  });
}

// ---------- password hashing (scrypt — built into Node, no native module to
// compile, which matters on the Alpine build image) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const hashBuffer = Buffer.from(hash, 'hex');
    const suppliedBuffer = crypto.scryptSync(password, salt, 64);
    if (hashBuffer.length !== suppliedBuffer.length) return false;
    return crypto.timingSafeEqual(hashBuffer, suppliedBuffer);
  } catch (e) {
    return false;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// ---------- user account helpers ----------
async function findUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email).trim().toLowerCase()]);
  return r.rows[0] || null;
}

async function findUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function countUsers() {
  const r = await pool.query('SELECT count(*)::int AS n FROM users');
  return r.rows[0].n;
}

async function createUser(email, password, { firstName, lastName, phone } = {}) {
  const id = crypto.randomUUID();
  const normalizedEmail = String(email).trim().toLowerCase();
  const passwordHash = hashPassword(password);
  await pool.query(
    'INSERT INTO users (id, email, password_hash, first_name, last_name, phone) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, normalizedEmail, passwordHash, firstName || null, lastName || null, phone || null]
  );
  return { id, email: normalizedEmail };
}

async function setResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
  await pool.query('UPDATE users SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, userId]);
  return token;
}

async function findUserByValidResetToken(token) {
  const r = await pool.query('SELECT * FROM users WHERE reset_token=$1 AND reset_token_expires > now()', [token]);
  return r.rows[0] || null;
}

async function resetPassword(userId, newPassword) {
  const passwordHash = hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2', [passwordHash, userId]);
}

// ---------- one-time migration: envelopes created before accounts existed had
// no owner. Rather than leave them orphaned forever, the very first account
// ever created inherits them — there is no ambiguity about whose they were,
// since nothing had multiple users before this feature existed. ----------
async function claimOrphanedEnvelopes(userId) {
  await pool.query('UPDATE envelopes SET owner_id=$1 WHERE owner_id IS NULL', [userId]);
}

// ---------- admin ----------
// Runs on every boot; a no-op once an admin already exists. Promotes the
// earliest-created account rather than requiring anyone to flip a flag by
// hand — this is what retroactively makes an already-existing account (like
// one created before this feature existed) the admin with zero extra steps.
async function ensureFirstAdmin() {
  const existing = await pool.query('SELECT 1 FROM users WHERE is_admin=true LIMIT 1');
  if (existing.rows.length) return;
  await pool.query(`
    UPDATE users SET is_admin=true
    WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  `);
}

async function listAllUsers() {
  const r = await pool.query(`
    SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.is_admin, u.created_at,
           (SELECT count(*)::int FROM envelopes e WHERE e.owner_id = u.id) AS envelope_count
    FROM users u
    ORDER BY u.created_at ASC
  `);
  return r.rows;
}

async function deleteUser(id) {
  // Cascades to that user's envelopes (and, through those, signers/pages/audit
  // log) via the existing foreign-key ON DELETE CASCADE chain — no separate
  // cleanup needed here.
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  // req.path is rewritten relative to the mount point inside app.use('/sealwright', ...),
  // so check the untouched original URL to tell an API call from a page request.
  if (req.originalUrl.includes('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

// Always re-checks is_admin fresh from the database rather than trusting a
// session flag, since this gates a genuinely sensitive area (every user's
// data, and account deletion).
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const user = await findUserById(req.session.userId);
  if (!user || !user.is_admin) return res.status(403).send('Not authorized.');
  req.adminUser = user;
  next();
}

module.exports = {
  sessionMiddleware, requireAuth, requireAdmin, isValidEmail,
  hashPassword, verifyPassword,
  findUserByEmail, findUserById, countUsers, createUser,
  setResetToken, findUserByValidResetToken, resetPassword,
  claimOrphanedEnvelopes, ensureFirstAdmin, listAllUsers, deleteUser
};
