import * as XLSX from "xlsx";
import { pool, withTenant } from "./db.js";
import { toInr } from "./fx.js";
import { FETCH_ONLY_PARAMS } from "./engine.js";

const REQUIRED = ["MBO Product URL", "Designer Product URL", "Platform Type",
  "Custom Regex", "Studio East Price"];
const STORE_KEY = '__store__';

export function canonicalUrl(url) {
  const s = String(url || "").trim();
  if (!s) return s;
  try {
    const u = new URL(s);
    // Fetch-time params (currency pins, geo-pricing country pins) must never
    // reach the stored URL: one that did baked ?wmc-currency=USD into every row
    // of a brand and took a rescrape to repair.
    for (const p of FETCH_ONLY_PARAMS) u.searchParams.delete(p);
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
  // BUG-021: base_price alone is ambiguous — 3000 could be INR, USD or CAD.
  // Set at import/add time from the brand's usd/native-currency config, and
  // kept current by promoteLiveToBase() on every successful baseline update.
  // matchTol() reads this instead of inferring tolerance scale from whatever
  // currency happened to come back on the fetch that triggered the compare.
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT \'INR\'',
  'CREATE TABLE IF NOT EXISTS import_catalog (' +
    'key TEXT PRIMARY KEY, mbo_url TEXT, url TEXT, platform TEXT,' +
    'custom_regex TEXT, brand TEXT, base_price DOUBLE PRECISION, imported_at TEXT)',
  'ALTER TABLE import_catalog ADD COLUMN IF NOT EXISTS base_currency TEXT NOT NULL DEFAULT \'INR\'',
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

  // ---- base_price audit ----
  // base_price is the reference every mismatch is judged against, and three
  // separate paths rewrite it (sheet sync, Review "set base", and a SUCCESSFUL
  // Shopify push). Nothing recorded WHEN, so answering "did my base actually
  // update" meant inferring it from consecutive price_history rows — which only
  // sees a change if a run happened to straddle it.
  //
  // A trigger rather than three call-site inserts: it cannot be forgotten by a
  // future write path, and it captures the real before/after from the row itself.
  'CREATE TABLE IF NOT EXISTS base_price_audit (' +
    'id BIGSERIAL PRIMARY KEY, mbo_id BIGINT REFERENCES mbo(id), key TEXT NOT NULL,' +
    'brand TEXT, url TEXT, old_base DOUBLE PRECISION, new_base DOUBLE PRECISION,' +
    'old_base_usd DOUBLE PRECISION, new_base_usd DOUBLE PRECISION, source TEXT,' +
    'changed_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_bpa_mbo_key ON base_price_audit(mbo_id, key)',
  'CREATE INDEX IF NOT EXISTS ix_bpa_mbo_changed ON base_price_audit(mbo_id, changed_at DESC)',

  // ---- integration audit (BUG-012) ----
  // Shopify token/domain changes previously overwrote silently — no record of
  // who changed what or what the prior value was, so a compromised admin
  // account leaves no forensic trail. Values are masked (last 4 chars) before
  // they ever reach this table.
  'CREATE TABLE IF NOT EXISTS integration_audit (' +
    'id BIGSERIAL PRIMARY KEY, mbo_id BIGINT REFERENCES mbo(id), action TEXT,' +
    'field TEXT, old_value_masked TEXT, new_value_masked TEXT,' +
    'changed_by_email TEXT, changed_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_integration_audit_mbo ON integration_audit(mbo_id, changed_at DESC)',

  // AFTER UPDATE OF base_price: a pipeline run never lists that column in its
  // SET, so runs cost nothing here. `app.base_source` is set by the write path
  // when it can (see promoteLiveToBase); anything else records "unknown" rather
  // than guessing.
  `CREATE OR REPLACE FUNCTION mbo_log_base_change() RETURNS trigger AS $fn$
   BEGIN
     IF NEW.base_price IS DISTINCT FROM OLD.base_price THEN
       INSERT INTO base_price_audit (mbo_id,key,brand,url,old_base,new_base,old_base_usd,new_base_usd,source)
       VALUES (NEW.mbo_id, NEW.key, NEW.brand, NEW.url, OLD.base_price, NEW.base_price,
               OLD.base_usd, NEW.base_usd,
               COALESCE(NULLIF(current_setting('app.base_source', true), ''), 'unknown'));
     END IF;
     RETURN NULL;
   END;
   $fn$ LANGUAGE plpgsql`,
  'DROP TRIGGER IF EXISTS trg_products_base_audit ON products',
  'CREATE TRIGGER trg_products_base_audit AFTER UPDATE OF base_price ON products' +
    ' FOR EACH ROW EXECUTE FUNCTION mbo_log_base_change()',

  // One-off backfill so the page is not empty on day one: every base change
  // that consecutive runs already witnessed. Marked "observed" because the
  // timestamp is when a RUN SAW the new value, not when it was written, and
  // a change made and undone between two runs is invisible to it.
  `INSERT INTO base_price_audit (mbo_id,key,brand,url,old_base,new_base,source,changed_at)
   SELECT mbo_id, key, brand, url, prev, base_price, 'observed', created_at FROM (
     SELECT mbo_id, key, brand, url, base_price, created_at,
            LAG(base_price) OVER (PARTITION BY mbo_id, key ORDER BY created_at) AS prev
       FROM price_history WHERE base_price IS NOT NULL) t
    WHERE prev IS NOT NULL AND prev <> base_price
      AND NOT EXISTS (SELECT 1 FROM base_price_audit WHERE source = 'observed')`,

  // ---- pipeline run bookend (BUG-016, Decision-002) ----
  // All pipeline state otherwise lives only in the in-memory ENGINES map — a
  // Render spin-down/OOM/deploy mid-run silently loses all progress with no
  // record it ever happened. This is the lightweight bookend, not full
  // DB-backed resumable state (that's the deferred "full" fix in the doc):
  // one row per run, 'running' at start, 'completed'/'interrupted' at end,
  // and any row still 'running' after an unclean restart gets swept to
  // 'interrupted' on the next boot (see markStaleRunsInterrupted()).
  'CREATE TABLE IF NOT EXISTS pipeline_runs (' +
    'id BIGSERIAL PRIMARY KEY, mbo_id BIGINT REFERENCES mbo(id), status TEXT NOT NULL DEFAULT \'running\',' +
    'started_by BIGINT, started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ,' +
    'total INT, matched INT, errors INT)',
  'CREATE INDEX IF NOT EXISTS ix_pipeline_runs_mbo ON pipeline_runs(mbo_id, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS ix_pipeline_runs_running ON pipeline_runs(status) WHERE status=\'running\'',

  // ---- mail queue (BUG-015, Decision-003) ----
  // deliver() threw on provider errors and the pipeline's mailLog() only
  // logged it — a transient SMTP/API outage (common on Render, where plain
  // SMTP is blocked outright) permanently lost the completion report. Queued
  // here instead; a background worker (mailer.js#startMailQueueWorker)
  // retries every 5 minutes, up to 3 attempts, before giving up as 'failed'.
  'CREATE TABLE IF NOT EXISTS mail_queue (' +
    'id BIGSERIAL PRIMARY KEY, mbo_id BIGINT REFERENCES mbo(id), recipient TEXT NOT NULL,' +
    'subject TEXT, body_json JSONB NOT NULL, attempt INT NOT NULL DEFAULT 0,' +
    'last_error TEXT, next_retry_at TIMESTAMPTZ DEFAULT now(),' +
    'status TEXT NOT NULL DEFAULT \'pending\', created_at TIMESTAMPTZ DEFAULT now())',
  'CREATE INDEX IF NOT EXISTS ix_mail_queue_pending ON mail_queue(next_retry_at) WHERE status=\'pending\'',

  // ---- ON DELETE CASCADE for every mbo(id) FK (BUG-017, Decision-005) ----
  // Every mbo_id FK above was added inline (ADD COLUMN ... REFERENCES mbo(id))
  // with no ON DELETE rule, so deleting a tenant left every one of its rows
  // behind — including encrypted Shopify tokens in `integrations`. A future
  // restore that reused the same auto-incremented mbo_id could then hand a
  // new tenant another tenant's orphaned credentials.
  //
  // Guarded by confdeltype <> 'c' (not already CASCADE) rather than an
  // unconditional drop+recreate on every boot: ADD CONSTRAINT on a FK
  // re-validates every existing row, which would otherwise re-scan
  // `products`/`price_history` in full on every single restart forever, not
  // just once. No pre-migration orphan cleanup needed: every table here was
  // already backfilled to mbo_id=1 before the original FK went on (see Phase
  // A above), so there is no existing row whose mbo_id fails to reference a
  // real mbo — a pre-existing orphan is provably not possible in this data.
  //
  // Deliberately CASCADE only, not the NOT NULL / RLS parts of the original
  // BUG-017 writeup — Decision-005 scoped those out to the later Phase D
  // pass (RLS in particular needs the dedicated BYPASSRLS role that doesn't
  // exist yet, see db.js's withSuperAdmin).
  `DO $$
   DECLARE t text;
   BEGIN
     FOREACH t IN ARRAY ARRAY['products','import_catalog','price_history','review_history',
       'integrations','meta','mismatch','error','resolved','base_price_audit',
       'integration_audit','pipeline_runs','mail_queue']
     LOOP
       IF EXISTS (
         SELECT 1 FROM pg_constraint c
         JOIN pg_class rel ON rel.oid = c.conrelid
         WHERE rel.relname = t AND c.contype = 'f' AND c.confrelid = 'mbo'::regclass
           AND c.confdeltype <> 'c'
       ) THEN
         -- Isolated per table: one unexpected constraint name or a genuine
         -- orphaned row (re-validated by ADD CONSTRAINT) must not abort the
         -- whole boot-time migration for every OTHER table.
         BEGIN
           EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_mbo_id_fkey');
           EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (mbo_id) REFERENCES mbo(id) ON DELETE CASCADE', t, t || '_mbo_id_fkey');
         EXCEPTION WHEN OTHERS THEN
           RAISE WARNING 'BUG-017: could not add ON DELETE CASCADE to %.mbo_id: %', t, SQLERRM;
         END;
       END IF;
     END LOOP;
   END $$;`,
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
// Owner instruction 2026-08-19: tolerance removed -- any non-zero difference
// (down to rounding) is a mismatch now, not just anything past 0.5%/$1.
export function matchTol() { return 0; }
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
const _usdConvertCache = new Map();
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

// ---- per-brand USD-CONVERT (Decision-006) ----
// Distinct from usd_fetch_brand_set: that set REQUESTS USD from the site
// itself (?wmc-currency=USD) and fails loud if the site can't serve it — only
// right for a brand with a genuine USD storefront. Most brands here have none
// (plain INR designer sites, no currency switcher) — this set instead fetches
// the NATIVE price as normal, then converts it to USD via fx.js for the
// baseline/live-price/push comparison, same math brand-live-prices.mjs
// already uses for its offline USD sheets. A brand in native_currency_brands
// or usd_fetch_brand_set should not also be in this set — finalizeOne()
// checks those first and returns before reaching the convert branch.
export async function usdConvertBrandSet(mboId) {
  const cached = _usdConvertCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "usd_convert_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _usdConvertCache.set(mboId, { at: Date.now(), set });
  return set;
}
export async function setUsdConvertBrands(mboId, list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta(mboId, "usd_convert_brands", uniq.join(","));
  _usdConvertCache.delete(mboId);
  return uniq;
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
// EMPTY BY DEFAULT — every brand is fetched directly on cloud runs.
//
// mymoledro.com and labelanushree.com were both here on the theory that their
// sites refuse non-India IPs. Neither does. Each prices by the country the
// request ASKS for, and each is pinned to India by a URL param instead
// (?country=IN and ?wcpbc-manual-country=IN — see DEFAULT_APPEND_PARAMS), which
// works from any egress. mymoledro's later HTTP 400s were the relay refusing a
// host missing from its own allowlist, not the store refusing us.
//
// The machinery is intact for the next site that genuinely IP-blocks: adding a
// brand here means "relay it on cloud runs, or skip it if no relay is set", and
// a meta entry does that without a deploy.
const DEFAULT_LOCAL_ONLY_BRANDS = new Set([]);
// These meta lists UNION the code defaults, so a hard-coded default could not be
// removed by configuration at all — labelanushree/mymoledro could never be
// brought into the normal cloud pool without editing source. An entry prefixed
// "-" now REMOVES a brand, including a default, so the behaviour is adjustable
// in both directions and revertible without a deploy. Plain entries still add,
// so every existing value keeps its current meaning.
//   e.g. "-mymoledro.com"  -> drop that brand from the set
//        "acme.com"        -> add it (unchanged)
export function brandSetFrom(defaults, raw) {
  const set = new Set(defaults);
  for (const tok of String(raw || "").split(",")) {
    const t = tok.trim();
    if (!t) continue;
    if (t.startsWith("-")) set.delete(normBrand(t.slice(1)));
    else { const b = normBrand(t); if (b) set.add(b); }
  }
  return set;
}
export async function localOnlyBrandSet(mboId) {
  const cached = _localOnlyCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "local_only_brands", "");
  const set = brandSetFrom(DEFAULT_LOCAL_ONLY_BRANDS, raw);
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
// Skipped on cloud runs REGARDLESS of the relay and refreshed solely from a
// local run. Superset-safe: they're also in local-only, so local runs fetch them.
//
// EMPTY BY DEFAULT. It briefly held mymoledro.com on the belief that Render's
// egress was being rejected: a cloud run put HTTP 400 on all 44 of its rows.
// That 400 was OURS, not the store's — the relay worker answers a host outside
// its ALLOWED_HOSTS with 400 (deliberately, so the 403-backoff ignores a config
// error), mymoledro.com was not on that list, and the brand was local-only at
// the time, so every row was routed through the relay and refused before the
// request ever left Cloudflare. Adding the host to web/relay/wrangler.toml
// fixed it. READ THIS BEFORE BLAMING A SITE for a uniform 400 on one brand.
//
// labelanushree.com was REMOVED from both default lists on request: its geo
// lever (?wcpbc-manual-country=IN, see DEFAULT_APPEND_PARAMS) is meant to hold
// the INR baseline from any IP, so it now runs in the normal cloud pool. That
// is not yet confirmed from Render's own egress — if its rows start coming back
// as currency-mismatch errors or USD, put "labelanushree.com" back here and in
// DEFAULT_LOCAL_ONLY_BRANDS (or add "labelanushree.com" to either meta list,
// which needs no deploy) and refresh it locally.
const DEFAULT_CLOUD_SKIP_BRANDS = new Set([]);
export async function cloudSkipBrandSet(mboId) {
  const cached = _cloudSkipCache.get(mboId);
  if (cached && Date.now() - cached.at < 30_000) return cached.set;
  const raw = await getMeta(mboId, "cloud_skip_brands", "");
  // "-brand.com" removes, including these defaults — see brandSetFrom.
  const set = brandSetFrom(DEFAULT_CLOUD_SKIP_BRANDS, raw);
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

// BUG-021: resolves a brand to the currency its base_price/base_usd is
// actually denominated in — a native-currency brand's own currency, a
// USD-fetch brand's USD, otherwise INR. Computed once per import/add batch
// and reused per-row rather than re-querying meta per product.
export async function baseCurrencyResolver(mboId) {
  const [native, usd] = await Promise.all([nativeCurrencyBrands(mboId), usdFetchBrandSet(mboId)]);
  return (brand) => {
    const nb = normBrand(brand);
    return native[nb] || (usd.has(nb) ? "USD" : "INR");
  };
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
  const isUsd = !isNative && curUp === "USD";
  return {
    baseNew,
    baseUsd: isUsd ? Number(prow.live_price) : null,
    // BUG-021: the currency this promoted baseline is actually denominated
    // in — feeds products.base_currency so matchTol() no longer has to infer
    // tolerance scale from whatever currency the triggering fetch happened
    // to return.
    baseCurrency: isNative ? nativeCur : (isUsd ? "USD" : "INR"),
    statusLabel: `Price Matched (${isNative ? nativeCur : "INR"})`,
  };
}

export async function promoteLiveToBase(mboId, run, prow) {
  if (!prow?.key) return null;
  const next = await liveBaseValue(mboId, prow);
  if (!next) return null;
  // Labels the audit row the trigger is about to write. `true` scopes it to the
  // surrounding transaction; a no-op if this runner isn't in one.
  try { await run("SELECT set_config('app.base_source','shopify_push',true)", []); } catch {}
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await run(`UPDATE products SET base_price=$1, base_usd=$2, base_currency=$3, state='matched',
      status=$4, delta=0, updated_at=$5 WHERE mbo_id=$6 AND key=$7`,
    [next.baseNew, next.baseUsd, next.baseCurrency, next.statusLabel, now, mboId, prow.key]);
  await run("UPDATE import_catalog SET base_price=$1 WHERE mbo_id=$2 AND key=$3", [next.baseNew, mboId, prow.key]);
  return { base_price: next.baseNew, base_usd: next.baseUsd, base_currency: next.baseCurrency, status: next.statusLabel };
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

// ---- base price history ----
// One row per product: what base_price is NOW, plus when it last moved and how
// often. LEFT JOIN, so a product that has never been re-based still lists with
// its imported baseline and a null date — "never changed" is the answer to the
// question being asked, not a row to hide.
export async function basePriceList(mboId, { brands, search, changedOnly, limit = 400, offset = 0 } = {}) {
  const p = [mboId]; const cl = ["p.mbo_id = $1"];
  if (brands && brands.length) { p.push(brands); cl.push(`p.brand = ANY($${p.length}::text[])`); }
  if (search) { p.push(`%${search}%`); cl.push(`(p.url ILIKE $${p.length} OR p.brand ILIKE $${p.length})`); }
  // The stat tiles count the brand/search scope only. Folding "changed only"
  // into them would make the totals restate the filter — "never changed: 0" —
  // instead of the split the tiles exist to show.
  const scope = [...cl];
  const scopeParams = [...p];
  if (changedOnly) cl.push("a.changes > 0");
  p.push(limit, offset);
  return withTenant(mboId, async (db) => {
    const rows = await db.q(`SELECT p.key, p.brand, p.url, p.base_price, p.base_usd, p.currency,
        p.live_price, p.status, a.changes, a.last_at, a.last_old, a.last_new, a.last_source
      FROM products p
      LEFT JOIN (
        SELECT key, COUNT(*) AS changes, MAX(changed_at) AS last_at,
               (ARRAY_AGG(old_base ORDER BY changed_at DESC))[1] AS last_old,
               (ARRAY_AGG(new_base ORDER BY changed_at DESC))[1] AS last_new,
               (ARRAY_AGG(source   ORDER BY changed_at DESC))[1] AS last_source
          FROM base_price_audit WHERE mbo_id = $1 GROUP BY key
      ) a ON a.key = p.key
      WHERE ${cl.join(" AND ")}
      ORDER BY a.last_at DESC NULLS LAST, p.brand, p.key
      LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    const tot = await db.one(`SELECT COUNT(*) AS n,
        COUNT(*) FILTER (WHERE a.changes > 0) AS changed
      FROM products p LEFT JOIN (SELECT key, COUNT(*) AS changes FROM base_price_audit
        WHERE mbo_id = $1 GROUP BY key) a ON a.key = p.key
      WHERE ${scope.join(" AND ")}`, scopeParams);
    return { items: rows, total: num(tot?.n), changed: num(tot?.changed) };
  });
}

// Full trail for one product, newest first.
export async function basePriceTrail(mboId, key) {
  return withTenant(mboId, (db) => db.q(
    `SELECT old_base, new_base, old_base_usd, new_base_usd, source, changed_at
       FROM base_price_audit WHERE mbo_id = $1 AND key = $2
      ORDER BY changed_at DESC LIMIT 200`, [mboId, key]));
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
// Masks a secret/domain value to its last 4 characters for the audit trail —
// enough to spot-check "did this change" without storing the value itself.
const maskValue = (v) => v ? `...${String(v).slice(-4)}` : "";
export async function logIntegrationChange(mboId, { action, field, oldValue, newValue, changedByEmail }) {
  await withTenant(mboId, (db) => db.client.query(
    `INSERT INTO integration_audit (mbo_id,action,field,old_value_masked,new_value_masked,changed_by_email)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [mboId, action, field, maskValue(oldValue), maskValue(newValue), changedByEmail || null]));
}
export async function getIntegrationAudit(mboId) {
  return withTenant(mboId, (db) => db.q(
    "SELECT action, field, old_value_masked, new_value_masked, changed_by_email, changed_at FROM integration_audit WHERE mbo_id=$1 ORDER BY changed_at DESC LIMIT 200", [mboId]));
}
export async function integrationBrands(mboId) {
  const brands = await withTenant(mboId, (db) => db.q(`SELECT brand, COUNT(*) c, COUNT(*) FILTER (WHERE state='mismatch') m
    FROM products WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY c DESC`, [mboId]));
  return brands.map((b) => ({ brand: b.brand, products: num(b.c), mismatches: num(b.m) }));
}

// ---- import sheet (xlsx/csv) ----
function rowToProduct(r, idx) {
  const url = canonicalUrl(String(r["Designer Product URL"] || "").trim());
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
// ---- base-price-only sheet ----
// A hand-made 2-column sheet (product URL + new base price) that rewrites
// base_price and NOTHING else. Deliberately separate from importSheet, which
// syncs the whole catalog and can delete rows: the whole point here is that a
// sheet of 5 corrected baselines cannot touch the other 8,929 products.
//
// Headers are matched loosely because the sheet is typed by hand — "URL",
// "Product URL", "Designer Product URL" and "Link" all mean the same thing,
// and a sheet that fails on a header spelling just gets retyped until it
// passes, which teaches nothing and wastes a round trip.
const BASE_URL_HEADERS = ["designer product url", "product url", "designer url", "url", "link", "product", "product link"];
const BASE_PRICE_HEADERS = ["new base price", "base price", "studio east price", "base", "price", "base_price", "new base", "new price"];
const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/[\s_]+/g, " ");

function pickHeader(cols, wanted) {
  const norm = cols.map((c) => [c, normHeader(c)]);
  for (const w of wanted) { const hit = norm.find(([, n]) => n === w); if (hit) return hit[0]; }
  // Fall back to a containment match so "Designer Product URL (live)" still works.
  for (const w of wanted) { const hit = norm.find(([, n]) => n.includes(w)); if (hit) return hit[0]; }
  return null;
}

export function parseBaseSheet(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const cols = raw.length ? Object.keys(raw[0]) : [];
  const urlCol = pickHeader(cols, BASE_URL_HEADERS);
  // The price column must not resolve to the URL column when a sheet is headed
  // e.g. "Product URL" / "Product" — exclude whatever the URL match consumed.
  const priceCol = pickHeader(cols.filter((c) => c !== urlCol), BASE_PRICE_HEADERS);
  if (!urlCol || !priceCol) {
    throw new Error(`sheet needs a URL column and a base price column — found: ${cols.join(", ") || "(no columns)"}`);
  }
  const rows = raw.map((r, i) => {
    const url = String(r[urlCol] || "").trim();
    const base_price = sanitizeNum(r[priceCol]);
    let _error = null;
    if (!url) _error = "no URL";
    // A blank price means "leave this one alone", not an error: a sheet is
    // usually a full export with only a few cells filled in.
    else if (String(r[priceCol]).trim() === "") _error = "blank price (skipped)";
    else if (base_price == null || base_price <= 0) _error = `not a valid price: "${r[priceCol]}"`;
    return { row: i + 2, url, base_price, _error };
  });
  return { urlCol, priceCol, rows };
}

// Matches sheet URLs to products and reports what WOULD change. Never writes.
// Matching is on canonicalUrl so a pasted link carrying ?wmc-currency= or a
// tracking param still finds its row.
export async function previewBaseSheet(mboId, buf) {
  const { urlCol, priceCol, rows } = parseBaseSheet(buf);
  const usable = rows.filter((r) => !r._error);
  const skipped = rows.filter((r) => r._error);
  const prods = await withTenant(mboId, (db) =>
    db.q("SELECT key, url, brand, base_price FROM products WHERE mbo_id=$1", [mboId]));
  const byUrl = new Map();
  for (const p of prods) {
    const c = canonicalUrl(p.url).replace(/\/+$/, "").toLowerCase();
    if (!byUrl.has(c)) byUrl.set(c, p);
  }
  const matched = [], unmatched = [];
  const seen = new Set();
  for (const r of usable) {
    const c = canonicalUrl(r.url).replace(/\/+$/, "").toLowerCase();
    const p = byUrl.get(c);
    if (!p) { unmatched.push({ row: r.row, url: r.url, base_price: r.base_price }); continue; }
    // A sheet listing the same URL twice would apply twice with the last write
    // winning silently — surface it instead.
    if (seen.has(p.key)) { unmatched.push({ row: r.row, url: r.url, base_price: r.base_price, reason: "duplicate URL in sheet" }); continue; }
    seen.add(p.key);
    matched.push({ row: r.row, key: p.key, url: p.url, brand: p.brand,
      old_base: p.base_price, new_base: r.base_price,
      changed: Number(p.base_price) !== Number(r.base_price) });
  }
  return { urlCol, priceCol, total: rows.length,
    matched, unmatched, skipped: skipped.map((r) => ({ row: r.row, url: r.url, reason: r._error })),
    will_change: matched.filter((m) => m.changed).length };
}

// Applies the matched rows. Unmatched URLs are never inserted — a typo would
// otherwise become a permanent product that fails every run.
export async function applyBaseSheet(mboId, buf) {
  const pre = await previewBaseSheet(mboId, buf);
  const changes = pre.matched.filter((m) => m.changed);
  if (!changes.length) return { ...pre, updated: 0 };
  await withTenant(mboId, async (db) => {
    // Labels the audit rows the base_price trigger writes, so the Base Price
    // page shows "Sheet update" rather than "unknown" for every one of these.
    await db.client.query("SELECT set_config('app.base_source','sheet_base',true)");
    for (const c of changes) {
      await db.client.query(
        "UPDATE products SET base_price=$1, updated_at=$2 WHERE mbo_id=$3 AND key=$4",
        [c.new_base, new Date().toISOString().slice(0, 19).replace("T", " "), mboId, c.key]);
      await db.client.query("UPDATE import_catalog SET base_price=$1 WHERE mbo_id=$2 AND key=$3",
        [c.new_base, mboId, c.key]);
    }
  });
  return { ...pre, updated: changes.length };
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
    const url = canonicalUrl(String(r["Designer Product URL"] || "").trim());
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

// Identity of a product for add/dedupe purposes: the designer URL, canonical
// (fetch-time params stripped), trailing slash and case normalised. Anything
// that reduces to the same string is the same product.
export const productIdentity = (url) => canonicalUrl(String(url || "").trim()).replace(/\/+$/, "").toLowerCase();

const cleanAddRows = (rows) => (rows || [])
  .map((r) => ({
    url: String(r.url || "").trim(),
    mbo_url: String(r.mbo_url || "").trim(),
    platform: String(r.platform || "").trim(),
    custom_regex: String(r.custom_regex || "").trim(),
    base_price: r.base_price === "" || r.base_price == null ? null : Number(r.base_price),
  }))
  .filter((r) => r.url && Number.isFinite(r.base_price) && r.base_price > 0);

// Sorts an incoming sheet against what is already tracked, WITHOUT writing.
//
// addProducts used to insert unconditionally with a freshly generated key, so
// it could never see an existing row: re-uploading an overlapping sheet stacked
// copies, and 1,112 URLs ended up duplicated (1,157 extra rows, ~13% of the
// catalog) — every one of them re-fetched on every run and shown several times
// in Review.
//
//   new       — designer URL not tracked yet          -> insert
//   unchanged — tracked, and mbo_url + base_price agree -> do nothing
//   differs   — tracked, but mbo_url and/or base_price disagree -> opt-in only
//
// A BLANK mbo_url in the sheet is "no opinion", not a request to clear the one
// on record — a sheet that only carries designer URLs must not wipe MBO URLs.
export async function classifyProductRows(mboId, rows) {
  const clean = cleanAddRows(rows);
  const invalid = (rows || []).length - clean.length;
  const existing = await withTenant(mboId, (db) =>
    db.q("SELECT key, url, mbo_url, base_price, brand FROM products WHERE mbo_id=$1", [mboId]));
  const byId = new Map();
  for (const p of existing) {
    const id = productIdentity(p.url);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(p);
  }
  const fresh = [], unchanged = [], differs = [];
  const seen = new Set();
  for (const r of clean) {
    const id = productIdentity(r.url);
    const hits = byId.get(id);
    if (!hits) {
      // A URL listed twice in one sheet is one product, not two — otherwise the
      // upload reintroduces exactly the duplication this function exists to stop.
      if (seen.has(id)) continue;
      seen.add(id);
      fresh.push({ ...r, brand: brandOf(r.url) });
      continue;
    }
    const cur = hits[0];
    const mboChanged = !!r.mbo_url && String(r.mbo_url).trim() !== String(cur.mbo_url || "").trim();
    const priceChanged = Number(cur.base_price) !== Number(r.base_price);
    if (!mboChanged && !priceChanged) {
      unchanged.push({ url: cur.url, brand: cur.brand, base_price: cur.base_price, copies: hits.length });
    } else {
      differs.push({ url: cur.url, brand: cur.brand, copies: hits.length,
        // Exact keys of every copy — the update targets these rather than
        // re-matching on URL text, which duplicate copies can spell differently
        // (one carrying a query param, another not).
        keys: hits.map((h) => h.key),
        old_base: cur.base_price, new_base: r.base_price, price_changed: priceChanged,
        old_mbo_url: cur.mbo_url || "", new_mbo_url: mboChanged ? r.mbo_url : "", mbo_changed: mboChanged });
    }
  }
  return { new: fresh, unchanged, differs, invalid };
}

// Inserts the genuinely new rows. Existing products are left alone unless
// applyDiffs is set, and even then only the fields that actually disagree move.
export async function addProducts(mboId, rows, { applyDiffs = false } = {}) {
  const cls = await classifyProductRows(mboId, rows);
  if (!cls.new.length && !(applyDiffs && cls.differs.length)) {
    return { added: 0, updated: 0, unchanged: cls.unchanged.length, differs: cls.differs.length };
  }
  const currencyOf = await baseCurrencyResolver(mboId);
  return withTenant(mboId, async (db) => {
    let idx = num((await db.client.query(
      "SELECT COALESCE(MAX(split_part(key,'|',1)::int),0) m FROM products WHERE mbo_id=$1", [mboId]
    )).rows[0].m);
    let added = 0;
    for (const r of cls.new) {
      idx += 1;
      const key = `${String(idx).padStart(5, "0")}|${r.url.slice(0, 280)}`;
      const brand = brandOf(r.url);
      const result = await db.client.query(
        `INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,base_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (mbo_id,key) DO NOTHING`,
        [mboId, key, r.mbo_url, r.url, r.platform, r.custom_regex, brand, r.base_price, currencyOf(brand)]
      );
      added += result.rowCount;
    }
    let updated = 0;
    if (applyDiffs && cls.differs.length) {
      // Labels the audit rows the base_price trigger writes.
      await db.client.query("SELECT set_config('app.base_source','sheet_add',true)");
      for (const d of cls.differs) {
        // Every copy of a duplicated URL is updated, not just the first —
        // leaving the others behind would make the same product disagree
        // with itself across Review rows.
        const sets = [], params = [];
        if (d.price_changed) { params.push(d.new_base); sets.push(`base_price=$${params.length}`); }
        if (d.mbo_changed) { params.push(d.new_mbo_url); sets.push(`mbo_url=$${params.length}`); }
        if (!sets.length) continue;
        params.push(mboId, d.keys);
        const r = await db.client.query(
          `UPDATE products SET ${sets.join(",")}
           WHERE mbo_id=$${params.length - 1} AND key = ANY($${params.length}::text[])`, params);
        updated += r.rowCount;
      }
    }
    return { added, updated, unchanged: cls.unchanged.length, differs: cls.differs.length };
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
  const currencyOf = await baseCurrencyResolver(mboId);
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
        const b = j * 10;
        importPh.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
        importVals.push(mboId, p.key, p.mbo_url, p.url, p.platform, p.custom_regex,
          p.brand, p.base_price, now, currencyOf(p.brand));
      });
      await db.client.query(`INSERT INTO import_catalog
        (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,imported_at,base_currency)
        VALUES ${importPh.join(',')}
        ON CONFLICT(mbo_id,key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
          platform=excluded.platform,custom_regex=excluded.custom_regex,
          brand=excluded.brand,base_price=excluded.base_price,
          imported_at=excluded.imported_at,base_currency=excluded.base_currency`, importVals);
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
    await db.client.query(`INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,base_currency)
      SELECT mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price,base_currency FROM import_catalog
      WHERE mbo_id=$1
      ON CONFLICT(mbo_id,key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
        platform=COALESCE(NULLIF(excluded.platform,''), products.platform),
        custom_regex=COALESCE(NULLIF(excluded.custom_regex,''), products.custom_regex),
        brand=excluded.brand,base_price=excluded.base_price,base_currency=excluded.base_currency`, [mboId]);
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

// ---- pipeline run bookend (BUG-016) ----
export async function startPipelineRun(mboId, startedBy) {
  const row = await withTenant(mboId, (db) => db.one(
    "INSERT INTO pipeline_runs (mbo_id, started_by) VALUES ($1,$2) RETURNING id", [mboId, startedBy || null]));
  return row.id;
}
export async function finishPipelineRun(mboId, runDbId, { status, total, matched, errors }) {
  if (runDbId == null) return;
  await withTenant(mboId, (db) => db.q(
    `UPDATE pipeline_runs SET status=$1, finished_at=now(), total=$2, matched=$3, errors=$4
     WHERE id=$5 AND mbo_id=$6`, [status, total ?? null, matched ?? null, errors ?? null, runDbId, mboId]));
}
// Called once at server startup: any row still 'running' belongs to a
// process that died without reaching finishPipelineRun (crash, OOM, deploy)
// — a real in-progress run only exists as long as its own process does, so
// EVERY 'running' row at boot is, by definition, orphaned. Cross-tenant by
// nature (a boot-time sweep, not a request scoped to one mbo).
export async function markStaleRunsInterrupted() {
  const r = await pool.query(`UPDATE pipeline_runs SET status='interrupted', finished_at=now()
    WHERE status='running' RETURNING id, mbo_id`);
  return r.rows;
}
export async function recentPipelineRuns(mboId, limit = 10) {
  return withTenant(mboId, (db) => db.q(
    `SELECT id, status, started_at, finished_at, total, matched, errors FROM pipeline_runs
     WHERE mbo_id=$1 ORDER BY started_at DESC LIMIT $2`, [mboId, limit]));
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
