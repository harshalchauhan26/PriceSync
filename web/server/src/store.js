import * as XLSX from "xlsx";
import { pool, withTenant } from "./db.js";
import { toInr } from "./fx.js";

const REQUIRED = ["MBO Product URL", "Designer Product URL", "Platform Type",
  "Custom Regex", "Studio East Price"];
const STORE_KEY = '__store__';

export function canonicalUrl(url) {
  const s = String(url || "").trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    u.searchParams.delete("wmc-currency");
    u.searchParams.delete("currency");
    return u.toString();
  } catch { return s; }
}

// Tenant-directory lookup — NOT tenant-scoped (the `mbo` table itself is the
// list of tenants), so this queries the plain pool directly rather than
// going through withTenant. Used at login to confirm the "Brand ID" the
// user typed actually matches the account they're signing into.
export async function mboBySlug(slug) {
  const r = await pool.query("SELECT id, slug, name, status FROM mbo WHERE slug=$1",
    [String(slug || "").trim().toLowerCase()]);
  return r.rows[0] || null;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS products (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE, mbo_url TEXT, url TEXT,' +
    'platform TEXT, custom_regex TEXT, brand TEXT, base_price DOUBLE PRECISION,' +
    'live_price DOUBLE PRECISION, currency TEXT, status TEXT DEFAULT \'\',' +
    'state TEXT DEFAULT \'pending\', delta DOUBLE PRECISION,' +
    'decision TEXT DEFAULT \'pending\', markup_pct DOUBLE PRECISION,' +
    'custom_price DOUBLE PRECISION, ref TEXT DEFAULT \'live\',' +
    'final_price DOUBLE PRECISION, note TEXT, decided_at TEXT,' +
    'shopify_status TEXT, shopify_at TEXT, rerun_status TEXT,' +
    'rerun_at TEXT, updated_at TEXT)',
  'CREATE INDEX IF NOT EXISTS ix_products_state ON products(state)',
  'CREATE INDEX IF NOT EXISTS ix_products_brand ON products(brand)',
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS base_usd DOUBLE PRECISION',
  // "Clear view" in Review: hides a row from the review queue permanently
  // without touching its price data — an UPDATE, never a DELETE.
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS review_dismissed_at TIMESTAMPTZ',
  // Human/verified "dead link" marker. Set only when a link has failed as a
  // PERMANENT error (404 / removed / redirected-off-product) across two or
  // more separate runs — see markVerifiedDead(). Purely a label so tooling
  // can stop re-fetching known-dead URLs; the row stays state=\'error\' and
  // still shows in Review. Never auto-set from a single failure, never a DELETE.
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS verified_dead_at TIMESTAMPTZ',
  'CREATE TABLE IF NOT EXISTS import_catalog (' +
    'key TEXT PRIMARY KEY, mbo_url TEXT, url TEXT, platform TEXT,' +
    'custom_regex TEXT, brand TEXT, base_price DOUBLE PRECISION, imported_at TEXT)',
  'CREATE INDEX IF NOT EXISTS ix_import_catalog_brand ON import_catalog(brand)',
  'CREATE TABLE IF NOT EXISTS price_history (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT, url TEXT, brand TEXT,' +
    'base_price DOUBLE PRECISION, live_price DOUBLE PRECISION,' +
    'delta DOUBLE PRECISION, state TEXT, status TEXT, run_id TEXT,' +
    'created_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_price_history_key ON price_history(key, created_at)',
  'CREATE TABLE IF NOT EXISTS review_history (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT, mbo_url TEXT, url TEXT,' +
    'platform TEXT, brand TEXT, base_price DOUBLE PRECISION,' +
    'live_price DOUBLE PRECISION, currency TEXT, delta DOUBLE PRECISION,' +
    'status TEXT, markup_pct DOUBLE PRECISION, ref TEXT,' +
    'final_price DOUBLE PRECISION, note TEXT, approved_by TEXT,' +
    'approved_at TIMESTAMPTZ DEFAULT now(), shopify_status TEXT, shopify_at TEXT)',
  'CREATE INDEX IF NOT EXISTS ix_review_history_brand ON review_history(brand)',
  'CREATE TABLE IF NOT EXISTS integrations (' +
    'brand TEXT PRIMARY KEY, shop_domain TEXT, access_token TEXT,' +
    'api_version TEXT DEFAULT \'2024-10\', dry_run INTEGER DEFAULT 0, updated_at TEXT)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  // State-bucket tables: physical copies of a products row, one per
  // flagged state (WARN/ERROR/DONE). syncBucket() keeps at most one open
  // copy per key across all three; clearBuckets() removes it once the row
  // is approved+pushed and lives permanently in review_history instead.
  'CREATE TABLE IF NOT EXISTS mismatch (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE, mbo_url TEXT, url TEXT,' +
    'platform TEXT, brand TEXT, base_price DOUBLE PRECISION,' +
    'live_price DOUBLE PRECISION, currency TEXT, delta DOUBLE PRECISION,' +
    'status TEXT, run_id TEXT, flagged_at TIMESTAMPTZ DEFAULT now(),' +
    'updated_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_mismatch_brand ON mismatch(brand)',
  'CREATE TABLE IF NOT EXISTS error (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE, mbo_url TEXT, url TEXT,' +
    'platform TEXT, brand TEXT, base_price DOUBLE PRECISION,' +
    'live_price DOUBLE PRECISION, currency TEXT, delta DOUBLE PRECISION,' +
    'status TEXT, run_id TEXT, flagged_at TIMESTAMPTZ DEFAULT now(),' +
    'updated_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_error_brand ON error(brand)',
  'CREATE TABLE IF NOT EXISTS resolved (' +
    'id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE, mbo_url TEXT, url TEXT,' +
    'platform TEXT, brand TEXT, base_price DOUBLE PRECISION,' +
    'live_price DOUBLE PRECISION, currency TEXT, delta DOUBLE PRECISION,' +
    'status TEXT, run_id TEXT, flagged_at TIMESTAMPTZ DEFAULT now(),' +
    'updated_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_resolved_brand ON resolved(brand)',

  // ---- multi-tenant (MBO) foundation — Phase A: additive only ----
  // `mbo` = one tenant (one retailer running one Shopify store over its own
  // set of designer brands). Tenant #1 is seeded at a fixed id so every
  // backfill below has a stable, predictable target — it represents the
  // pre-existing single-tenant production data, not a new customer.
  'CREATE TABLE IF NOT EXISTS mbo (' +
    'id BIGSERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,' +
    'status TEXT NOT NULL DEFAULT \'active\', created_at TIMESTAMPTZ DEFAULT now())',
  `INSERT INTO mbo (id, slug, name) VALUES (1, 'tenant-1', 'Tenant 1') ON CONFLICT (id) DO NOTHING`,
  `SELECT setval(pg_get_serial_sequence('mbo','id'), (SELECT MAX(id) FROM mbo))`,

  // Every existing tenant-data table gains a nullable mbo_id (nullable for
  // now — NOT NULL only lands once every row is confirmed backfilled, see
  // Phase D), backfilled to Tenant #1 so no existing row is ever orphaned.
  // New composite unique indexes are added ALONGSIDE the old bare ones
  // (dropped only in Phase D) so nothing about today's ON CONFLICT targets
  // breaks before the app code is updated to use them.
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE products SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_products_mbo ON products(mbo_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_products_mbo_key ON products(mbo_id, key)',

  'ALTER TABLE import_catalog ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE import_catalog SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_import_catalog_mbo ON import_catalog(mbo_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_import_catalog_mbo_key ON import_catalog(mbo_id, key)',

  'ALTER TABLE price_history ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE price_history SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_price_history_mbo ON price_history(mbo_id)',

  'ALTER TABLE review_history ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE review_history SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_review_history_mbo ON review_history(mbo_id)',

  'ALTER TABLE integrations ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE integrations SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_integrations_mbo_brand ON integrations(mbo_id, brand)',

  'ALTER TABLE meta ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE meta SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_mbo_k ON meta(mbo_id, k)',

  'ALTER TABLE mismatch ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE mismatch SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_mismatch_mbo ON mismatch(mbo_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_mismatch_mbo_key ON mismatch(mbo_id, key)',

  'ALTER TABLE error ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE error SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_error_mbo ON error(mbo_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_error_mbo_key ON error(mbo_id, key)',

  'ALTER TABLE resolved ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)',
  'UPDATE resolved SET mbo_id=1 WHERE mbo_id IS NULL',
  'CREATE INDEX IF NOT EXISTS ix_resolved_mbo ON resolved(mbo_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_resolved_mbo_key ON resolved(mbo_id, key)',
];

export async function initStore() {
  // pg_try_advisory_lock (non-blocking) instead of the blocking
  // pg_advisory_lock: a blocking wait can sit until Postgres's own
  // statement/idle timeout cancels it out from under us (a cryptic
  // ProcessInterrupts error, not our retry-on-40P01 deadlock case below),
  // which crashed boot when a prior deploy's connection was still holding
  // the lock. Polling ourselves means we control the wait and always fail
  // with a clear message instead of a raw Postgres internal error.
  const MAX_ATTEMPTS = 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext('mbo_tracker_schema_v1')) AS got`);
      if (!rows[0].got) {
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`initStore: could not acquire the schema migration lock after ${MAX_ATTEMPTS} attempts — another process is holding it`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
        continue;
      }
      try {
        for (const sql of SCHEMA) await client.query(sql);
        return;
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('mbo_tracker_schema_v1'))`).catch(() => {});
      }
    } finally {
      client.release();
    }
  }
}

