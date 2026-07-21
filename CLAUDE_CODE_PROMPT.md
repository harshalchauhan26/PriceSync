# Paste this into Claude Code (run from the project root)

You are working on the MBO Tracker — a live Node/Express + React + Supabase price-sync app under `web/`. It pushes REAL prices to a LIVE Shopify store (`dry_run=0`), tracks ~6,000 products, and has in-memory pipeline/session state (single instance only). Treat every change as production-impacting. Read `AUDIT_2026-07-21.md` in the repo root first — it explains the architecture and the findings you are acting on.

## Already done for you (build on this — do NOT redo)

A branch `hardening-2026-07-21` already exists with commit `99630a6`. It contains offline, tested work you should continue from (`git checkout hardening-2026-07-21`). Already implemented and passing `npm test` (16/16):
- **Security:** closed open self-registration + Google auto-signup behind an allowlist (`ALLOWED_SIGNUP_DOMAINS`, default closed) in `server.js`/`security.js`/`config.js`; fixed the `X-Forwarded-For` rate-limit bypass in `ipOf`; added `SEED_OWNER_RESET_PASSWORD=1` path in `seedOwner` for a clean owner-password rotation.
- **Production:** `wrap()` no longer leaks `e.message` (generic 500 + server-side log with request id); wired `MAX_UPLOAD_MB` into multer; added lightweight request logging.
- **Tests:** `web/server/test/price.test.mjs` — unit tests for the pure price functions incl. the three documented incident cases (1.2M itemprop not descaled, embedded-JSON cents descaled, sale/compare_at highest).
- **Tooling:** `web/server/tools/verify-prices.mjs` — read-only price reconciliation report (run `npm run verify-prices`).
- **Schema (additive only):** `products.verified_dead_at` + `dead_fail_count`, plus `store.markVerifiedDead()` / `clearVerifiedDead()` / `isPermanentError()` — the void marker for Phase 2. NOT yet wired into the pipeline hot path; that's your job (see Phase 2.3).

So Phase 3's error-leak/upload/logging and most of Phase 4's code changes are DONE. Your remaining focus: the live full run (Phase 1), the recheck + wiring the void marker (Phase 2), running the tests/verify against real data, and the live-secret/dry-run decisions (Phase 4 items 1–4 execution). Confirm the existing changes look right, then proceed.

