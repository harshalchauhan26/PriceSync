#!/usr/bin/env python3
"""
PriceSync data layer — a single Supabase (Postgres) database is the permanent
source of truth. Replaces the old SQLite file, so nothing accumulates locally
and the memory survives restarts / multiple machines.

Tables:
  products       one row per tracked product (sheet facts + latest live result +
                 approval decision + Shopify push status), keyed by a natural
                 `key` (Designer URL, or MBO URL when the Designer URL is blank).
  price_history  one row per (product, run) — an append-only price timeline that
                 powers the Alerts page (drops / spikes vs the previous run).
  integrations   Shopify credentials per brand.
  meta           small key/value store (last import, last import file path, ...).

Important design choice: the *list of links to check* always comes from the
uploaded sheet (see `work_rows`), never from the DB. The DB is permanent memory
for results — it never decides which URLs get fetched.

Connection: set SUPABASE_DB_URL in .env (see .env.example), or the pieces
SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD.
"""

import os
import time
from urllib.parse import urlsplit, quote

import pandas as pd
import psycopg
from psycopg.rows import dict_row

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # python-dotenv optional at runtime
    pass

import price_tracker as pt


def conninfo():
    """Build the Postgres connection string from env."""
    url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if url:
        return url
    ref = os.environ.get("SUPABASE_PROJECT_REF", "").strip()
    pw = os.environ.get("SUPABASE_DB_PASSWORD", "").strip()
    port = os.environ.get("SUPABASE_DB_PORT", "5432").strip()
    if ref and pw:
        return (f"postgresql://postgres:{quote(pw, safe='')}"
                f"@db.{ref}.supabase.co:{port}/postgres")
    raise RuntimeError(
        "No Supabase connection configured. Set SUPABASE_DB_URL (or "
        "SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD) in your .env file. "
        "See .env.example.")


def connect():
    return psycopg.connect(conninfo(), connect_timeout=15, row_factory=dict_row)


_SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS products (
        id           BIGSERIAL PRIMARY KEY,
        key          TEXT UNIQUE,
        mbo_url      TEXT,
        url          TEXT,
        platform     TEXT,
        custom_regex TEXT,
        brand        TEXT,
        base_price   DOUBLE PRECISION,
        live_price   DOUBLE PRECISION,
        currency     TEXT,
        status       TEXT DEFAULT '',
        state        TEXT DEFAULT 'pending',
        delta        DOUBLE PRECISION,
        decision     TEXT DEFAULT 'pending',
        markup_pct   DOUBLE PRECISION,
        custom_price DOUBLE PRECISION,
        ref          TEXT DEFAULT 'live',
        final_price  DOUBLE PRECISION,
        note         TEXT,
        decided_at   TEXT,
        shopify_status TEXT,
        shopify_at   TEXT,
        rerun_status TEXT,
        rerun_at     TEXT,
        updated_at   TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS ix_products_state ON products(state)",
    "CREATE INDEX IF NOT EXISTS ix_products_brand ON products(brand)",
    """
    CREATE TABLE IF NOT EXISTS price_history (
        id          BIGSERIAL PRIMARY KEY,
        key         TEXT,
        url         TEXT,
        brand       TEXT,
        base_price  DOUBLE PRECISION,
        live_price  DOUBLE PRECISION,
        delta       DOUBLE PRECISION,
        state       TEXT,
        status      TEXT,
        run_id      TEXT,
        created_at  TIMESTAMPTZ DEFAULT now()
    )""",
    "CREATE INDEX IF NOT EXISTS ix_hist_key ON price_history(key, created_at)",
    """
    CREATE TABLE IF NOT EXISTS integrations (
        brand        TEXT PRIMARY KEY,
        shop_domain  TEXT,
        access_token TEXT,
        api_version  TEXT DEFAULT '2024-10',
        dry_run      INTEGER DEFAULT 0,
        updated_at   TEXT
    )""",
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
]


def init():
    con = connect()
    try:
        for stmt in _SCHEMA:
            con.execute(stmt)
        con.commit()
    finally:
        con.close()


def ping():
    """Quick connectivity check used at startup. Returns (ok, message)."""
    try:
        con = connect()
        con.execute("SELECT 1")
        con.close()
        return True, "connected"
    except Exception as exc:
        return False, str(exc)


def brand_of(url):
    host = urlsplit(str(url or "")).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def state_of(status):
    s = str(status or "").strip()
    if s.startswith("Price Matched"):
        return "matched"
    if s.startswith("Price Mismatch"):
        return "mismatch"
    if s.startswith("Fetch Error"):
        return "error"
    return "pending"