export function brandOf(url) {
  try { const h = new URL(String(url || "")).host.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h; } catch { return ""; }
}
export function stateOf(status) {
  const s = String(status || "").trim();
  if (s.startsWith("Price Matched")) return "matched";
  if (s.startsWith("Price Mismatch")) return "mismatch";
  if (s.startsWith("Fetch Error")) return "error";
  return "pending";
}
export function matchTol(base, cur) {
  if (["INR", "UNKNOWN", null, ""].includes(cur)) return 1.0;
  return Math.max(1.0, 0.005 * Math.abs(base || 0));
}
const num = (v) => (v == null ? 0 : Number(v));

// ---- meta (per-tenant key/value store) ----
export async function setMeta(mboId, k, v) {
  await withTenant(mboId, (db) => db.q(
    "INSERT INTO meta(mbo_id,k,v) VALUES($1,$2,$3) ON CONFLICT(mbo_id,k) DO UPDATE SET v=excluded.v",
    [mboId, k, String(v)]));
}
export async function getMeta(mboId, k, def = null) {
  const r = await withTenant(mboId, (db) => db.one(
    "SELECT v FROM meta WHERE mbo_id=$1 AND k=$2", [mboId, k]));
  return r ? r.v : def;
}

// ---- counts / insights ----
// `total` is the real catalog size (dismissing a review row never shrinks
// it) — only the state-bucket counts that back the Review tabs/badges
// exclude dismissed rows, since dismissing is scoped to "stop showing me
// this in Review", not "stop counting this product".
export async function counts(mboId, brand) {
  const params = [mboId]; let where = "mbo_id=$1";
  if (brand) { params.push(brand); where += ` AND brand=$${params.length}`; }
  const r = await withTenant(mboId, (db) => db.one(`SELECT COUNT(*) total,
    COUNT(*) FILTER (WHERE state='pending' AND review_dismissed_at IS NULL) pending,
    COUNT(*) FILTER (WHERE state='matched' AND review_dismissed_at IS NULL) matched,
    COUNT(*) FILTER (WHERE state='mismatch' AND review_dismissed_at IS NULL) mismatch,
    COUNT(*) FILTER (WHERE state='error' AND review_dismissed_at IS NULL) error,
    COUNT(*) FILTER (WHERE decision='approved') approved,
    COUNT(*) FILTER (WHERE state='mismatch' AND decision='pending' AND review_dismissed_at IS NULL) awaiting,
    COUNT(*) FILTER (WHERE state='error' AND decision='pending' AND review_dismissed_at IS NULL) error_awaiting,
    COUNT(*) FILTER (WHERE state='matched' AND decision='pending' AND review_dismissed_at IS NULL) resolved_awaiting,
    COUNT(*) FILTER (WHERE decision='rejected') rejected FROM products WHERE ${where}`, params));
  const o = {}; for (const k of Object.keys(r)) o[k] = num(r[k]); return o;
}

