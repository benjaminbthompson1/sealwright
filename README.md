# Toolkit AI — production backend

A small multi-app platform. Currently one app: Sealwright, a multi-party e-signature tool. Node/Express + PostgreSQL.

## Environment variables

Required:
- `DATABASE_URL` — Postgres connection string (internal Dokploy network host, e.g. `postgres://user:pass@sealwright-db:5432/sealwright`)
- `SESSION_SECRET` — random long string, signs the session cookie
- `APP_BASE_URL` — the public URL of this app, e.g. `https://tkitai.com` (used to build links inside emails)

Standard runtime:
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=8080`

Optional (email — without these, the app logs what it would have sent instead of failing):
- `SMTP_PASS` — actually your Resend API key (name kept for continuity with earlier setup)
- `SMTP_FROM` — e.g. `Sealwright <sealwright@tkitai.com>`

Optional:
- `PGSSL=require` — only set this if your Postgres needs TLS; leave unset for a same-Docker-network Dokploy Postgres.
- `PGSCHEMA` — defaults to `sealwright`; only needed if the provisioned schema is named differently.

Note: `ADMIN_PASSWORD` from earlier versions is no longer used — real per-user accounts (signup/login) replaced the single shared password.

## Structure

- `/` — Toolkit AI landing page. Logged out: hero + signup/login. Logged in: a tile per app (currently just Sealwright).
- `/signup`, `/login`, `/logout`, `/forgot-password`, `/reset-password/:token` — platform-wide account pages.
- `/sealwright/` — the Sealwright dashboard (requires login). Each user only ever sees their own envelopes.
- `/sealwright/sign/:token` — public, per-signer magic link (no login) — draw/type/upload a signature.
- `/sealwright/api/*` — REST API backing the dashboard and signing page.
- `/healthz` — checks DB connectivity, returns 200/503.

The database schema (including the `users` table and the `owner_id` column on `envelopes`) is created/updated automatically on boot — no separate migration step. Any envelope that existed before multi-user accounts were added is automatically claimed by the very first account created afterward.

## Local dev

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/sealwright \
SESSION_SECRET=dev \
PORT=8080 HOST=0.0.0.0 node server.js
```
