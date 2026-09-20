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

async function createUser(email, password) {
  const id = crypto.randomUUID();
  const normalizedEmail = String(email).trim().toLowerCase();
  const passwordHash = hashPassword(password);
  await pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1,$2,$3)', [id, normalizedEmail, passwordHash]);
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

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  // req.path is rewritten relative to the mount point inside app.use('/sealwright', ...),
  // so check the untouched original URL to tell an API call from a page request.
  if (req.originalUrl.includes('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

module.exports = {
  sessionMiddleware, requireAuth, isValidEmail,
  hashPassword, verifyPassword,
  findUserByEmail, findUserById, countUsers, createUser,
  setResetToken, findUserByValidResetToken, resetPassword,
  claimOrphanedEnvelopes
};