// Per-tenant cache: keyed by `${mboId}:${threshold}` since alertCount also
// varies by the caller-supplied threshold.
const _alertCache = new Map();
export async function alertCount(mboId, threshold = 5) {
  const cacheKey = `${mboId}:${threshold}`;
  const now = Date.now();
  const cached = _alertCache.get(cacheKey);
  if (cached && now - cached.at < 60_000) return cached.value;
  try {
    const r = await withTenant(mboId, (db) => db.one(`SELECT COUNT(*) c FROM (
      SELECT live_price, prev FROM (
        SELECT live_price,
          LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) prev,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) rn
        FROM price_history WHERE mbo_id=$1 AND live_price IS NOT NULL
      ) t WHERE rn=1 AND prev IS NOT NULL AND prev<>0
        AND ABS((live_price-prev)/prev*100) >= $2) z`, [mboId, Math.abs(threshold)]));
    const value = num(r.c);
    _alertCache.set(cacheKey, { at: now, value });
    return value;
  } catch { return 0; }
}

// ---- vendors ----
export async function vendors(mboId, kind, source = 'database') {
  if (source === 'imported' && !kind) {
    const rows = await withTenant(mboId, (db) => db.q(`SELECT brand, COUNT(*) c FROM import_catalog
      WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY brand`, [mboId]));
    return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
  }
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind];
  const rows = await withTenant(mboId, (db) => state
    ? db.q("SELECT brand, COUNT(*) c FROM products WHERE mbo_id=$1 AND brand<>'' AND state=$2 GROUP BY brand ORDER BY brand", [mboId, state])
    : db.q("SELECT brand, COUNT(*) c FROM products WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY brand", [mboId]));
  return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
}

// Brand list scoped to exactly what the Review table shows (same WHERE as
// reviewItemsByBrands) -- counts reflect pending mismatch/error/matched
// rows per brand, not that brand's whole catalog.
export async function reviewVendors(mboId) {
  const rows = await withTenant(mboId, (db) => db.q(`SELECT brand, COUNT(*) c FROM products
    WHERE mbo_id=$1 AND brand<>'' AND decision='pending' AND review_dismissed_at IS NULL
      AND state IN ('mismatch','error','matched')
    GROUP BY brand ORDER BY brand`, [mboId]));
  return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
}

// Brand list scoped to review_history (what the History page shows) --
// counts are approvals archived per brand, not products.brand totals.
export async function historyVendors(mboId) {
  const rows = await withTenant(mboId, (db) => db.q(`SELECT brand, COUNT(*) c FROM review_history
    WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY brand`, [mboId]));
  return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
}

// ---- products work list (DB source) ----
export async function dbProducts(mboId, mode = "fresh", vendorList = null) {
  const cl = ["mbo_id=$1"]; const p = [mboId];
  // Incremental (update) runs re-fetch only unresolved rows and SKIP links
  // already confirmed dead across two runs — a fresh run still rechecks them.
  if (mode !== "fresh") { cl.push("state IN ('pending','error')"); cl.push("verified_dead_at IS NULL"); }
  if (vendorList && vendorList.length) {
    cl.push(`brand IN (${vendorList.map((_, i) => `$${p.length + i + 1}`).join(",")})`);
    p.push(...vendorList);
  }
  return withTenant(mboId, (db) => db.q(`SELECT key,mbo_url,url,platform,custom_regex,brand,base_price,base_usd,state
            FROM products WHERE ${cl.join(" AND ")} ORDER BY id`, p));
}
export async function countProducts(mboId, vendorList = null) {
  const cl = ["mbo_id=$1"]; const p = [mboId];
  if (vendorList && vendorList.length) {
    cl.push(`brand IN (${vendorList.map((_, i) => `$${p.length + i + 1}`).join(",")})`);
    p.push(...vendorList);
  }
  const r = await withTenant(mboId, (db) => db.one(`SELECT COUNT(*) c FROM products WHERE ${cl.join(" AND ")}`, p));
  return num(r.c);
}

export async function importedProducts(mboId, mode = 'fresh', vendorList = null) {
  const clauses = ["c.mbo_id=$1"]; const params = [mboId];
  if (vendorList && vendorList.length) {
    clauses.push(`c.brand IN (${vendorList.map((_, i) => `$${params.length + i + 1}`).join(',')})`);
    params.push(...vendorList);
  }
  if (mode !== 'fresh') { clauses.push(`COALESCE(p.state, 'pending') IN ('pending','error')`); clauses.push('p.verified_dead_at IS NULL'); }
  return withTenant(mboId, (db) => db.q(`SELECT c.key,c.mbo_url,c.url,c.platform,c.custom_regex,c.brand,c.base_price,
      p.base_usd, COALESCE(p.state,'pending') state
    FROM import_catalog c LEFT JOIN products p ON p.key=c.key AND p.mbo_id=c.mbo_id
    WHERE ${clauses.join(' AND ')} ORDER BY c.key`, params));
}

export async function countImported(mboId, vendorList = null) {
  const cl = ["mbo_id=$1"]; const p = [mboId];
  if (vendorList && vendorList.length) {
    cl.push(`brand IN (${vendorList.map((_, i) => `$${p.length + i + 1}`).join(',')})`);
    p.push(...vendorList);
  }
  const r = await withTenant(mboId, (db) => db.one(`SELECT COUNT(*) c FROM import_catalog WHERE ${cl.join(' AND ')}`, p));
  return num(r.c);
}

export async function workRows(mboId, mode = "fresh", vendorList = null, source = 'database') {
  return source === 'imported'
    ? importedProducts(mboId, mode, vendorList)
    : dbProducts(mboId, mode, vendorList);
}

