// ============================================================
// Sealwright no longer owns accounts. Sign-in, sign-up, profile, password
// reset and the admin area all live in the Toolkit AI platform service.
// This file only (1) reads the shared session the platform creates, and
// (2) looks up a platform user's display info by id (read-only).
//
// THE SESSION BLOCK MUST MATCH THE PLATFORM'S src/auth.js sessionMiddleware()
// in: SESSION_SECRET, cookie name, session table location, cookie path.
// Same contract as the Scanline service's src/session.js.
// ============================================================
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const PLATFORM_SCHEMA = process.env.PLATFORM_SCHEMA || 'platform';
if (!/^[a-z_][a-z0-9_]*$/i.test(PLATFORM_SCHEMA)) {
  throw new Error('PLATFORM_SCHEMA must be a plain identifier');
}

// Separate pool pointed at the PLATFORM schema: used for the session store
// and for read-only user lookups. db.js's pool stays on Sealwright's schema.
const platformPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${PLATFORM_SCHEMA},public`
});

function sessionMiddleware() {
  return session({
    store: new pgSession({
      pool: platformPool,
      schemaName: PLATFORM_SCHEMA,
      tableName: 'session',
      createTableIfMissing: false // the platform owns this table
    }),
    name: process.env.SESSION_COOKIE_NAME || 'tkai_session',
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30
    }
  });
}

// Schema-qualified on purpose. During the migration window sealwright.users
// still exists (kept for rollback); an unqualified "users" would silently
// read that stale copy because Sealwright's search_path puts its own schema first.
async function findUserById(id) {
  if (!id) return null;
  const r = await platformPool.query(
    `SELECT id, email, first_name, last_name, phone, is_admin FROM "${PLATFORM_SCHEMA}".users WHERE id=$1`,
    [id]
  );
  return r.rows[0] || null;
}

function loginUrl(nextPath) {
  const base = process.env.PLATFORM_LOGIN_URL || '/login';
  return `${base}?next=${encodeURIComponent(nextPath)}`;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.originalUrl.includes('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect(loginUrl(req.originalUrl));
}

module.exports = { sessionMiddleware, requireAuth, findUserById, platformPool };
