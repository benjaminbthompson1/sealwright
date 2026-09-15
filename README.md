# Sealwright — production backend

Multi-party e-signature app. Node/Express + PostgreSQL.

## Environment variables

Required:
- `DATABASE_URL` — Postgres connection string (internal Dokploy network host, e.g. `postgres://user:pass@sealwright-db:5432/sealwright`)
- `SESSION_SECRET` — random long string, signs the session cookie
- `ADMIN_PASSWORD` — the password for the one sender/dashboard login
- `APP_BASE_URL` — the public URL of this app, e.g. `https://tkitai.com` (used to build the links inside emails)

Standard runtime:
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=8080`

Optional (email — without these, the app logs what it would have sent instead of failing):
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` — e.g. `Sealwright <no-reply@tkitai.com>`

Optional:
- `PGSSL=require` — only set this if your Postgres needs TLS; leave unset for a same-Docker-network Dokploy Postgres.

## What it does

- `/login`, `/` — session-protected sender dashboard: create envelopes, track signing progress
- `/sign/:token` — public, per-signer magic link (no login) — draw/type/upload a signature
- `/api/*` — REST API backing both of the above
- `/healthz` — checks DB connectivity, returns 200/503

The database schema is created automatically on boot (`CREATE TABLE IF NOT EXISTS`) — no separate migration step needed.

## Local dev

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/sealwright \
SESSION_SECRET=dev ADMIN_PASSWORD=dev \
PORT=8080 HOST=0.0.0.0 node server.js
```
