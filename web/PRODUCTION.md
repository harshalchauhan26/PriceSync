# Production Readiness — MBO Tracker (Node)

The live app is the Node/Express + React stack under `web/`, backed by Supabase
Postgres (Mumbai, `ap-south-1`), deployed on Render (Singapore). Single process —
run **one** instance (pipeline state, rate limits, and the live log are in memory).

## Required environment variables (Render → Environment)

| Var | Required | Notes |
|-----|----------|-------|
| `SUPABASE_DB_URL` | ✅ | Mumbai Session-pooler URI. App exits on boot if missing. |
| `SECRET_KEY` | ✅ | Long random hex (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Signs session cookies + encrypts the Shopify token — **must match across redeploys** or the saved token won't decrypt. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | Seeds the first owner on an empty DB. Use a strong password. |
| `SMTP_*`, `ALERT_TO` | optional | Mismatch email reports. |
| `MAX_CONCURRENT_RUNS` | optional | Default 3. |
| `NODE_PORT` | leave unset on Render | Render injects `PORT`; unset `NODE_PORT` → binds `0.0.0.0` + secure cookies. |

## Security checklist

- [x] **Supabase RLS enabled** on all public tables (anon key can no longer read/write; the app's `postgres` role bypasses RLS so it keeps working). Re-run on the `session` table after first boot if you expose the API schema (low risk).
- [x] Secrets only in `.env` (gitignored) / Render env — none committed.
- [x] Baseline security headers (nosniff, frame, referrer) + `x-powered-by` disabled.
- [x] Login rate-limited (5 fails / 10 min per IP); writes require an admin/owner role.
- [ ] **Rotate the admin password** — the dev value (`harshal123`) is weak. Changing `ADMIN_PASSWORD` does NOT update an existing owner; rotate the owner's password in-app (or ask me to update the `users` row). **Do this before going wide.**
- [ ] **Confirm Shopify `dry_run`** — currently **LIVE** (`dry_run=0`). Pushes write real prices. Verify in Integrations before bulk approve/push.

## Stability (built in)

- Graceful shutdown on `SIGTERM`/`SIGINT` (drains the PG pool; 10s hard cap) — clean Render redeploys.
- Global `unhandledRejection` / `uncaughtException` logging so a stray async error doesn't silently kill the process.
- All route handlers wrapped; the pipeline has its own try/catch.

## Deploy

1. Build command: `cd web/client && npm ci && npm run build && cd ../server && npm ci`
2. Start command: `cd web/server && npm start`
3. Health check path: `/api/health` (returns `{ ok: true }`).

## Post-deploy verification

- `/api/health` → `{ ok: true }`.
- Log in; product counts match (6,014 Shopify products).
- Review: a delete/approve feels instant (optimistic UI) and pushes the **USD** price (CAD for configured brands), rounded by the price rule.
- After any change to `engine.js` / `*.js`, **restart the service** — the engine is loaded into memory at boot.
