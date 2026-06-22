// Data + business helpers over Supabase (mirrors store.py / saas.py logic).
import * as XLSX from "xlsx";
import { q, one, pool } from "./db.js";
import { toInr } from "./fx.js";

const REQUIRED = ["MBO Product URL", "Designer Product URL", "Platform Type",
  "Custom Regex", "Studio East Price"];
const STORE_KEY = "__store__";   // single global Shopify integration

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
export async function counts() {
  const r = await one(`SELECT COUNT(*) total,
    COUNT(*) FILTER (WHERE state='pending') pending,
    COUNT(*) FILTER (WHERE state='matched') matched,
    COUNT(*) FILTER (WHERE state='mismatch') mismatch,
    COUNT(*) FILTER (WHERE state='error') error,
    COUNT(*) FILTER (WHERE decision='approved') approved,
    COUNT(*) FILTER (WHERE state='mismatch' AND decision='pending') awaiting,
    COUNT(*) FILTER (WHERE decision='rejected') rejected FROM products`);
  const o = {}; for (const k of Object.keys(r)) o[k] = num(r[k]); return o;
}

export async function alertCount(threshold = 5) {
  try {
    const r = await one(`SELECT COUNT(*) c FROM (
      SELECT live_price, prev FROM (
        SELECT live_price,
          LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) prev,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) rn
        FROM price_history WHERE live_price IS NOT NULL
      ) t WHERE rn=1 AND prev IS NOT NULL AND prev<>0
        AND ABS((live_price-prev)/prev*100) >= $1) z`, [Math.abs(threshold)]);
    return num(r.c);
  } catch { return 0; }
}

// ---- vendors ----
export async function vendors(kind) {
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
  return q(`SELECT key,mbo_url,url,platform,custom_regex,brand,base_price,state
            FROM products ${where} ORDER BY id`, p);
}
export async function countProducts(vendorList = null) {
  if (vendorList && vendorList.length) {
    const r = await one(`SELECT COUNT(*) c FROM products WHERE brand IN (${vendorList.map((_, i) => `$${i + 1}`).join(",")})`, vendorList);
    return num(r.c);
  }
  return num((await one("SELECT COUNT(*) c FROM products")).c);
}
export async function workRows(mode = "fresh", vendorList = null) {
  return dbProducts(mode, vendorList);   // permanent DB is the source
}

// ---- pipeline result write (+ history snapshot) ----
export async function saveResult(prod, status, live, cur, state, runId) {
  const base = prod.base_price;
  const delta = (live != null && base != null) ? (await toInr(live, cur)) - base : null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await q(`INSERT INTO products (key,mbo_url,url,platform,custom_regex,brand,base_price,
      live_price,currency,status,state,delta,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(key) DO UPDATE SET live_price=excluded.live_price,currency=excluded.currency,
      status=excluded.status,state=excluded.state,delta=excluded.delta,updated_at=excluded.updated_at`,
    [prod.key, prod.mbo_url || "", prod.url, prod.platform, prod.custom_regex, prod.brand,
      base, live, cur, status, state, delta, now]);
  await q(`INSERT INTO price_history(key,url,brand,base_price,live_price,delta,state,status,run_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [prod.key, prod.url, prod.brand, base, live, delta, state, status, runId]);
  return delta;
}

// ---- review ----
export async function reviewItems(kind, brands) {
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  let where = "state=$1"; const p = [state];
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; p.push(...brands);
  }
  const items = await q(`SELECT * FROM products WHERE ${where}
    ORDER BY (decision='pending') DESC, ABS(COALESCE(delta,0)) DESC LIMIT 1000`, p);
  return { items, counts: await counts() };
}

export function computeFinal(base, live, currency, ref, markup, custom, convert, rate) {
  if (custom != null && Number(custom) > 0) return Math.round(Number(custom) * 100) / 100;
  let reference;
  if (ref === "base") reference = base;
  else reference = convert ? (live == null ? null : live * rate) : live;
  if (reference == null) reference = base;
  if (reference == null) return null;
  return Math.round(reference * (1 + Number(markup || 0) / 100) * 100) / 100;
}

const HIST_COLS = `key,mbo_url,url,platform,brand,base_price,live_price,currency,delta,
  status,markup_pct,ref,final_price,note,approved_by,approved_at`;
export async function archiveApproved(client, prow, final, markup, ref, note, by) {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await client.query(`INSERT INTO review_history (${HIST_COLS})
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [prow.key, prow.mbo_url, prow.url, prow.platform, prow.brand, prow.base_price,
      prow.live_price, prow.currency, prow.delta, prow.status, markup, ref, final, note, by, now]);
  await client.query("DELETE FROM products WHERE id=$1", [prow.id]);
}

