# PriceSync — Deployment Guide

One app that imports a tracker sheet, verifies live prices, lets you approve
price changes (markup / custom), pushes them to each brand's Shopify store, and
alerts you to price drops/spikes between runs. **Supabase (Postgres) is the
permanent source of truth** — nothing accumulates on the local disk, and the
data survives restarts and moves between machines.

The **list of links to check always comes from the uploaded sheet** on every
run (`store.work_rows`), never from the database. The DB is permanent *result*
memory only.

## 1. Install
```bash
python -m pip install -r requirements.txt
```

## 2. Configure Supabase
Copy `.env.example` to `.env` and fill in your connection. Two ways:

**A. Full connection string** (Supabase dashboard → Project Settings →
Database → Connection string → URI):
```
SUPABASE_DB_URL=postgresql://postgres:YOUR-PASSWORD@db.YOURREF.supabase.co:5432/postgres
```

**B. Pieces** (we build the URL):
```
SUPABASE_PROJECT_REF=yourref
SUPABASE_DB_PASSWORD=your-db-password
SUPABASE_DB_PORT=5432        # 5432 direct, 6543 session pooler
```
`.env` is gitignored — credentials never get committed.

## 3. Run
```bash
# Windows PowerShell
$env:PORT="8080"; python saas.py
# bash
PORT=8080 python saas.py
```
On startup the app pings Supabase and creates the tables if missing, then serves
http://127.0.0.1:8080 . The app starts **empty** — import a sheet to begin.

### Environment
| Var                    | Default     | Meaning                                  |
|------------------------|-------------|------------------------------------------|
| `SUPABASE_DB_URL`      | —           | Full Postgres URI (preferred).           |
| `SUPABASE_PROJECT_REF` | —           | Project ref, if not using the full URI.  |
| `SUPABASE_DB_PASSWORD` | —           | DB password, if not using the full URI.  |
| `SUPABASE_DB_PORT`     | `5432`      | 5432 direct / 6543 pooler.               |
| `HOST`                 | `127.0.0.1` | Bind address (`0.0.0.0` to expose).      |
| `PORT`                 | `8080`      | Bind port (avoid 5060/61).               |
| `THREADS`              | `16`        | waitress threads.                        |
| `MAX_UPLOAD_MB`        | `64`        | Upload size cap.                         |

> **Single process only.** Run state (config/progress/log) is in memory, so run
> one waitress process (it scales with threads). Do not use `gunicorn -w N`.
> The live log is capped at 5,000 entries to keep memory bounded.

## 4. Pages
- **/pipeline** — drop a sheet → it's previewed (no write) so you can **filter
  by Designer Product URL**: a contains-text box plus a checklist of detected
  designer domains. Import applies the filter; the DB becomes exactly those
  rows. Then run the checker; results commit per row.
- **/review** — Mismatch / Error / Resolved feeds, brand filter, approve with
  markup or custom price, per-row + bulk Shopify push, slow error re-run.
- **/alerts** — products whose live price moved beyond a % threshold vs the
  previous run; filter by direction (drop/spike) and brand.
- **/integrations** — add a Shopify token per brand, Verify, toggle dry-run/live.

## 5. Data model (Supabase / Postgres)
- `products` — one row per product (keyed by Designer URL): sheet facts, latest
  live result, approval decision, Shopify push status.
- `price_history` — append-only snapshot per (product, run); powers Alerts.
- `integrations` — Shopify credentials per brand.
- `meta` — last import info + saved filter, last imported sheet path.

Export any view (all / mismatch / error / approved) to xlsx or csv via
`/api/export?kind=...&fmt=...`. The **xlsx is color-coded**: yellow rows for
price mismatches, red rows for fetch errors (see the "legend" sheet).

## 6. Notes
- `/healthz` returns liveness for load balancers.
- If startup prints "Supabase connection FAILED", check `.env` and that your IP
  is allowed (Supabase → Database → Network restrictions) / the pooler port.