// ---- state buckets (mismatch/error/resolved) ----
// Physical copy tables mirroring products.state: whenever a product's
// state changes, its copy moves to the matching bucket table and is
// removed from the other two — never both/neither. The products row
// itself is only ever updated here, never touched by this (copy, not move).
const BUCKET_TABLE = { mismatch: "mismatch", error: "error", matched: "resolved" };
const BUCKET_COLS = "mbo_id,key,mbo_url,url,platform,brand,base_price,live_price,currency,delta,status,run_id,updated_at";
export async function syncBucket(mboId, run, prow, state, runId = null) {
  const target = BUCKET_TABLE[state];
  for (const t of Object.values(BUCKET_TABLE)) {
    if (t !== target) await run(`DELETE FROM ${t} WHERE mbo_id=$1 AND key=$2`, [mboId, prow.key]);
  }
  if (!target) return;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await run(`INSERT INTO ${target} (${BUCKET_COLS})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(mbo_id,key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,platform=excluded.platform,
      brand=excluded.brand,base_price=excluded.base_price,live_price=excluded.live_price,
      currency=excluded.currency,delta=excluded.delta,status=excluded.status,
      run_id=excluded.run_id,updated_at=excluded.updated_at`,
    [mboId, prow.key, prow.mbo_url || "", prow.url, prow.platform, prow.brand,
      prow.base_price, prow.live_price, prow.currency, prow.delta, prow.status, runId, now]);
}
// Removes a product's copy from all three bucket tables — called once a
// row is approved and successfully pushed to Shopify (it now lives
// permanently in review_history instead), or when the product is deleted
// or reset back to 'pending'.
export async function clearBuckets(mboId, run, key) {
  for (const t of Object.values(BUCKET_TABLE)) await run(`DELETE FROM ${t} WHERE mbo_id=$1 AND key=$2`, [mboId, key]);
}

