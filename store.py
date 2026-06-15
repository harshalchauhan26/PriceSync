#!/usr/bin/env python3
"""
PriceSync data layer — a single SQLite database is the source of truth.

Tables:
  products      one row per tracked product (sheet facts + live results +
                approval decision + Shopify push status), keyed by a natural
                `key` (Designer URL, or MBO URL when the Designer URL is blank).
  integrations  Shopify credentials per brand (replaces shopify_brands.json).
  meta          small key/value store (last import, etc.).

Nothing here reads or writes Excel except `import_sheet`, the one-time (or
on-demand) loader that pulls an .xlsx/.csv into `products`.
"""

import os
import sqlite3
import time
from urllib.parse import urlsplit

import pandas as pd

import price_tracker as pt

DB_PATH = os.environ.get("PRICESYNC_DB", "pricesync.db")


def connect():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    return con


def init():
    con = connect()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS products (
        id           INTEGER PRIMARY KEY,
        key          TEXT UNIQUE,
        mbo_url      TEXT,
        url          TEXT,
        platform     TEXT,
        custom_regex TEXT,
        brand        TEXT,
        base_price   REAL,
        live_price   REAL,
        currency     TEXT,
        status       TEXT DEFAULT '',
        state        TEXT DEFAULT 'pending',   -- pending|matched|mismatch|error
        delta        REAL,
        decision     TEXT DEFAULT 'pending',   -- pending|approved|rejected
        markup_pct   REAL,
        custom_price REAL,
        ref          TEXT DEFAULT 'live',
        final_price  REAL,
        note         TEXT,
        decided_at   TEXT,
        shopify_status TEXT,
        shopify_at   TEXT,
        rerun_status TEXT,
        rerun_at     TEXT,
        updated_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_products_state ON products(state);
    CREATE INDEX IF NOT EXISTS ix_products_brand ON products(brand);

    CREATE TABLE IF NOT EXISTS integrations (
        brand        TEXT PRIMARY KEY,
        shop_domain  TEXT,
        access_token TEXT,
        api_version  TEXT DEFAULT '2024-10',
        dry_run      INTEGER DEFAULT 0,
        updated_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    """)
    con.commit()
    con.close()


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
    con.execute("INSERT INTO meta(k,v) VALUES(?,?) "
                "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def get_meta(k, default=None):
    con = connect()
    r = con.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    con.close()
    return r["v"] if r else default


# ---------------------------------------------------------------------------
# One-time / on-demand import of a tracker sheet into the DB
# ---------------------------------------------------------------------------

def import_sheet(path, replace=True):
    """Sync `products` to the sheet so the DB equals exactly what you upload.

    - Rows in the sheet are inserted/updated (keyed by `key`).
    - Your approval decision + Shopify status are preserved for rows that stay.
    - Live results/Status are only overwritten when the sheet actually carries
      those columns (a URL-only sheet keeps existing results).
    - replace=True (default): products NOT in the sheet are DELETED, so the DB
      mirrors the sheet — the app only works on what you sent.
    """
    if path.lower().endswith(".csv"):
        df = pd.read_csv(path)
    else:
        df = pd.read_excel(path)
    missing = [c for c in pt.REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"missing required columns: {missing}")

    now = time.strftime("%Y-%m-%d %H:%M:%S")
    has_live = "Live Price" in df.columns
    has_status = "Status" in df.columns

    # Only refresh result columns the sheet actually provides.
    set_parts = ["mbo_url=excluded.mbo_url", "url=excluded.url",
                 "platform=excluded.platform", "custom_regex=excluded.custom_regex",
                 "brand=excluded.brand", "base_price=excluded.base_price",
                 "updated_at=excluded.updated_at"]
    if has_live:
        set_parts += ["live_price=excluded.live_price",
                      "currency=excluded.currency", "delta=excluded.delta"]
    if has_status:
        set_parts += ["status=excluded.status", "state=excluded.state"]
    upsert = ("""INSERT INTO products
                   (key, mbo_url, url, platform, custom_regex, brand,
                    base_price, live_price, currency, status, state, delta,
                    updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(key) DO UPDATE SET """ + ", ".join(set_parts))

    con = connect()
    keys = []
    try:
        for _, r in df.iterrows():
            url = str(r.get("Designer Product URL") or "").strip()
            mbo = str(r.get("MBO Product URL") or "").strip()
            key = url or mbo
            if not key:
                continue
            regex = r.get("Custom Regex")
            regex = "" if pd.isna(regex) else str(regex).strip()
            base = pt.sanitize_price(r.get("Studio East Price"))
            live = pt.sanitize_price(r.get("Live Price")) if has_live else None
            cur = str(r.get("Detected Currency") or "").strip() if has_live else ""
            status = str(r.get("Status") or "").strip() if has_status else ""
            state = state_of(status)
            delta = (live - base) if (live is not None and base is not None) else None
            con.execute(upsert,
                (key, mbo, url, str(r.get("Platform Type") or "").strip(), regex,
                 brand_of(url), base, live, cur, status, state, delta, now))
            keys.append(key)

        deleted = 0
        if replace:
            con.execute("CREATE TEMP TABLE _keep(key TEXT PRIMARY KEY)")
            con.executemany("INSERT OR IGNORE INTO _keep VALUES(?)",
                            [(k,) for k in keys])
            deleted = con.execute(
                "DELETE FROM products WHERE key NOT IN (SELECT key FROM _keep)"
                ).rowcount
            con.execute("DROP TABLE _keep")

        set_meta(con, "last_import", now)
        set_meta(con, "last_import_file", os.path.basename(path))
        set_meta(con, "last_import_rows", len(keys))
        con.commit()
    finally:
        con.close()
    return {"rows": len(keys), "removed": deleted, "at": now,
            "file": os.path.basename(path)}


def counts():
    con = connect()
    row = con.execute("""
        SELECT
          COUNT(*) total,
          SUM(state='pending') pending,
          SUM(state='matched') matched,
          SUM(state='mismatch') mismatch,
          SUM(state='error') error,
          SUM(decision='approved') approved,
          SUM(state='mismatch' AND decision='pending') awaiting,
          SUM(decision='rejected') rejected
        FROM products""").fetchone()
    con.close()
    return {k: (row[k] or 0) for k in row.keys()}


if __name__ == "__main__":
    init()
    if get_meta("last_import") is None and os.path.exists("MBO_Scraped_Result.xlsx"):
        print(import_sheet("MBO_Scraped_Result.xlsx"))
    print(counts())
