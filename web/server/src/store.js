import * as XLSX from "xlsx";
import { q, one, pool } from "./db.js";
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
];

export async function initStore() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('mbo_tracker_schema_v1'))`);
      for (const sql of SCHEMA) await client.query(sql);
      return;
    } catch (error) {
      if (error.code !== '40P01' || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('mbo_tracker_schema_v1'))`)
        .catch(() => {});
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

// ---- meta ----
export async function setMeta(k, v) {
  await q("INSERT INTO meta(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
    [k, String(v)]);
}
export async function getMeta(k, def = null) {
  const r = await one("SELECT v FROM meta WHERE k=$1", [k]);
  return r ? r.v : def;
}

// ---- counts / insights ----
// `total` is the real catalog size (dismissing a review row never shrinks
// it) — only the state-bucket counts that back the Review tabs/badges
// exclude dismissed rows, since dismissing is scoped to "stop showing me
// this in Review", not "stop counting this product".
export async function counts(brand) {
  const where = brand ? "WHERE brand=$1" : "";
  const params = brand ? [brand] : [];
  const r = await one(`SELECT COUNT(*) total,
    COUNT(*) FILTER (WHERE state='pending' AND review_dismissed_at IS NULL) pending,
    COUNT(*) FILTER (WHERE state='matched' AND review_dismissed_at IS NULL) matched,
    COUNT(*) FILTER (WHERE state='mismatch' AND review_dismissed_at IS NULL) mismatch,
    COUNT(*) FILTER (WHERE state='error' AND review_dismissed_at IS NULL) error,
    COUNT(*) FILTER (WHERE decision='approved') approved,
    COUNT(*) FILTER (WHERE state='mismatch' AND decision='pending' AND review_dismissed_at IS NULL) awaiting,
    COUNT(*) FILTER (WHERE state='error' AND decision='pending' AND review_dismissed_at IS NULL) error_awaiting,
    COUNT(*) FILTER (WHERE state='matched' AND decision='pending' AND review_dismissed_at IS NULL) resolved_awaiting,
    COUNT(*) FILTER (WHERE decision='rejected') rejected FROM products ${where}`, params);
  const o = {}; for (const k of Object.keys(r)) o[k] = num(r[k]); return o;
}

let _alertCache = { at: 0, threshold: null, value: 0 };
export async function alertCount(threshold = 5) {
  const now = Date.now();
  if (now - _alertCache.at < 60_000 && _alertCache.threshold === threshold) return _alertCache.value;
  try {
    const r = await one(`SELECT COUNT(*) c FROM (
      SELECT live_price, prev FROM (
        SELECT live_price,
          LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) prev,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) rn
        FROM price_history WHERE live_price IS NOT NULL
      ) t WHERE rn=1 AND prev IS NOT NULL AND prev<>0
        AND ABS((live_price-prev)/prev*100) >= $1) z`, [Math.abs(threshold)]);
    const value = num(r.c);
    _alertCache = { at: now, threshold, value };
    return value;
  } catch { return 0; }
}

// ---- vendors ----
export async function vendors(kind, source = 'database') {
  if (source === 'imported' && !kind) {
    const rows = await q(`SELECT brand, COUNT(*) c FROM import_catalog
      WHERE brand<>'' GROUP BY brand ORDER BY brand`);
    return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
  }
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind];
  const rows = state
    ? await q("SELECT brand, COUNT(*) c FROM products WHERE brand<>'' AND state=$1 GROUP BY brand ORDER BY brand", [state])
    : await q("SELECT brand, COUNT(*) c FROM products WHERE brand<>'' GROUP BY brand ORDER BY brand");
  return rows.map((r) => ({ vendor: r.brand, count: num(r.c) }));
}

// ---- products work list (DB source) ----
export async function dbProducts(mode = "fresh", vendorList = null) {
  const cl = []; const p = [];
  if (mode !== "fresh") cl.push("state IN ('pending','error')");
  if (vendorList && vendorList.length) {
    cl.push(`brand IN (${vendorList.map((_, i) => `$${i + 1}`).join(",")})`);
    p.push(...vendorList);
  }
  const where = cl.length ? "WHERE " + cl.join(" AND ") : "";
  return q(`SELECT key,mbo_url,url,platform,custom_regex,brand,base_price,base_usd,state
            FROM products ${where} ORDER BY id`, p);
}
export async function countProducts(vendorList = null) {
  if (vendorList && vendorList.length) {
    const r = await one(`SELECT COUNT(*) c FROM products WHERE brand IN (${vendorList.map((_, i) => `$${i + 1}`).join(",")})`, vendorList);
    return num(r.c);
  }
  return num((await one("SELECT COUNT(*) c FROM products")).c);
}