// ---- pipeline result write (+ history snapshot) ----
export async function saveResult(mboId, prod, status, live, cur, state, runId, extra = {}) {
  const base = prod.base_price;
  const usdBaseline = extra.usdBaseline === true;
  const baseUsd = usdBaseline ? (prod.base_usd != null ? prod.base_usd : live) : null;
  const delta = usdBaseline
    ? ((live != null && baseUsd != null) ? live - baseUsd : null)
    : ((live != null && base != null) ? (await toInr(mboId, live, cur)) - base : null);
  const baseUsdVal = usdBaseline ? live : null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const cleanUrl = canonicalUrl(prod.url);
  return withTenant(mboId, async (db) => {
    await db.client.query(`INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,
        live_price,currency,status,state,delta,decision,decided_at,updated_at,base_usd)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',NULL,$14,$15)
      ON CONFLICT(mbo_id,key) DO UPDATE SET url=excluded.url,live_price=excluded.live_price,currency=excluded.currency,
        status=excluded.status,state=excluded.state,delta=excluded.delta,
        decision='pending',decided_at=NULL,updated_at=excluded.updated_at,
        base_usd=COALESCE(products.base_usd,excluded.base_usd),review_dismissed_at=NULL`,
      [mboId, prod.key, prod.mbo_url || "", cleanUrl, prod.platform, prod.custom_regex, prod.brand,
        base, live, cur, status, state, delta, now, baseUsdVal]);
    await db.client.query(`INSERT INTO price_history(mbo_id,key,url,brand,base_price,live_price,delta,state,status,run_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [mboId, prod.key, cleanUrl, prod.brand, base, live, delta, state, status, runId]);
    await syncBucket(mboId, db.client.query.bind(db.client),
      { key: prod.key, mbo_url: prod.mbo_url || "", url: cleanUrl, platform: prod.platform,
        brand: prod.brand, base_price: base, live_price: live, currency: cur, delta, status },
      state, runId);
    return delta;
  });
}

export const productByKey = (mboId, key) => withTenant(mboId,
  (db) => db.one("SELECT * FROM products WHERE mbo_id=$1 AND key=$2", [mboId, key]));

// ---- review (one or more brands, priority-ordered: mismatch, then error, then matched) ----
export const STATE_PRIORITY_SQL = "CASE state WHEN 'mismatch' THEN 0 WHEN 'error' THEN 1 ELSE 2 END";
async function reviewSummaryByBrands(mboId, brands) {
  const scoped = brands && brands.length;
  const params = scoped ? [mboId, brands] : [mboId];
  const brandClause = scoped ? "AND brand = ANY($2::text[]) AND" : "AND";
  const r = await withTenant(mboId, (db) => db.one(`SELECT COUNT(*) total,
    COUNT(*) FILTER (WHERE state='mismatch') mismatch,
    COUNT(*) FILTER (WHERE state='error') error,
    COUNT(*) FILTER (WHERE state='matched') matched
    FROM products
    WHERE mbo_id=$1 ${brandClause} decision='pending' AND review_dismissed_at IS NULL
      AND state IN ('mismatch','error','matched')`, params));
  return {
    total: num(r?.total),
    mismatch: num(r?.mismatch),
    error: num(r?.error),
    matched: num(r?.matched),
  };
}

export async function reviewItemsByBrands(mboId, brands) {
  const scoped = brands && brands.length;
  const params = scoped ? [mboId, brands] : [mboId];
  const brandClause = scoped ? "AND brand = ANY($2::text[]) AND" : "AND";
  const [items, summary, c] = await Promise.all([
    withTenant(mboId, (db) => db.q(`SELECT * FROM products
    WHERE mbo_id=$1 ${brandClause} decision='pending' AND review_dismissed_at IS NULL
      AND state IN ('mismatch','error','matched')
    ORDER BY ${STATE_PRIORITY_SQL}, ABS(COALESCE(delta,0)) DESC`, params)),
    reviewSummaryByBrands(mboId, brands),
    counts(mboId),
  ]);
  return { items, counts: c, summary };
}

// Hides a single row from the review queue -- an UPDATE flag
// (review_dismissed_at), never a DELETE. Product/price data is
// untouched; what the Review table's per-row "Clear" button calls.
export async function dismissRow(mboId, id) {
  return withTenant(mboId, (db) => db.one(
    "UPDATE products SET review_dismissed_at=now() WHERE mbo_id=$1 AND id=$2 RETURNING key", [mboId, id]));
}

// Hides every row matching the same scope as reviewItemsByBrands (i.e.
// everything the Review table currently shows) -- an UPDATE flag, never
// a DELETE. No brand filter required: an empty/omitted brands list
// hides across every brand, matching "clear what's on screen right now".
// What the "Master Clean" button calls.
export async function dismissReviewByBrands(mboId, brands) {
  const scoped = brands && brands.length;
  const params = scoped ? [mboId, brands] : [mboId];
  const brandClause = scoped ? "AND brand = ANY($2::text[]) AND" : "AND";
  const r = await withTenant(mboId, (db) => db.q(`UPDATE products SET review_dismissed_at=now()
    WHERE mbo_id=$1 ${brandClause} decision='pending' AND review_dismissed_at IS NULL
      AND state IN ('mismatch','error','matched')
    RETURNING key`, params));
  return r.length;
}

// ---- review ----
export async function reviewItems(mboId, kind, brands) {
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  let where = "mbo_id=$1 AND state=$2 AND decision='pending' AND review_dismissed_at IS NULL"; const p = [mboId, state];
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${p.length + i + 1}`).join(",")})`; p.push(...brands);
  }
  const [items, c] = await Promise.all([
    withTenant(mboId, (db) => db.q(`SELECT * FROM products WHERE ${where}
    ORDER BY (decision='pending') DESC, ABS(COALESCE(delta,0)) DESC`, p)),
    counts(mboId),
  ]);
  return { items, counts: c };
}

// Persistently hides rows from the review queue (nav badge + tabs) WITHOUT
// touching price/decision data — an UPDATE flag, never a DELETE. This is
// what the Review page's "Clear view" button calls.
export async function dismissView(mboId, kind, brands) {
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || null;
  const cl = ["mbo_id=$1", "review_dismissed_at IS NULL"]; const p = [mboId];
  if (state) { cl.push(`state=$${p.length + 1}`); p.push(state); }
  if (brands && brands.length) { cl.push(`brand IN (${brands.map((_, i) => `$${p.length + i + 1}`).join(",")})`); p.push(...brands); }
  const r = await withTenant(mboId, (db) => db.q(`UPDATE products SET review_dismissed_at=now() WHERE ${cl.join(" AND ")} RETURNING key`, p));
  return r.length;
}

export function computeFinal(baseInr, liveInr, ref, markup, custom, convert, rate) {
  if (custom != null && Number(custom) > 0) return Math.round(Number(custom) * 100) / 100;
  let reference = ref === "base" ? baseInr : liveInr;
  if (reference == null) reference = baseInr;
  if (reference == null) return null;
  const converted = convert && rate ? reference / rate : reference;
  return Math.round((converted + Number(markup || 0)) * 100) / 100;
}

export function roundFinal(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return n;
  const r = Math.round(v);
  const tens = Math.floor(r / 10) * 10;
  const d = r - tens;
  return d <= 2 ? tens : d <= 5 ? tens + 5 : tens + 10;
}

export const normBrand = (b) => String(b || "").toLowerCase().replace(/^www\./, "").trim();

// ---- per-tenant brand-quirk list caches ----
// Every set/JSON-object cache below is keyed by mboId so one tenant's
// brand-quirk config can never leak into or clobber another tenant's.
const _cadCache = new Map();
const _usdFetchCache = new Map();
const _rangeHighCache = new Map();
const _gentleCache = new Map();
const _proxyCache = new Map();
const _localOnlyCache = new Map();
const _cloudSkipCache = new Map();
const _wooApiCache = new Map();

// ---- push currency per brand ----
export async function cadBrandSet(mboId) {
  const cached = _cadCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "push_cad_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _cadCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setCadBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "push_cad_brands", uniq.join(","));
  _cadCache.delete(mboId);
  return uniq;
}
export async function pushCurrencyFor(mboId, brand) {
  return (await cadBrandSet(mboId)).has(normBrand(brand)) ? "CAD" : "USD";
}

// ---- per-brand FETCH currency ----
export async function usdFetchBrandSet(mboId) {
  const cached = _usdFetchCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "fetch_usd_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _usdFetchCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setUsdFetchBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "fetch_usd_brands", uniq.join(","));
  _usdFetchCache.delete(mboId);
  return uniq;
}
export async function fetchCurrencyFor(mboId, brand) {
  return (await usdFetchBrandSet(mboId)).has(normBrand(brand)) ? "USD" : null;
}

// ---- per-brand RANGE price preference ----
const DEFAULT_RANGE_HIGH_BRANDS = new Set([
  // Masaba products can expose a low first variant/sale option while the
  // Studio East baseline tracks the full/high variant price.
  "houseofmasaba.com",
]);
export async function rangeHighBrandSet(mboId) {
  const cached = _rangeHighCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "range_high_brands", "");
  const set = new Set([...DEFAULT_RANGE_HIGH_BRANDS, ...String(raw || "").split(",").map(normBrand).filter(Boolean)]);
  _rangeHighCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setRangeHighBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "range_high_brands", uniq.join(","));
  _rangeHighCache.delete(mboId);
  return uniq;
}

// ---- per-brand GENTLE fetch (bot-protected domains) ----
export async function gentleBrandSet(mboId) {
  const cached = _gentleCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "gentle_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _gentleCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setGentleBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "gentle_brands", uniq.join(","));
  _gentleCache.delete(mboId);
  return uniq;
}

// ---- per-brand PROXY fetch (IP-banned domains; needs FETCH_PROXY_URL) ----
export async function proxyBrandSet(mboId) {
  const cached = _proxyCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "proxy_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _proxyCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setProxyBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "proxy_brands", uniq.join(","));
  _proxyCache.delete(mboId);
  return uniq;
}

// ---- per-brand LOCAL-ONLY fetch (cloud IP banned; refresh from local runs) ----
// These defaults apply to every tenant equally — they describe a property
// of the SITE (how it treats non-India request IPs), not tenant preference.
// A tenant can still add its own additional brands on top via meta.
const DEFAULT_LOCAL_ONLY_BRANDS = new Set([
  // WOOCS ("FOX") currency switcher geo-converts prices by IP: from the cloud
  // server's foreign IP it serves USD-converted numbers labelled USD (a genuine
  // ₹34,000 lehenga came back as $375 -> mismatch), while an India IP serves the
  // correct INR. No relay/proxy fixes the number itself, so fetch it locally.
  "labelanushree.com",
  // Shopify Markets geo-pricing inflates the .js variant JSON by a duty/landed-
  // cost multiplier (~1.23-1.25x) for non-India request IPs, still labelled
  // INR — every one of 44 rows fetched from the cloud (Singapore) came back
  // mismatched at that ratio while a same-day India-IP fetch matched base
  // exactly. No query param/header override worked; fetch it locally.
  "mymoledro.com",
]);
export async function localOnlyBrandSet(mboId) {
  const cached = _localOnlyCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "local_only_brands", "");
  const set = new Set([...DEFAULT_LOCAL_ONLY_BRANDS, ...String(raw || "").split(",").map(normBrand).filter(Boolean)]);
  _localOnlyCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setLocalOnlyBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "local_only_brands", uniq.join(","));
  _localOnlyCache.delete(mboId);
  return uniq;
}

// Brands that must NEVER be fetched from the cloud — not even via the relay.
// The store hard-blocks/geo-distorts every non-India IP: labelanushree returns
// HTTP 400 to the relay's Cloudflare IP and USD-converted prices to the Render
// IP, so a cloud run only clobbers the good India-fetched INR data with errors.
// These are skipped on cloud runs REGARDLESS of the relay and refreshed solely
// from a local run (scripts/run-local-only.mjs). Superset-safe:
// they're also in local-only, so local runs still fetch them.
const DEFAULT_CLOUD_SKIP_BRANDS = new Set(["labelanushree.com", "mymoledro.com"]);
export async function cloudSkipBrandSet(mboId) {
  const cached = _cloudSkipCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "cloud_skip_brands", "");
  const set = new Set([...DEFAULT_CLOUD_SKIP_BRANDS, ...String(raw || "").split(",").map(normBrand).filter(Boolean)]);
  _cloudSkipCache.set(mboId, { at: Date.now(), set });
  return set;
}

// ---- per-brand relay fetch tweaks (only applied when fetching via relay) ----
export async function wooApiBrandSet(mboId) {
  const cached = _wooApiCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "woo_api_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _wooApiCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setWooApiBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "woo_api_brands", uniq.join(","));
  _wooApiCache.delete(mboId);
  return uniq;
}
export async function relayAppendParams(mboId) {
  const raw = await getMeta(mboId, "relay_append_params", "");
  try {
    const obj = JSON.parse(raw || "{}");
    const out = {};
    for (const [b, params] of Object.entries(obj)) out[normBrand(b)] = params;
    return out;
  } catch { return {}; }
}
export async function setRelayAppendParams(mboId, obj) {
  await setMeta(mboId, "relay_append_params", JSON.stringify(obj || {}));
  return obj || {};
}

// ---- per-brand NATIVE currency (base_price is stored directly in this
// currency, not INR — skip FX conversion and force this currency label
// instead of trusting geo-dependent detection, e.g. Shopify Markets serving
// USD-labeled prices to a foreign-IP fetcher for a shop whose real/base
// currency is CAD) ----
export async function nativeCurrencyBrands(mboId) {
  const raw = await getMeta(mboId, "native_currency_brands", "");
  try {
    const obj = JSON.parse(raw || "{}");
    const out = {};
    for (const [b, cur] of Object.entries(obj)) out[normBrand(b)] = String(cur || "").toUpperCase();
    return out;
  } catch { return {}; }
}
export async function setNativeCurrencyBrands(mboId, obj) {
  const clean = {};
  for (const [b, cur] of Object.entries(obj || {})) {
    const nb = normBrand(b); const nc = String(cur || "").trim().toUpperCase();
    if (nb && nc) clean[nb] = nc;
  }
  await setMeta(mboId, "native_currency_brands", JSON.stringify(clean));
  return clean;
}

// ---- approval archive ----
const HIST_COLS = `mbo_id,key,mbo_url,url,platform,brand,base_price,live_price,currency,delta,
  status,markup_pct,ref,final_price,note,approved_by,approved_at`;
export async function liveBaseValue(mboId, prow) {
  if (!prow || prow.live_price == null) return null;
  const curUp = String(prow.currency || "INR").trim().toUpperCase();
  const nativeCur = (await nativeCurrencyBrands(mboId))[normBrand(prow.brand)];
  const isNative = !!(nativeCur && curUp === nativeCur);
  const baseNew = isNative ? Number(prow.live_price) : await toInr(mboId, prow.live_price, curUp);
  if (baseNew == null || !Number.isFinite(baseNew) || baseNew <= 0) return null;
  return {
    baseNew,
    baseUsd: !isNative && curUp === "USD" ? Number(prow.live_price) : null,
    statusLabel: `Price Matched (${isNative ? nativeCur : "INR"})`,
  };
}

export async function promoteLiveToBase(mboId, run, prow) {
  if (!prow?.key) return null;
  const next = await liveBaseValue(mboId, prow);
  if (!next) return null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await run(`UPDATE products SET base_price=$1, base_usd=$2, state='matched',
      status=$3, delta=0, updated_at=$4 WHERE mbo_id=$5 AND key=$6`,
    [next.baseNew, next.baseUsd, next.statusLabel, now, mboId, prow.key]);
  await run("UPDATE import_catalog SET base_price=$1 WHERE mbo_id=$2 AND key=$3", [next.baseNew, mboId, prow.key]);
  return { base_price: next.baseNew, base_usd: next.baseUsd, status: next.statusLabel };
}

export async function archiveApproved(mboId, client, prow, final, markup, ref, note, by) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const inserted = await client.query(`INSERT INTO review_history (${HIST_COLS})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *`,
    [mboId, prow.key, prow.mbo_url, prow.url, prow.platform, prow.brand, prow.base_price,
      prow.live_price, prow.currency, prow.delta, prow.status, markup, ref, final, note, by, now]);
  await client.query(`UPDATE products SET decision=$1,markup_pct=$2,ref=$3,
    final_price=$4,note=$5,decided_at=$6,shopify_status=NULL,shopify_at=NULL
    WHERE mbo_id=$7 AND id=$8`, ['approved', markup, ref, final, note, now, mboId, prow.id]);
  return inserted.rows[0];
}

// ---- history ----
const PUSH_SUCCESS = "(shopify_status LIKE 'updated%' OR shopify_status LIKE 'DRY RUN%')";
export async function historyList(mboId, brands, status) {
  const cl = ["mbo_id=$1"]; const p = [mboId];
  if (brands && brands.length) { p.push(brands); cl.push(`brand = ANY($${p.length}::text[])`); }
  if (status === "pushed") cl.push(PUSH_SUCCESS);
  else if (status === "failed") cl.push(`shopify_status IS NOT NULL AND NOT ${PUSH_SUCCESS}`);
  else if (status === "not_pushed") cl.push("shopify_status IS NULL");
  const where = "WHERE " + cl.join(" AND ");
  return withTenant(mboId, async (db) => {
    const rows = await db.q(`SELECT * FROM review_history ${where} ORDER BY approved_at DESC`, p);
    const s = await db.one(`SELECT COUNT(*) c, COALESCE(SUM(final_price),0) v,
      COUNT(*) FILTER (WHERE ${PUSH_SUCCESS}) pushed,
      COUNT(*) FILTER (WHERE shopify_status IS NOT NULL AND NOT ${PUSH_SUCCESS}) failed,
      COUNT(*) FILTER (WHERE shopify_status IS NULL) not_pushed FROM review_history WHERE mbo_id=$1`, [mboId]);
    return { items: rows, count: num(s.c), value: Number(s.v) || 0,
      pushed: num(s.pushed), failed: num(s.failed), not_pushed: num(s.not_pushed) };
  });
}

// ---- integrations (one Shopify store per tenant) ----
export async function getStoreIntegration(mboId) {
  return withTenant(mboId, (db) => db.one(
    "SELECT * FROM integrations WHERE mbo_id=$1 AND brand=$2", [mboId, STORE_KEY]));
}
export async function integrationBrands(mboId) {
  const brands = await withTenant(mboId, (db) => db.q(`SELECT brand, COUNT(*) c, COUNT(*) FILTER (WHERE state='mismatch') m
    FROM products WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY c DESC`, [mboId]));
  return brands.map((b) => ({ brand: b.brand, products: num(b.c), mismatches: num(b.m) }));
}

// ---- import sheet (xlsx/csv) ----
function rowToProduct(r, idx) {
  const url = String(r["Designer Product URL"] || "").trim();
  const mbo = String(r["MBO Product URL"] || "").trim();
  if (!url && !mbo) return null;
  const key = `${String(idx).padStart(5, "0")}|${(url || mbo).slice(0, 280)}`;
  let regex = r["Custom Regex"]; regex = regex == null ? "" : String(regex).trim();
  const base = sanitizeNum(r["Studio East Price"]);
  const live = sanitizeNum(r["Live Price"]);
  const currency = String(r["Detected Currency"] || "").trim();
  const status = String(r.Status || "").trim();
  return { key, mbo_url: mbo, url, platform: String(r["Platform Type"] || "").trim(),
    custom_regex: regex, brand: brandOf(url), base_price: base,
    live_price: live, currency, status, state: stateOf(status),
    delta: live != null && base != null ? live - base : null };
}
function sanitizeNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const m = String(v).replace(/[^0-9.]/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
// ---- add products directly (manual entry or a standalone sheet) ----
// Purely additive: always INSERTs new rows with a fresh key, never updates
// or deletes an existing product. Distinct from importSheet/commitImportToProducts,
// which sync the whole catalog to a staged sheet — this just appends.
export function parseAddSheet(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return raw.map((r) => {
    const url = String(r["Designer Product URL"] || "").trim();
    const mbo_url = String(r["MBO Product URL"] || "").trim();
    const platform = String(r["Platform Type"] || "").trim();
    const custom_regex = String(r["Custom Regex"] || "").trim();
    const base_price = sanitizeNum(r["Studio East Price"]);
    let _error = null;
    if (!url) _error = "missing Designer Product URL";
    else if (base_price == null || base_price <= 0) _error = "missing/invalid Studio East Price";
    return { url, mbo_url, platform, custom_regex, base_price, brand: brandOf(url), _error };
  });
}

export async function addProducts(mboId, rows) {
  const clean = (rows || [])
    .map((r) => ({
      url: String(r.url || "").trim(),
      mbo_url: String(r.mbo_url || "").trim(),
      platform: String(r.platform || "").trim(),
      custom_regex: String(r.custom_regex || "").trim(),
      base_price: r.base_price === "" || r.base_price == null ? null : Number(r.base_price),
    }))
    .filter((r) => r.url && Number.isFinite(r.base_price) && r.base_price > 0);
  if (!clean.length) return { added: 0 };
  return withTenant(mboId, async (db) => {
    let idx = num((await db.client.query(
      "SELECT COALESCE(MAX(split_part(key,'|',1)::int),0) m FROM products WHERE mbo_id=$1", [mboId]
    )).rows[0].m);
    let added = 0;
    for (const r of clean) {
      idx += 1;
      const key = `${String(idx).padStart(5, "0")}|${r.url.slice(0, 280)}`;
      const result = await db.client.query(
        `INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (mbo_id,key) DO NOTHING`,
        [mboId, key, r.mbo_url, r.url, r.platform, r.custom_regex, brandOf(r.url), r.base_price]
      );
      added += result.rowCount;
    }
    return { added };
  });
}

export function previewSheet(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const hasLive = rows.length > 0 && Object.hasOwn(rows[0], "Live Price");
  const hasStatus = rows.length > 0 && Object.hasOwn(rows[0], "Status");
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) throw new Error("missing required columns: " + missing.join(", "));
  const byDom = {}; let total = 0;
  rows.forEach((r, i) => { const p = rowToProduct(r, i + 1); if (!p) return;
    total++; byDom[p.brand] = (byDom[p.brand] || 0) + 1; });
  const domains = Object.entries(byDom).map(([d, c]) => ({ domain: d || "(none)", count: c }))
    .sort((a, b) => b.count - a.count);
  return { rows: total, domains,
    has_results: cols.includes('Live Price') || cols.includes('Status') };
}
export async function importSheet(mboId, buf, { replace = true, contains = '', domains = [] } = {}) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const hasLive = rows.length > 0 && Object.hasOwn(rows[0], "Live Price");
  const hasStatus = rows.length > 0 && Object.hasOwn(rows[0], "Status");
  const needle = String(contains || '').trim().toLowerCase();
  const domainSet = new Set((domains || []).filter(Boolean));
  const prods = rows.map((r, i) => rowToProduct(r, i + 1)).filter((p) => p &&
    (!needle || p.url.toLowerCase().includes(needle)) &&
    (!domainSet.size || domainSet.has(p.brand)));
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const { n, removed } = await withTenant(mboId, async (db) => {
    let n = 0, removed = 0;
    if (replace) {
      const r = await db.client.query("DELETE FROM import_catalog WHERE mbo_id=$1", [mboId]);
      removed = r.rowCount;
    }
    const CH = 500;
    for (let s = 0; s < prods.length; s += CH) {
      const chunk = prods.slice(s, s + CH);
      const importVals = []; const importPh = [];
      chunk.forEach((p, j) => {
        const b = j * 9;
        importPh.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        importVals.push(mboId, p.key, p.mbo_url, p.url, p.platform, p.custom_regex,
          p.brand, p.base_price, now);
      });
      await db.client.query(`INSERT INTO import_catalog
        (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,imported_at)
        VALUES ${importPh.join(',')}
        ON CONFLICT(mbo_id,key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
          platform=excluded.platform,custom_regex=excluded.custom_regex,
          brand=excluded.brand,base_price=excluded.base_price,
          imported_at=excluded.imported_at`, importVals);
      n += chunk.length;
    }
    return { n, removed };
  });
  await setMeta(mboId, "last_import", now);
  await setMeta(mboId, "last_import_rows", String(n));
  await setMeta(mboId, 'last_import_contains', needle);
  await setMeta(mboId, 'last_import_domains', [...domainSet].join(','));
  return { rows: n, removed, at: now };
}

// Upsert-only: a sheet sync ADDS new products and UPDATES catalog fields
// (mbo_url/platform/custom_regex/brand/base_price) on matching keys. It
// never deletes — a sheet that's missing rows (a partial/test file, a
// stale export) can no longer wipe out the rest of the products table.
export async function commitImportToProducts(mboId) {
  const staged = num((await withTenant(mboId, (db) => db.one(
    "SELECT COUNT(*) c FROM import_catalog WHERE mbo_id=$1", [mboId]))).c);
  if (!staged) {
    const total = num((await withTenant(mboId, (db) => db.one(
      "SELECT COUNT(*) c FROM products WHERE mbo_id=$1", [mboId]))).c);
    return { added: 0, staged: 0, total, skipped: true };
  }
  return withTenant(mboId, async (db) => {
    const before = num((await db.client.query("SELECT COUNT(*) c FROM products WHERE mbo_id=$1", [mboId])).rows[0].c);
    // COALESCE/NULLIF on platform+custom_regex: a sheet missing those
    // columns (e.g. a quick external test file) must not blank out a
    // scrape-critical field the product already had on file — that's
    // exactly what mislabeled a batch of Shopify products as generic
    // and made them scrape at 100x (cents, undescaled) on 2026-07-14.
    await db.client.query(`INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price)
      SELECT mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price FROM import_catalog
      WHERE mbo_id=$1
      ON CONFLICT(mbo_id,key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
        platform=COALESCE(NULLIF(excluded.platform,''), products.platform),
        custom_regex=COALESCE(NULLIF(excluded.custom_regex,''), products.custom_regex),
        brand=excluded.brand,base_price=excluded.base_price`, [mboId]);
    const after = num((await db.client.query("SELECT COUNT(*) c FROM products WHERE mbo_id=$1", [mboId])).rows[0].c);
    return { added: after - before, staged, total: after };
  });
}

// ---- verified-dead link marker ----
// A permanent failure is one where the product is genuinely gone, not a
// transient block/timeout. Transient errors (timeout / 403 / 429 / 5xx)
// must NEVER count toward marking a link dead.
export function isPermanentError(status) {
  const s = String(status || "").toLowerCase();
  return s.includes("removed") || s.includes("404") ||
    s.includes("unavailable") || s.includes("redirected off") ||
    s.includes("price not found");
}
// SQL fragment: does a status string describe a PERMANENT (dead) failure?
// Kept identical to isPermanentError() above.
const PERMANENT_ERR_SQL = `(
  LOWER(status) LIKE '%removed%' OR LOWER(status) LIKE '%404%' OR
  LOWER(status) LIKE '%unavailable%' OR LOWER(status) LIKE '%redirected off%' OR
  LOWER(status) LIKE '%price not found%')`;

// Call once after a pipeline run finishes. Decides "dead" from price_history,
// not a global counter, so a vendor-scoped run can't inflate rows it never
// touched: a link is stamped verified_dead_at only when its TWO most recent
// history entries are BOTH permanent errors. Also clears the marker for any
// row that is no longer in the error state (it recovered). Read/label only —
// never deletes, never changes state or price. Returns how many were newly
// marked dead.
export async function markVerifiedDead(mboId) {
  return withTenant(mboId, async (db) => {
    // A recovered row (matched/mismatch/pending) is not dead anymore.
    await db.q(`UPDATE products SET verified_dead_at = NULL
      WHERE mbo_id=$1 AND verified_dead_at IS NOT NULL AND state <> 'error'`, [mboId]);
    const r = await db.q(`
      WITH ranked AS (
        SELECT key, status,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) rn
        FROM price_history WHERE mbo_id=$1
      ),
      last2 AS (
        SELECT key, COUNT(*) n, bool_and(${PERMANENT_ERR_SQL}) both_dead
        FROM ranked WHERE rn <= 2 GROUP BY key
      )
      UPDATE products p SET verified_dead_at = now()
      FROM last2 l
      WHERE p.mbo_id=$1 AND p.key = l.key AND l.n >= 2 AND l.both_dead
        AND p.state = 'error' AND p.verified_dead_at IS NULL
      RETURNING p.key`, [mboId]);
    return r.length;
  });
}
export async function clearVerifiedDead(mboId, key) {
  await withTenant(mboId, (db) => db.q(
    "UPDATE products SET verified_dead_at=NULL WHERE mbo_id=$1 AND key=$2", [mboId, key]));
}

// ---- error meter (per-tenant + used by the super-admin cross-tenant view) ----
// Reuses the `Fetch Error (<cause>)` status-suffix convention already
// written by pipeline.js's finalizeOne() — groups current error rows by
// brand and cause so it's visible which site is failing and why.
export async function errorMeter(mboId, { brand } = {}) {
  const cl = ["mbo_id=$1", "state='error'"]; const p = [mboId];
  if (brand) { cl.push(`brand=$${p.length + 1}`); p.push(brand); }
  return withTenant(mboId, (db) => db.q(`SELECT brand,
    COALESCE(NULLIF(regexp_replace(status, '^Fetch Error \\(([^)]*)\\).*$', '\\1'), status), 'unknown') AS cause,
    COUNT(*) c, MAX(updated_at) last_seen
    FROM products WHERE ${cl.join(" AND ")}
    GROUP BY brand, cause ORDER BY c DESC`, p));
}

export { STORE_KEY };