// ---- history ----
export async function historyList(brand) {
  const rows = brand
    ? await q("SELECT * FROM review_history WHERE brand=$1 ORDER BY approved_at DESC LIMIT 2000", [brand])
    : await q("SELECT * FROM review_history ORDER BY approved_at DESC LIMIT 2000");
  const s = await one(`SELECT COUNT(*) c, COALESCE(SUM(final_price),0) v,
    COUNT(*) FILTER (WHERE shopify_status IS NOT NULL) pushed FROM review_history`);
  return { items: rows, count: num(s.c), value: Number(s.v) || 0, pushed: num(s.pushed) };
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
  return { key, mbo_url: mbo, url, platform: String(r["Platform Type"] || "").trim(),
    custom_regex: regex, brand: brandOf(url), base_price: base };
}
function sanitizeNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const m = String(v).replace(/[^0-9.]/g, "").match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
export function previewSheet(buf) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) throw new Error("missing required columns: " + missing.join(", "));
  const byDom = {}; let total = 0;
  rows.forEach((r, i) => { const p = rowToProduct(r, i + 1); if (!p) return;
    total++; byDom[p.brand] = (byDom[p.brand] || 0) + 1; });
  const domains = Object.entries(byDom).map(([d, c]) => ({ domain: d || "(none)", count: c }))
    .sort((a, b) => b.count - a.count);
  return { rows: total, domains };
}
export async function importSheet(buf, { replace = true } = {}) {
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const prods = rows.map((r, i) => rowToProduct(r, i + 1)).filter(Boolean);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const client = await pool.connect();
  let n = 0, removed = 0;
  try {
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE _keep(key TEXT PRIMARY KEY) ON COMMIT DROP");
    const CH = 500;
    for (let s = 0; s < prods.length; s += CH) {
      const chunk = prods.slice(s, s + CH);
      const vals = []; const ph = [];
      chunk.forEach((p, j) => {
        const b = j * 8;
        ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
        vals.push(p.key, p.mbo_url, p.url, p.platform, p.custom_regex, p.brand, p.base_price, now);
      });
      await client.query(`INSERT INTO products (key,mbo_url,url,platform,custom_regex,brand,base_price,updated_at)
        VALUES ${ph.join(",")}
        ON CONFLICT(key) DO UPDATE SET mbo_url=excluded.mbo_url,url=excluded.url,
          platform=excluded.platform,custom_regex=excluded.custom_regex,brand=excluded.brand,
          base_price=excluded.base_price,updated_at=excluded.updated_at`, vals);
      const kph = chunk.map((_, j) => `($${j + 1})`).join(",");
      await client.query(`INSERT INTO _keep VALUES ${kph} ON CONFLICT DO NOTHING`, chunk.map((p) => p.key));
      n += chunk.length;
    }
    if (replace) {
      const r = await client.query("DELETE FROM products WHERE key NOT IN (SELECT key FROM _keep)");
      removed = r.rowCount;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  await setMeta("last_import", now);
  await setMeta("last_import_rows", String(n));
  return { rows: n, removed, at: now };
}

export { STORE_KEY };