export async function importedProducts(mode = 'fresh', vendorList = null) {
  const clauses = []; const params = [];
  if (vendorList && vendorList.length) {
    clauses.push(`c.brand IN (${vendorList.map((_, i) => `$${i + 1}`).join(',')})`);
    params.push(...vendorList);
  }
  if (mode !== 'fresh') clauses.push(`COALESCE(p.state, 'pending') IN ('pending','error')`);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return q(`SELECT c.key,c.mbo_url,c.url,c.platform,c.custom_regex,c.brand,c.base_price,
      p.base_usd, COALESCE(p.state,'pending') state
    FROM import_catalog c LEFT JOIN products p ON p.key=c.key
    ${where} ORDER BY c.key`, params);
}

export async function countImported(vendorList = null) {
  if (vendorList && vendorList.length) {
    const placeholders = vendorList.map((_, i) => `$${i + 1}`).join(',');
    return num((await one(`SELECT COUNT(*) c FROM import_catalog
      WHERE brand IN (${placeholders})`, vendorList)).c);
  }
  return num((await one('SELECT COUNT(*) c FROM import_catalog')).c);
}

export async function workRows(mode = "fresh", vendorList = null, source = 'database') {
  return source === 'imported'
    ? importedProducts(mode, vendorList)
    : dbProducts(mode, vendorList);
}

