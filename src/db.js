const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
});

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id UUID NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  image_bytes BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS signers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

module.exports = { pool, ensureSchema };