def set_meta(con, k, v):
    con.execute("INSERT INTO meta(k,v) VALUES(%s,%s) "
                "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def get_meta(k, default=None):
    con = connect()
    r = con.execute("SELECT v FROM meta WHERE k=%s", (k,)).fetchone()
    con.close()
    return r["v"] if r else default


# ---------------------------------------------------------------------------
# Reading a tracker sheet -> normalized rows (the ONLY source of links)
# ---------------------------------------------------------------------------

def _read_df(path):
    if path.lower().endswith(".csv"):
        df = pd.read_csv(path)
    else:
        df = pd.read_excel(path)
    missing = [c for c in pt.REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"missing required columns: {missing}")
    return df


def _row_to_product(r, idx, has_live, has_status):
    url = str(r.get("Designer Product URL") or "").strip()
    mbo = str(r.get("MBO Product URL") or "").strip()
    if not (url or mbo):
        return None
    # Key per ROW (idx prefix) so every sheet row is a tracked product — no
    # collapsing of duplicate Designer URLs. The URL tail keeps it readable.
    key = f"{idx:05d}|{(url or mbo)[:280]}"
    regex = r.get("Custom Regex")
    regex = "" if pd.isna(regex) else str(regex).strip()
    base = pt.sanitize_price(r.get("Studio East Price"))
    live = pt.sanitize_price(r.get("Live Price")) if has_live else None
    cur = str(r.get("Detected Currency") or "").strip() if has_live else ""
    status = str(r.get("Status") or "").strip() if has_status else ""
    state = state_of(status)
    delta = (live - base) if (live is not None and base is not None) else None
    return {
        "key": key, "mbo_url": mbo, "url": url,
        "platform": str(r.get("Platform Type") or "").strip(),
        "custom_regex": regex, "brand": brand_of(url),
        "base_price": base, "live_price": live, "currency": cur,
        "status": status, "state": state, "delta": delta,
    }


def _matches(prod, contains, domains):
    """Designer-URL filter applied at import AND at run time."""
    if contains:
        if contains.lower() not in (prod["url"] or "").lower():
            return False
    if domains:
        if prod["brand"] not in domains:
            return False
    return True


def sheet_products(path, contains=None, domains=None):
    """Parse a sheet into a list of product dicts (one per ROW), applying the
    Designer-URL filter (contains substring + domain whitelist)."""
    df = _read_df(path)
    has_live = "Live Price" in df.columns
    has_status = "Status" in df.columns
    contains = (contains or "").strip().lower() or None
    domains = set(domains) if domains else None
    out = []
    for idx, rd in enumerate(df.to_dict("records"), start=1):
        p = _row_to_product(rd, idx, has_live, has_status)
        if not p or not _matches(p, contains, domains):
            continue
        out.append(p)
    return out


def preview_sheet(path):
    """Inspect an uploaded sheet without importing: distinct designer domains
    and counts, so the UI can offer a domain picker + contains filter."""
    df = _read_df(path)
    has_live = "Live Price" in df.columns
    has_status = "Status" in df.columns
    by_domain = {}
    total = 0
    for idx, rd in enumerate(df.to_dict("records"), start=1):
        p = _row_to_product(rd, idx, has_live, has_status)
        if not p:
            continue
        total += 1
        by_domain[p["brand"]] = by_domain.get(p["brand"], 0) + 1
    domains = sorted(({"domain": d or "(none)", "count": c}
                      for d, c in by_domain.items()),
                     key=lambda x: -x["count"])
    return {"rows": total, "domains": domains,
            "has_results": has_live or has_status}


# ---------------------------------------------------------------------------
# Import: sync `products` to the (filtered) sheet, and remember the file so the
# pipeline can re-read the links straight from it.
# ---------------------------------------------------------------------------

_UPSERT_BASE = """
INSERT INTO products
  (key, mbo_url, url, platform, custom_regex, brand,
   base_price, live_price, currency, status, state, delta, updated_at)
VALUES (%(key)s,%(mbo_url)s,%(url)s,%(platform)s,%(custom_regex)s,%(brand)s,
        %(base_price)s,%(live_price)s,%(currency)s,%(status)s,%(state)s,
        %(delta)s,%(updated_at)s)
ON CONFLICT(key) DO UPDATE SET """


def import_sheet(path, replace=True, contains=None, domains=None):
    """Sync `products` to the filtered sheet. The DB becomes exactly the rows
    you uploaded that pass the Designer-URL filter (when replace=True)."""
    prods = sheet_products(path, contains=contains, domains=domains)
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    # Always upsert facts; only overwrite result columns the sheet carries.
    df = _read_df(path)
    has_live = "Live Price" in df.columns
    has_status = "Status" in df.columns
    set_parts = ["mbo_url=excluded.mbo_url", "url=excluded.url",
                 "platform=excluded.platform", "custom_regex=excluded.custom_regex",
                 "brand=excluded.brand", "base_price=excluded.base_price",
                 "updated_at=excluded.updated_at"]
    if has_live:
        set_parts += ["live_price=excluded.live_price",
                      "currency=excluded.currency", "delta=excluded.delta"]
    if has_status:
        set_parts += ["status=excluded.status", "state=excluded.state"]
    upsert = _UPSERT_BASE + ", ".join(set_parts)

    con = connect()
    try:
        keys = []
        for p in prods:
            p["updated_at"] = now
            keys.append(p["key"])
        # Bulk upsert (psycopg3 executemany is pipelined -> far faster than a
        # per-row execute loop over the pooler).
        if prods:
            con.cursor().executemany(upsert, prods)

        deleted = 0
        if replace:
            con.execute("CREATE TEMP TABLE _keep(key TEXT PRIMARY KEY) "
                        "ON COMMIT DROP")
            con.cursor().executemany("INSERT INTO _keep VALUES(%s) "
                                     "ON CONFLICT DO NOTHING",
                                     [(k,) for k in keys])
            deleted = con.execute(
                "DELETE FROM products WHERE key NOT IN (SELECT key FROM _keep)"
                ).rowcount

        set_meta(con, "last_import", now)
        set_meta(con, "last_import_file", os.path.basename(path))
        set_meta(con, "last_import_path", os.path.abspath(path))
        set_meta(con, "last_import_rows", len(keys))
        set_meta(con, "last_import_contains", contains or "")
        set_meta(con, "last_import_domains", ",".join(domains) if domains else "")
        con.commit()
    finally:
        con.close()
    return {"rows": len(keys), "removed": deleted, "at": now,
            "file": os.path.basename(path)}


def db_products(mode="fresh"):
    """The pipeline's work list read straight from the permanent DB — so the
    app can run with NO sheet upload at all (the DB is the product catalog).

    mode="fresh"  -> every product.
    mode="update" -> only products not yet done (pending) or errored.
    """
    where = "" if mode == "fresh" else "WHERE state IN ('pending','error')"
    con = connect()
    rows = con.execute(
        "SELECT key, mbo_url, url, platform, custom_regex, brand, base_price, "
        f"state FROM products {where} ORDER BY id").fetchall()
    con.close()
    return [dict(r) for r in rows]


def work_rows(mode="fresh"):
    """The pipeline's work list.

    Default source is the **permanent Supabase DB** (no sheet upload needed).
    If a sheet was explicitly imported and the file is still present, the links
    are taken from that sheet instead (sheet overrides DB for that session).

    mode="fresh"  -> every product.
    mode="update" -> only products pending/errored.
    """
    path = get_meta("last_import_path")
    if not path or not os.path.exists(path):
        return db_products(mode)          # permanent DB is the source
    contains = (get_meta("last_import_contains") or "") or None
    dom = get_meta("last_import_domains") or ""
    domains = [d for d in dom.split(",") if d] or None
    prods = sheet_products(path, contains=contains, domains=domains)
    if mode == "fresh":
        return prods
    con = connect()
    rows = con.execute("SELECT key, state FROM products").fetchall()
    con.close()
    state_by_key = {r["key"]: r["state"] for r in rows}
    return [p for p in prods
            if state_by_key.get(p["key"], "pending") in ("pending", "error")]


def alert_count(threshold=5.0):
    """How many products moved >= threshold% between their last two runs."""
    con = connect()
    try:
        r = con.execute("""
            SELECT COUNT(*) c FROM (
              SELECT live_price, prev FROM (
                SELECT live_price,
                  LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) prev,
                  ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) rn
                FROM price_history WHERE live_price IS NOT NULL
              ) t WHERE rn=1 AND prev IS NOT NULL AND prev<>0
                AND ABS((live_price-prev)/prev*100) >= %s
            ) z""", (abs(float(threshold)),)).fetchone()
        return r["c"] or 0
    except Exception:
        return 0
    finally:
        con.close()


def counts():
    con = connect()
    row = con.execute("""
        SELECT
          COUNT(*) total,
          COUNT(*) FILTER (WHERE state='pending')  pending,
          COUNT(*) FILTER (WHERE state='matched')  matched,
          COUNT(*) FILTER (WHERE state='mismatch') mismatch,
          COUNT(*) FILTER (WHERE state='error')    error,
          COUNT(*) FILTER (WHERE decision='approved') approved,
          COUNT(*) FILTER (WHERE state='mismatch' AND decision='pending') awaiting,
          COUNT(*) FILTER (WHERE decision='rejected') rejected
        FROM products""").fetchone()
    con.close()
    return {k: (row[k] or 0) for k in row.keys()}


if __name__ == "__main__":
    ok, msg = ping()
    print("Supabase:", "OK" if ok else "FAIL", "-", msg)
    if ok:
        init()
        print(counts())