Global rules:
- Continue on the existing branch `hardening-2026-07-21` (don't create a new one). Commit after each numbered phase with a clear message.
- NEVER delete product/price rows. "Void" a link only by leaving it in state `error` — never `DELETE`.
- Before ANY pipeline run in this task, force Shopify to safe mode: set the integration `dry_run=1` (Integrations, or `UPDATE integrations SET dry_run=1 WHERE brand='__store__';`) and confirm with `/api/integration/verify` that it reports `DRY-RUN`. Do not approve/push to Shopify unless I explicitly tell you to.
- Take a Supabase backup / snapshot of the `products`, `price_history` and `review_history` tables before the full run.
- After editing any `web/server/src/*.js`, restart the server (the engine is loaded into memory at boot).
- Show me a diff and a short summary at the end of each phase; pause for my OK before Phase 4 (security remediation that changes live behavior).

---

## Phase 1 — Full link/price test across all products, then verify correctness

1. Confirm dry-run is ON (above). Confirm DB connectivity (`/api/health`, `db.ping`).
2. Run the full pipeline over the **database** source, fresh start, with safe-retry ON so broken links get the gentle second pass automatically. Use the existing engine — either via the UI (`/api/pipe/start` with `fresh_start:true, retry_errors handled by safe_retry:true`) or a small script that calls `startPipeline`. Let it complete both the main pass and the safe-retry pass. Capture the final `state` counts (matched / mismatch / error).
3. After it finishes, write a **read-only** verification script `web/server/tools/verify-prices.mjs` (new folder `tools/`, do not touch existing `_*.mjs`). It must query `products` (and `price_history` for trend) and produce a report — printed and written to `PriceVerify_<date>.xlsx` — flagging every row that looks wrong WITHOUT changing any data:
   - **Suspicious ratio** between `live_price` (converted to INR via the same `fx.toInr`) and `base_price`: flag ratios ≈100×, ≈0.01×, ≈2×, ≈0.5× (the cents-descale and pre-sale/sale failure signatures). Tolerance ±3%.
   - **Currency anomaly:** detected `currency` ≠ the brand's expected currency (cross-check `native_currency_brands`, `fetch_usd_brands`; a `.in` domain returning USD; UNKNOWN currency on a matched row).
   - **Error clustering:** brands whose error rate > 40% of their rows (signals a systemic block/regex break, not dead products), and split each error by cause using the `Fetch Error (<detail>)` suffix into transient (timeout / HTTP 403 / 429 / 5xx / redirected) vs. permanent (404 / removed / price not found / baseline unreadable).
   - **Stale rows:** `updated_at` older than this run (didn't get fetched — e.g. skipped local-only brands).
4. Give me the report plus a plain-English summary: how many prices look trustworthy, how many need a re-fetch, how many are genuinely dead products.

## Phase 2 — Re-check non-working links before deeming them void

1. From the Phase 1 report, take the **transient** error rows only (timeout / 403 / 429 / 5xx / redirected-off-product). Do NOT include confirmed 404/removed.
2. Re-fetch just those rows using the existing gentle path (`pipe.rerunOne` per row, or a scoped safe pass — concurrency 1, long cooldowns). For brands that are flagged local-only or IP-banned, note that they can only be refreshed from a local run / relay, and list them rather than marking them void.
3. Add a small, reversible improvement to the engine so this is repeatable: introduce an explicit, human-set `void` marker (e.g. a `verified_dead_at` timestamp column, nullable) that is ONLY set when a link has failed as permanent (404/removed) across at least two separate runs. The pipeline and Review must keep showing these as errors; `void` is just a label so we stop re-fetching known-dead URLs. Never auto-populate it from a single failure. Migration must be additive (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
4. Report the before/after: how many "broken" links recovered on recheck, how many remain, how many are confirmed dead.

## Phase 3 — Debug & production hardening

1. Add a unit-test setup (node:test or vitest) under `web/server/test/` covering the pure price functions: `sanitizePrice`, `descaleIfCents`, `detectCurrency`, `redirectedOffProduct`, `shopifyNum`, `roundFinal`, `computeFinal`, `matchTol`, `toInr`. Include the known incident cases from the code comments (the ₹1.2M couture price that must NOT be halved; sale-vs-compare_at price; geo-mislabeled currency). Make them pass; fix any genuine bug they expose.
2. Stop leaking internals: in `wrap()` (server.js), log the full error server-side but return a generic `{ ok:false, error:"internal error" }` (keep validation 400s specific).
3. Wire `MAX_UPLOAD_MB` into the multer limit and lower the default to a realistic value; keep `express.json` at 2 MB.
4. Add lightweight request logging with a request id (morgan or a tiny middleware) so production incidents are traceable. Keep it quiet for `/api/health`.
5. Re-verify the built-in stability guarantees still hold after your edits: graceful shutdown, both global error handlers, health check. Restart and confirm `/api/health` → `{ ok:true }`.
6. User-handling polish: make sure every write route returns a clear, non-technical error for the common failures (no URL, bad price, not logged in, wrong role, push already running) — audit the routes and fix any that dump raw messages.

## Phase 4 — Security remediation (PAUSE for my OK before running the live-behavior changes)

1. **Close open registration / read-all.** Either (a) gate `/api/register` and Google sign-in behind an email allowlist (env `ALLOWED_SIGNUP_DOMAINS` / explicit invite), or (b) disable self-registration and require the owner to create users. Also decide whether `viewer` should be able to read pricing at all — if not, add read-gating to sensitive GET routes. Implement the option I choose; default to (b) if I don't answer.
2. **Rotate the admin/owner password.** Since `seedOwner` won't update an existing owner, either update the `users` row directly with a fresh bcrypt hash of a strong password I provide, or add an owner-console "reset password" action. Also make `seedOwner` optionally update the owner password when an env flag is set, so future rotations are clean.
3. **Fix the rate-limit bypass.** In `ipOf`, stop trusting the left-most `X-Forwarded-For`; with `trust proxy=1`, key the limiter on `req.ip` (or the right-most hop).
4. **Confirm the Shopify dry-run decision with me** before restoring `dry_run=0`. Leave it in dry-run until I explicitly say go live.
5. Quick pass for anything else: ensure `.env` stays untracked, `SECRET_KEY` is a strong hex and unchanged (changing it breaks the encrypted Shopify token and all sessions), and the session table RLS note in PRODUCTION.md is addressed.

## Wrap-up
Summarize per phase: what you found, what you changed, what still needs a human decision (esp. going back to live Shopify pushes and the registration policy). List every file changed and every DB migration applied. Do not merge the branch or re-enable live pushes without my explicit confirmation.
