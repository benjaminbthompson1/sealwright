const crypto = require('crypto');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { pool } = require('./db');

function sessionMiddleware() {
  return session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    name: 'sealwright.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 12 // 12 hours
    }
  });
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal length to avoid leaking length via timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeEqualStr(candidate || '', expected);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  // req.path is rewritten relative to the mount point inside app.use('/api', ...),
  // so check the untouched original URL to tell an API call from a page request.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

module.exports = { sessionMiddleware, checkPassword, requireAuth };
