# PriceSync — Deployment Guide

One SQLite-backed app that imports a tracker sheet, verifies live prices,
lets you approve price changes (markup / custom), and pushes them to each
brand's Shopify store. The database (`pricesync.db`) is the single source of
truth — Excel is read only on import, so there are no file-lock problems.

## 1. Install
```bash
python -m pip install -r requirements.txt
```

## 2. Run
```bash
# Windows PowerShell
$env:PORT="8080"; python saas.py
# bash
PORT=8080 python saas.py
```
Open http://127.0.0.1:8080 . On first boot, if the DB is empty and
`MBO_Scraped_Result.xlsx` is present, it is imported automatically.

### Environment
| Var            | Default        | Meaning                                  |
|----------------|----------------|------------------------------------------|
| `HOST`         | `127.0.0.1`    | Bind address (`0.0.0.0` to expose).      |
| `PORT`         | `8080`         | Bind port (browser-safe; avoid 5060/61). |
| `THREADS`      | `16`           | waitress threads.                        |
| `PRICESYNC_DB` | `pricesync.db` | SQLite database path.                    |
| `MAX_UPLOAD_MB`| `64`           | Upload size cap.                         |

> **Single process only.** Run state (config/progress/log) is in memory, so
> run one waitress process (it scales with threads). Do not use a multi-process
> model (e.g. `gunicorn -w N`).

## 3. Pages
- **/pipeline** — import a sheet, run the checker, watch the live log. Results
  commit to the DB per row, so the Review page updates in real time.
- **/review** — Mismatch / Error / Resolved feeds, brand filter, approve with
  markup or custom price, per-row + bulk Shopify push, slow error re-run.
- **/integrations** — add a Shopify token per brand (store host +
  `shpat_…` token with `write_products`), Verify, toggle dry-run/live.

## 4. Data model (`pricesync.db`)
- `products` — one row per product (keyed by Designer URL), holds sheet facts,
  live results, approval decision, and Shopify push status.
- `integrations` — Shopify credentials per brand.
- `meta` — last import info, etc.

Export any view (all / mismatch / error / approved) to xlsx or csv via
`/api/export?kind=...&fmt=...` or the Export buttons.

## 5. Notes
- `MBO_Scraped_Result.xlsx` is kept only as the original source backup; the app
  no longer reads or writes it during runs. Re-import from the Pipeline page
  whenever you have a new sheet.
- `/healthz` returns liveness for load balancers.
