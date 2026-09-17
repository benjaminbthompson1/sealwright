const { Pool } = require('pg');

// The operator provisions this app into its own schema inside a shared database
// (rather than its own database) — default matches what was given to us, but stays
// overridable via env in case that ever changes.
const SCHEMA_NAME = process.env.PGSCHEMA || 'sealwright';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  // Every connection in the pool gets this schema first on its search_path, so
  // unqualified table names below land in the right place instead of "public".
  options: `-c search_path=${SCHEMA_NAME},public`
});

// Note: we deliberately do NOT run "CREATE SCHEMA IF NOT EXISTS" here. The operator
// provisions the schema up front as part of setting up this app's dedicated role, and
// a scoped-down role typically lacks database-level CREATE privilege — so this
// statement would fail with "permission denied for database" even when the schema
// already exists, because Postgres checks the privilege before checking existence.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS envelopes (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'pdf' | 'docx' | 'image'
  file_name TEXT NOT NULL,
  mime_type TEXT,
  original_bytes BYTEA,
  plain_text TEXT,
  sequential BOOLEAN NOT NULL DEFAULT true,
  current_turn_index INTEGER NOT NULL DEFAULT 1, -- 1-based, matches signers.order_index
  status TEXT NOT NULL DEFAULT 'sent', -- 'sent' | 'completed'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  final_pdf_bytes BYTEA,
  fingerprint TEXT
);

CREATE TABLE IF NOT EXISTS envelope_pages (
  id UUID PRIMARY KEY,
  envelope_id UUID NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  image_bytes BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS signers (
  id UUID PRIMARY KEY,
  envelope_id UUID NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'signed'
  signed_at TIMESTAMPTZ,
  signature_bytes BYTEA,
  signature_mime TEXT,
  method TEXT,
  sign_token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY,
  envelope_id UUID NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  text TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signers_envelope ON signers(envelope_id);
CREATE INDEX IF NOT EXISTS idx_pages_envelope ON envelope_pages(envelope_id);
CREATE INDEX IF NOT EXISTS idx_audit_envelope ON audit_log(envelope_id);
CREATE INDEX IF NOT EXISTS idx_signers_token ON signers(sign_token);
`;

async function ensureSchema() {
  await pool.query(SCHEMA);
}

module.exports = { pool, ensureSchema, SCHEMA_NAME };