// ---- pipeline result write (+ history snapshot) ----
export async function saveResult(prod, status, live, cur, state, runId, extra = {}) {
  const base = prod.base_price;
  const usdBaseline = extra.usdBaseline === true;
  const baseUsd = usdBaseline ? (prod.base_usd != null ? prod.base_usd : live) : null;
  const delta = usdBaseline
    ? ((live != null && baseUsd != null) ? live - baseUsd : null)
    : ((live != null && base != null) ? (await toInr(live, cur)) - base : null);
  const baseUsdVal = usdBaseline ? live : null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const cleanUrl = canonicalUrl(prod.url);
  await q(`INSERT INTO products (key,mbo_url,url,platform,custom_regex,brand,base_price,
      live_price,currency,status,state,delta,decision,decided_at,updated_at,base_usd)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NULL,$13,$14)
    ON CONFLICT(key) DO UPDATE SET url=excluded.url,live_price=excluded.live_price,currency=excluded.currency,
      status=excluded.status,state=excluded.state,delta=excluded.delta,
      decision='pending',decided_at=NULL,updated_at=excluded.updated_at,
      base_usd=COALESCE(products.base_usd,excluded.base_usd),review_dismissed_at=NULL`,
    [prod.key, prod.mbo_url || "", cleanUrl, prod.platform, prod.custom_regex, prod.brand,
      base, live, cur, status, state, delta, now, baseUsdVal]);
  await q(`INSERT INTO price_history(key,url,brand,base_price,live_price,delta,state,status,run_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [prod.key, cleanUrl, prod.brand, base, live, delta, state, status, runId]);
  return delta;
}

export const productByKey = (key) => one("SELECT * FROM products WHERE key=$1", [key]);

// ---- review ----
export async function reviewItems(kind, brands) {
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  let where = "state=$1 AND decision='pending' AND review_dismissed_at IS NULL"; const p = [state];
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; p.push(...brands);
  }
  const items = await q(`SELECT * FROM products WHERE ${where}
    ORDER BY (decision='pending') DESC, ABS(COALESCE(delta,0)) DESC LIMIT 1000`, p);
  return { items, counts: await counts() };
}

// Persistently hides rows from the review queue (nav badge + tabs) WITHOUT
// touching price/decision data — an UPDATE flag, never a DELETE. This is
// what the Review page's "Clear view" button calls.
export async function dismissView(kind, brands) {
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || null;
  const cl = ["review_dismissed_at IS NULL"]; const p = [];
  if (state) { cl.push(`state=$${p.length + 1}`); p.push(state); }
  if (brands && brands.length) { cl.push(`brand IN (${brands.map((_, i) => `$${p.length + i + 1}`).join(",")})`); p.push(...brands); }
  const r = await q(`UPDATE products SET review_dismissed_at=now() WHERE ${cl.join(" AND ")} RETURNING key`, p);
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

// ---- push currency per brand ----
let _cadCache = { at: 0, set: null };
const normBrand = (b) => String(b || "").toLowerCase().replace(/^www\./, "").trim();
export async function cadBrandSet() {
  if (_cadCache.set && Date.now() - _cadCache.at < 30_000) return _cadCache.set;
  const raw = await getMeta("push_cad_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _cadCache = { at: Date.now(), set };
  return set;
}
export async function setCadBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("push_cad_brands", uniq.join(","));
  _cadCache = { at: 0, set: null };
  return uniq;
}
export async function pushCurrencyFor(brand) {
  return (await cadBrandSet()).has(normBrand(brand)) ? "CAD" : "USD";
}

// ---- per-brand FETCH currency ----
let _usdFetchCache = { at: 0, set: null };
export async function usdFetchBrandSet() {
  if (_usdFetchCache.set && Date.now() - _usdFetchCache.at < 30_000) return _usdFetchCache.set;
  const raw = await getMeta("fetch_usd_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _usdFetchCache = { at: Date.now(), set };
  return set;
}
export async function setUsdFetchBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("fetch_usd_brands", uniq.join(","));
  _usdFetchCache = { at: 0, set: null };
  return uniq;
}
export async function fetchCurrencyFor(brand) {
  return (await usdFetchBrandSet()).has(normBrand(brand)) ? "USD" : null;
}

// ---- per-brand RANGE price preference ----
let _rangeHighCache = { at: 0, set: null };
export async function rangeHighBrandSet() {
  if (_rangeHighCache.set && Date.now() - _rangeHighCache.at < 30_000) return _rangeHighCache.set;
  const raw = await getMeta("range_high_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _rangeHighCache = { at: Date.now(), set };
  return set;
}
export async function setRangeHighBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("range_high_brands", uniq.join(","));
  _rangeHighCache = { at: 0, set: null };
  return uniq;
}

// ---- per-brand GENTLE fetch (bot-protected domains) ----
let _gentleCache = { at: 0, set: null };
export async function gentleBrandSet() {
  if (_gentleCache.set && Date.now() - _gentleCache.at < 30_000) return _gentleCache.set;
  const raw = await getMeta("gentle_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _gentleCache = { at: Date.now(), set };
  return set;
}
export async function setGentleBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("gentle_brands", uniq.join(","));
  _gentleCache = { at: 0, set: null };
  return uniq;
}

// ---- per-brand PROXY fetch (IP-banned domains; needs FETCH_PROXY_URL) ----
let _proxyCache = { at: 0, set: null };
export async function proxyBrandSet() {
  if (_proxyCache.set && Date.now() - _proxyCache.at < 30_000) return _proxyCache.set;
  const raw = await getMeta("proxy_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _proxyCache = { at: Date.now(), set };
  return set;
}
export async function setProxyBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("proxy_brands", uniq.join(","));
  _proxyCache = { at: 0, set: null };
  return uniq;
}

// ---- per-brand LOCAL-ONLY fetch (cloud IP banned; refresh from local runs) ----
let _localOnlyCache = { at: 0, set: null };
export async function localOnlyBrandSet() {
  if (_localOnlyCache.set && Date.now() - _localOnlyCache.at < 30_000) return _localOnlyCache.set;
  const raw = await getMeta("local_only_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _localOnlyCache = { at: Date.now(), set };
  return set;
}
export async function setLocalOnlyBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("local_only_brands", uniq.join(","));
  _localOnlyCache = { at: 0, set: null };
  return uniq;
}

// ---- per-brand relay fetch tweaks (only applied when fetching via relay) ----
let _wooApiCache = { at: 0, set: null };
export async function wooApiBrandSet() {
  if (_wooApiCache.set && Date.now() - _wooApiCache.at < 30_000) return _wooApiCache.set;
  const raw = await getMeta("woo_api_brands", "");
  const set = new Set(String(raw || "").split(",").map(normBrand).filter(Boolean));
  _wooApiCache = { at: Date.now(), set };
  return set;
}
export async function setWooApiBrands(list) {
  const arr = (Array.isArray(list) ? list : String(list || "").split(","))
    .map(normBrand).filter(Boolean);
  const uniq = [...new Set(arr)];
  await setMeta("woo_api_brands", uniq.join(","));
  _wooApiCache = { at: 0, set: null };
  return uniq;
}
export async function relayAppendParams() {
  const raw = await getMeta("relay_append_params", "");
  try {
    const obj = JSON.parse(raw || "{}");
    const out = {};
    for (const [b, params] of Object.entries(obj)) out[normBrand(b)] = params;
    return out;
  } catch { return {}; }
}
export async function setRelayAppendParams(obj) {
  await setMeta("relay_append_params", JSON.stringify(obj || {}));
  return obj || {};
}

// ---- per-brand NATIVE currency (base_price is stored directly in this
// currency, not INR — skip FX conversion and force this currency label
// instead of trusting geo-dependent detection, e.g. Shopify Markets serving
// USD-labeled prices to a foreign-IP fetcher for a shop whose real/base
// currency is CAD) ----
export async function nativeCurrencyBrands() {
  const raw = await getMeta("native_currency_brands", "");
  try {
    const obj = JSON.parse(raw || "{}");
    const out = {};
    for (const [b, cur] of Object.entries(obj)) out[normBrand(b)] = String(cur || "").toUpperCase();
    return out;
  } catch { return {}; }
}
export async function setNativeCurrencyBrands(obj) {
  const clean = {};
  for (const [b, cur] of Object.entries(obj || {})) {
    const nb = normBrand(b); const nc = String(cur || "").trim().toUpperCase();
    if (nb && nc) clean[nb] = nc;
  }
  await setMeta("native_currency_brands", JSON.stringify(clean));
  return clean;
}

// ---- approval archive ----
const HIST_COLS = `key,mbo_url,url,platform,brand,base_price,live_price,currency,delta,
  status,markup_pct,ref,final_price,note,approved_by,approved_at`;
export async function archiveApproved(client, prow, final, markup, ref, note, by) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const inserted = await client.query(`INSERT INTO review_history (${HIST_COLS})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *`,
    [prow.key, prow.mbo_url, prow.url, prow.platform, prow.brand, prow.base_price,
      prow.live_price, prow.currency, prow.delta, prow.status, markup, ref, final, note, by, now]);
  await client.query(`UPDATE products SET decision=$1,markup_pct=$2,ref=$3,
    final_price=$4,note=$5,decided_at=$6,shopify_status=NULL,shopify_at=NULL
    WHERE id=$7`, ['approved', markup, ref, final, note, now, prow.id]);
  return inserted.rows[0];
}

// ---- history ----
const PUSH_SUCCESS = "(shopify_status LIKE 'updated%' OR shopify_status LIKE 'DRY RUN%')";
export async function historyList(brand, status) {
  const cl = []; const p = [];
  if (brand) { p.push(brand); cl.push(`brand=$${p.length}`); }
  if (status === "pushed") cl.push(PUSH_SUCCESS);
  else if (status === "failed") cl.push(`shopify_status IS NOT NULL AND NOT ${PUSH_SUCCESS}`);
  else if (status === "not_pushed") cl.push("shopify_status IS NULL");
  const where = cl.length ? "WHERE " + cl.join(" AND ") : "";
  const rows = await q(`SELECT * FROM review_history ${where} ORDER BY approved_at DESC LIMIT 2000`, p);
  const s = await one(`SELECT COUNT(*) c, COALESCE(SUM(final_price),0) v,
    COUNT(*) FILTER (WHERE ${PUSH_SUCCESS}) pushed,
    COUNT(*) FILTER (WHERE shopify_status IS NOT NULL AND NOT ${PUSH_SUCCESS}) failed,
    COUNT(*) FILTER (WHERE shopify_status IS NULL) not_pushed FROM review_history`);
  return { items: rows, count: num(s.c), value: Number(s.v) || 0,
    pushed: num(s.pushed), failed: num(s.failed), not_pushed: num(s.not_pushed) };
}

// ---- integrations (single global store) ----
export async function getStoreIntegration() {
  return one("SELECT * FROM integrations WHERE brand=$1", [STORE_KEY]);
}
export async function integrationBrands() {
  const brands = await q(`SELECT brand, COUNT(*) c, COUNT(*) FILTER (WHERE state='mismatch') m
    FROM products WHERE brand<>'' GROUP BY brand ORDER BY c DESC`);
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

export async function addProducts(rows) {
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let idx = num((await client.query(
      "SELECT COALESCE(MAX(split_part(key,'|',1)::int),0) m FROM products"
    )).rows[0].m);
    let added = 0;
    for (const r of clean) {
      idx += 1;
      const key = `${String(idx).padStart(5, "0")}|${r.url.slice(0, 280)}`;
      const result = await client.query(
        `INSERT INTO products (key,mbo_url,url,platform,custom_regex,brand,base_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key) DO NOTHING`,
        [key, r.mbo_url, r.url, r.platform, r.custom_regex, brandOf(r.url), r.base_price]
      );
      added += result.rowCount;
    }
    await client.query("COMMIT");
    return { added };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
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
export async function importSheet(buf, { replace = true, contains = '', domains = [] } = {}) {
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
  const client = await pool.connect();
  let n = 0, removed = 0;
  try {
    await client.query("BEGIN");
    if (replace) {
      const r = await client.query("DELETE FROM import_catalog");
      removed = r.rowCount;
    }
    const CH = 500;
    for (let s = 0; s < prods.length; s += CH) {
      const chunk = prods.slice(s, s + CH);
      const importVals = []; const importPh = [];
      chunk.forEach((p, j) => {
        const b = j * 8;
        importPh.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
        importVals.push(p.key, p.mbo_url, p.url, p.platform, p.custom_regex,
          p.brand, p.base_price, now);
      });
      await client.query(`INSERT INTO import_catalog
        (key,mbo_url,url,platform,custom_regex,brand,base_price,imported_at)
        VALUES ${importPh.join(',')}
        ON CONFLICT(key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
          platform=excluded.platform,custom_regex=excluded.custom_regex,
          brand=excluded.brand,base_price=excluded.base_price,
          imported_at=excluded.imported_at`, importVals);
      n += chunk.length;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  await setMeta("last_import", now);
  await setMeta("last_import_rows", String(n));
  await setMeta('last_import_contains', needle);
  await setMeta('last_import_domains', [...domainSet].join(','));
  return { rows: n, removed, at: now };
}

// Upsert-only: a sheet sync ADDS new products and UPDATES catalog fields
// (mbo_url/platform/custom_regex/brand/base_price) on matching keys. It
// never deletes — a sheet that's missing rows (a partial/test file, a
// stale export) can no longer wipe out the rest of the products table.
export async function commitImportToProducts() {
  const staged = num((await one("SELECT COUNT(*) c FROM import_catalog")).c);
  if (!staged) return { added: 0, staged: 0, total: num((await one("SELECT COUNT(*) c FROM products")).c), skipped: true };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = num((await client.query("SELECT COUNT(*) c FROM products")).rows[0].c);
    // COALESCE/NULLIF on platform+custom_regex: a sheet missing those
    // columns (e.g. a quick external test file) must not blank out a
    // scrape-critical field the product already had on file — that's
    // exactly what mislabeled a batch of Shopify products as generic
    // and made them scrape at 100x (cents, undescaled) on 2026-07-14.
    await client.query(`INSERT INTO products (key,mbo_url,url,platform,custom_regex,brand,base_price)
      SELECT key,mbo_url,url,platform,custom_regex,brand,base_price FROM import_catalog
      ON CONFLICT(key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
        platform=COALESCE(NULLIF(excluded.platform,''), products.platform),
        custom_regex=COALESCE(NULLIF(excluded.custom_regex,''), products.custom_regex),
        brand=excluded.brand,base_price=excluded.base_price`);
    const after = num((await client.query("SELECT COUNT(*) c FROM products")).rows[0].c);
    await client.query("COMMIT");
    return { added: after - before, staged, total: after };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}

export { STORE_KEY };
