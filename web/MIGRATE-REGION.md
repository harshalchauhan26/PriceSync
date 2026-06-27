# Migrate to Singapore (co-locate server + DB near Asian users)

**Why:** users are in India/Asia, but today the Render service is in **Virginia
(US-East)** and the Supabase DB is in **Sydney (ap-southeast-2)** — so every click
crosses the planet twice. The fix is to put **both** the server and the database
in **Singapore (`ap-southeast-1`)**:

| Hop | Now | After |
|-----|-----|-------|
| browser (India) → server | ~230 ms (Virginia) | ~60 ms (Singapore) |
| server → DB (×N per click) | ~230 ms (VA→Sydney) | ~1–5 ms (same region) |

Neither Render nor Supabase lets you move an existing service/project between
regions, so we create new ones in Singapore and copy the data over.

---

## 1. New Supabase project in Singapore

1. Supabase dashboard → **New project**.
2. Region: **Southeast Asia (Singapore)** → `ap-southeast-1`.
3. Set + note the DB password.
4. Project Settings → Database → Connection string → URI → copy the
   **Session pooler** URI. It looks like:
   `postgresql://postgres.<newref>:<pw>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`

## 2. Copy the data (no external tools)

Use the bundled `web/server/migrate-region.mjs` — it creates the schema on the new
project and copies every table (users, products, catalog, price + review history,
integrations, meta) via the `pg` library. Idempotent (`ON CONFLICT DO NOTHING`),
safe to re-run. The Express session table is skipped (users just log in again).

From `web/server` (PowerShell):

```powershell
$env:NEW_DB_URL="postgresql://postgres.NEWREF:PW@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"
node migrate-region.mjs
```

`OLD_DB_URL` defaults to `SUPABASE_DB_URL` from the repo `.env`, so you only set
`NEW_DB_URL`. Watch the output — it prints rows read → inserted per table.

> Prefer a clean start? Skip this step: the app auto-creates its tables on boot.
> Just point the new Render service (below) at the new URL, let it boot, then
> re-import the sheet and re-add the Shopify token + users in the UI. You lose
> Alerts/approval history, but products come back in ~42 s.

## 3. New Render service in Singapore

Render fixes a service's region at creation, so create a fresh one:

1. Render → **New → Web Service** → connect the same repo.
2. **Region: Singapore.**
3. Copy the **build & start commands** and **all environment variables** from the
   current service (Render → old service → Environment → reveal/copy each).
4. Set `SUPABASE_DB_URL` to the **new Singapore** pooler URI from step 1.
5. Deploy. This new build also includes the query-parallelization + optimistic-UI
   changes from this session.

## 4. Cut over

1. Verify the new Singapore service: `/api/health` → `{ ok: true }`, login works,
   product counts match, Review clicks feel instant.
2. Move your custom domain (if any) from the old service to the new one
   (Render → new service → Settings → Custom Domains), or just start using the new
   `*.onrender.com` URL.
3. Suspend/delete the **old Virginia service** and the **old Sydney Supabase
   project** once you're happy (stops double billing).

---

### Don't want to move Render? (half fix)

Keep the Sydney DB and only nothing-changes on Render → still ~230 ms. Or move just
the DB to Singapore and leave Render in Virginia → server→DB becomes Virginia→
Singapore (~210 ms), no real gain. The win needs **both** ends in Singapore. The
cheapest partial win is moving only Render to Singapore while the DB stays in
Sydney (~90 ms server→DB) — better, but not the ~2 ms of true co-location.
