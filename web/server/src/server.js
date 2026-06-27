// MBO Tracker — Express server (Supabase-backed). Mirrors the Flask API surface.
import express from "express";
import compression from "compression";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import multer from "multer";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { q, one, ping, pool } from "./db.js";
import * as sec from "./security.js";
import * as store from "./store.js";
import { encrypt } from "./crypto.js";
import { snapshot, rates, toInr, setOverrides, getOverrides } from "./fx.js";
import * as pipe from "./pipeline.js";
import { sendMismatchReport } from "./mailer.js";
import { pushPrice, verifyStore } from "./shopify.js";
import { getPriceUrlSource, setPriceUrlSource, pushRowPrice } from './price-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
const pendingUploads = new Map();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());                 // gzip responses (bundle ~393KB -> ~128KB)
// Baseline security headers (no extra dependency). Same-origin SPA, so a strict
// frame policy and nosniff are safe and block clickjacking / MIME sniffing.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
});
app.use(express.json({ limit: "2mb" }));
// Sessions live in Postgres (not in-memory) so concurrent users stay logged in
// across server restarts/redeploys and across multiple cloud instances. The
// session table is auto-created on boot. Secure cookies only on cloud (HTTPS);
// `trust proxy` above lets express-session honor Render's X-Forwarded-Proto.
app.use(session({
  store: new (connectPgSimple(session))({ pool, createTableIfMissing: true }),
  secret: config.secret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: config.isCloud, maxAge: 12 * 3600 * 1000 },
}));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e); res.status(500).json({ ok: false, error: e.message });
});

// ---------- auth (public) ----------
app.post("/api/login", wrap(async (req, res) => {
  const ip = sec.ipOf(req);
  if (sec.isLocked(ip)) return res.status(429).json({ ok: false, error: "too many attempts" });
  const u = await sec.verify(req.body.email, req.body.password);
  if (!u) { sec.registerFail(ip); return res.status(401).json({ ok: false, error: "invalid email or password" }); }
  sec.clearFails(ip); sec.loginUser(req, u);
  res.json({ ok: true, email: u.email, role: u.role });
}));
app.post("/api/register", wrap(async (req, res) => {
  const email = (req.body.email || "").trim(); const pw = req.body.password || "";
  if (!email.includes("@")) return res.status(400).json({ ok: false, error: "valid email required" });
  if (pw.length < 6) return res.status(400).json({ ok: false, error: "password must be 6+ chars" });
  if (await sec.getUser(email)) return res.status(400).json({ ok: false, error: "user already exists" });
  const u = await sec.createUser(email, pw, "viewer"); sec.loginUser(req, u);
  res.json({ ok: true, email: u.email, role: u.role });
}));
app.get("/api/health", (req, res) => { const active = pipe.runningCount(); res.json({ ok: true, running: active > 0, active_runs: active }); });

// gate everything else
app.use("/api", sec.guard);

app.get("/api/me", (req, res) => res.json(sec.currentUser(req) || {}));
app.get("/api/logout", (req, res) => { sec.logoutUser(req); res.json({ ok: true }); });

// ---------- meta / fx / insights ----------
app.get("/api/meta", wrap(async (req, res) => {
  // Fire all five independent reads in parallel — one network round-trip instead
  // of five serial ones (matters most when the DB is in a far region).
  const [counts, alerts, imported_count, last_import, last_import_rows] = await Promise.all([
    store.counts(), store.alertCount(5), store.countImported(),
    store.getMeta("last_import"), store.getMeta("last_import_rows"),
  ]);
  res.json({ counts, alerts, imported_count, last_import, last_import_rows });
}));
async function fxState() {
  return { rates: await snapshot(), overrides: getOverrides(),
    markup: Number(await store.getMeta("default_markup", 0)) || 0 };
}
app.get("/api/fx", wrap(async (req, res) => res.json(await fxState())));
// Set manual USD/CAD rates and the global default markup (admin only via guard).
app.post("/api/fx/override", wrap(async (req, res) => {
  const norm = (v) => {
    const n = v === "" || v == null ? null : Number(v);
    return n != null && Number.isFinite(n) && n > 0 ? String(n) : "";
  };
  await store.setMeta("fx_override_usd", norm(req.body.usd));
  await store.setMeta("fx_override_cad", norm(req.body.cad));
  if (req.body.markup !== undefined)
    await store.setMeta("default_markup", String(Number(req.body.markup) || 0));
  setOverrides({ USD: await store.getMeta("fx_override_usd"), CAD: await store.getMeta("fx_override_cad") });
  res.json({ ok: true, ...(await fxState()) });
}));
app.get("/api/vendors", wrap(async (req, res) => res.json({
  vendors: await store.vendors(req.query.kind, req.query.source),
})));

app.get("/api/insights", wrap(async (req, res) => {
  // Optional ?brand= filters every KPI/chart to one brand.
  const brand = (req.query.brand || "").trim();
  const bw = brand ? "AND brand=$1" : "";        // appended to queries that already have a WHERE
  const bp = brand ? [brand] : [];
  // All six reads are independent — run them concurrently so the Insights page
  // costs one round-trip's worth of latency instead of six stacked serially.
  const [c, topMis, topProd, agg, vendRow, av] = await Promise.all([
    store.counts(brand),
    q(`SELECT brand, COUNT(*) c FROM products WHERE state='mismatch' AND brand<>'' ${bw} GROUP BY brand ORDER BY c DESC LIMIT 10`, bp),
    q(`SELECT brand, COUNT(*) c FROM products WHERE brand<>'' ${bw} GROUP BY brand ORDER BY c DESC LIMIT 10`, bp),
    one(`SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) over_,
      COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) under_,
      COALESCE(AVG(ABS(delta)),0) avgd FROM products WHERE state='mismatch' ${bw}`, bp),
    one(`SELECT COUNT(DISTINCT brand) c FROM products WHERE brand<>'' ${bw}`, bp),
    brand
      ? one("SELECT COALESCE(SUM(final_price),0) v, COUNT(*) c FROM review_history WHERE brand=$1", [brand])
      : one("SELECT COALESCE(SUM(final_price),0) v, COUNT(*) c FROM review_history"),
  ]);
  const vend = Number(vendRow.c);
  res.json({ counts: c, vendors: vend,
    top_mismatch: topMis.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    top_products: topProd.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    exposure: { over: Number(agg.over_), under: Number(agg.under_), avg: Number(agg.avgd) },
    approved_value: Number(av.v), approved_count: Number(av.c), fx: await snapshot() });
}));

// ---------- pipeline (per-user: each admin drives their OWN engine) ----------
// Cap simultaneous runs to protect the host; overridable via env.
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || "3", 10);
app.post("/api/pipe/config", wrap(async (req, res) => {
  const eng = pipe.getEngine(req.session.uid);
  const next = req.body || {};
  if (next.data_source && !['database', 'imported'].includes(next.data_source)) {
    return res.status(400).json({ ok: false, error: 'invalid pipeline data source' });
  }
  Object.assign(eng.config, next);
  // Persist data_source as the default seed for future engines (shared default).
  if (next.data_source) await store.setMeta('pipeline_data_source', next.data_source);
  res.json({ ok: true, config: eng.config });
}));
// Set the currency CODE on products without changing the scraped price number.
// delta/state/status are recomputed from the existing live_price using the new
// currency's FX rate so the comparison stays consistent. Error rows (no price)
// are left untouched. Scope: all products, or brand IN vendors.
app.post("/api/products/set_currency", wrap(async (req, res) => {
  const cur = String(req.body.currency || "").trim().toUpperCase();
  if (!["INR", "USD", "CAD"].includes(cur)) return res.status(400).json({ ok: false, error: "currency must be INR, USD or CAD" });
  const rate = cur === "INR" ? 1 : ((await rates())[cur] || 1);
  const brands = (req.body.vendors || []).filter(Boolean);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const params = [cur, rate, now];
  let brandFilter = "";
  if (brands.length) { brandFilter = ` AND brand IN (${brands.map((_, i) => `$${i + 4}`).join(",")})`; params.push(...brands); }
  const rows = await q(`
    WITH scope AS (
      SELECT id, (CASE WHEN $1='INR' THEN live_price ELSE live_price * $2 END) AS live_inr, base_price AS base
      FROM products
      WHERE live_price IS NOT NULL AND base_price IS NOT NULL AND state <> 'error'${brandFilter}
    )
    UPDATE products p SET
      currency = $1,
      delta = s.live_inr - s.base,
      state = CASE WHEN ABS(s.live_inr - s.base) <= GREATEST(1.0, CASE WHEN $1='INR' THEN 1.0 ELSE 0.005*ABS(s.base) END) THEN 'matched' ELSE 'mismatch' END,
      status = CASE WHEN ABS(s.live_inr - s.base) <= GREATEST(1.0, CASE WHEN $1='INR' THEN 1.0 ELSE 0.005*ABS(s.base) END)
                 THEN 'Price Matched (' || $1 || ')' ELSE 'Price Mismatch! (' || $1 || ')' END,
      updated_at = $3
    FROM scope s WHERE p.id = s.id
    RETURNING p.id`, params);
  res.json({ ok: true, updated: rows.length, currency: cur });
}));
app.post("/api/pipe/start", wrap(async (req, res) => {
  const eng = pipe.getEngine(req.session.uid);
  if (eng.state.running) return res.status(409).json({ error: "already running" });
  if (pipe.runningCount() >= MAX_CONCURRENT_RUNS) {
    return res.status(429).json({ error: `too many runs in progress (max ${MAX_CONCURRENT_RUNS}) — try again shortly` });
  }
  const source = eng.config.data_source === 'imported' ? 'imported' : 'database';
  const sourceCount = source === 'imported' ? await store.countImported() : (await store.counts()).total;
  if (sourceCount === 0) {
    return res.status(400).json({ error: source === 'imported'
      ? "no uploaded sheet products - upload a sheet or turn the source toggle off"
      : "no products in Supabase database" });
  }
  Object.assign(eng.state, { running: true, abort: false, phase: "main", completed: 0, matched: 0,
    mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0, retry_recovered: 0, started_at: Date.now() });
  eng.log.length = 0; eng.logmeta.offset = 0;
  // Unique per concurrent run so two admins don't collide in price_history.run_id.
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-" + req.session.uid;
  pipe.startPipeline(eng, runId);
  res.json({ ok: true });
}));
app.post("/api/pipe/abort", (req, res) => { pipe.getEngine(req.session.uid).state.abort = true; res.json({ ok: true }); });
app.post("/api/pipe/clear_log", (req, res) => { const eng = pipe.getEngine(req.session.uid); eng.log.length = 0; eng.logmeta.offset = 0; res.json({ ok: true }); });
app.get("/api/pipe/status", (req, res) => {
  const eng = pipe.getEngine(req.session.uid);
  const cursor = parseInt(req.query.cursor || "0", 10);
  const start = Math.max(0, cursor - eng.logmeta.offset);
  const entries = eng.log.slice(start);
  const total = eng.logmeta.offset + eng.log.length;
  const s = eng.state;
  res.json({ running: s.running, phase: s.phase, total_rows: s.total_rows, pre_done: s.pre_done,
    completed: s.completed, current_row: s.pre_done + s.completed, matched: s.matched,
    mismatch: s.mismatch, errors: s.errors, retry_total: s.retry_total, retry_completed: s.retry_completed,
    retry_recovered: s.retry_recovered, elapsed: s.started_at ? Math.floor((Date.now() - s.started_at) / 1000) : 0,
    message: s.message, config: eng.config, cursor: total, entries, log_total: total });
});

// ---------- import ----------
app.post("/api/import/preview", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "no file" });
  const pending = { buffer: req.file.buffer, at: Date.now() };
  pendingUploads.set(req.sessionID, pending);
  setTimeout(() => {
    if (pendingUploads.get(req.sessionID) === pending) pendingUploads.delete(req.sessionID);
  }, 15 * 60 * 1000).unref();
  try { const p = store.previewSheet(req.file.buffer); res.json({ ok: true, path: "uploaded", ...p }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
app.post("/api/import", upload.single("file"), wrap(async (req, res) => {
  const pending = pendingUploads.get(req.sessionID);
  const buf = req.file ? req.file.buffer : pending?.buffer;
  if (!buf) return res.status(400).json({ ok: false, error: "no file" });
  const domains = Array.isArray(req.body.domains) ? req.body.domains :
    String(req.body.domains || '').split(',').filter(Boolean);
  try {
    const r = await store.importSheet(buf, {
      replace: req.body.mode !== 'add', contains: req.body.contains || '', domains,
    });
    pendingUploads.delete(req.sessionID);
    res.json({ ok: true, ...r, counts: await store.counts(), imported_count: await store.countImported() });
  }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
// Promote staged sheet products into the fixed products DB (add-only).
app.post("/api/import/commit", wrap(async (req, res) => {
  const r = await store.commitImportToProducts();
  res.json({ ok: true, ...r, counts: await store.counts() });
}));

// ---------- review ----------
app.get("/api/review/items", wrap(async (req, res) => {
  const brands = (req.query.brands || "").split(",").filter(Boolean);
  res.json(await store.reviewItems(req.query.kind || "mismatch", brands));
}));
app.get("/api/review/brands", wrap(async (req, res) => res.json({ brands: (await store.vendors(req.query.kind)).map((v) => ({ brand: v.vendor, count: v.count })) })));

async function approveOne(client, prow, body) {
  // markup is now a flat AMOUNT in the chosen target currency (USD/CAD), not a percent.
  const markup = body.markup_pct === "" || body.markup_pct == null ? 0 : Number(body.markup_pct);
  const custom = body.custom_price === "" || body.custom_price == null ? null : Number(body.custom_price);
  const amount = body.price_amount === "" || body.price_amount == null ? null : Number(body.price_amount);
  const amountCurrency = String(body.price_currency || prow.currency || "INR").trim().toUpperCase();
  const fx = await rates();
  const amountRate = ["INR", "UNKNOWN", ""].includes(amountCurrency) ? 1 : (fx[amountCurrency] || 1);
  const hasAmount = amount != null && Number.isFinite(amount) && amount > 0;
  const ref = hasAmount ? `amount:${amountCurrency}` : (body.ref || "live");
  // The price pushed to Shopify is ALWAYS in the brand's store currency — USD by
  // default, CAD for brands configured in meta 'push_cad_brands'. The Review
  // display toggle does NOT affect what is sent. Everything is computed in INR
  // first, then divided by the push-currency rate (INR per 1 unit of that currency).
  const targetCur = await store.pushCurrencyFor(prow.brand);   // "USD" | "CAD"
  const targetRate = fx[targetCur] || 1;
  const convert = true;
  const liveInr = await toInr(prow.live_price, prow.currency);
  const finalRaw = hasAmount
    ? Math.round((amount * amountRate / targetRate) * 100) / 100   // amount -> INR -> target
    : store.computeFinal(prow.base_price, liveInr, ref, markup, custom, convert, targetRate);
  // Round to a clean price ending (units 0-2 -> 0, 3-5 -> 5, 6-9 -> next 10) before archiving/pushing.
  const final = store.roundFinal(finalRaw);
  const archived = await store.archiveApproved(client, prow, final, markup, ref, body.note || "", body._by);
  // The approved live price (raw INR, before markup/conversion) becomes this
  // product's new baseline. Persist it in BOTH products and the staged sheet
  // (import_catalog) so a later sync won't overwrite it back. The product stays in
  // the catalog and now reads as matched; it leaves Review because decision is now
  // 'approved' (set by archiveApproved). The approval is also kept in review_history.
  if (liveInr != null && Number.isFinite(liveInr) && liveInr > 0) {
    await client.query(`UPDATE products SET base_price=$1, state='matched',
      status='Price Matched (INR)', delta=0 WHERE id=$2`, [liveInr, prow.id]);
    await client.query("UPDATE import_catalog SET base_price=$1 WHERE key=$2", [liveInr, prow.key]);
  }
  return { final, archived, pushCur: targetCur };
}
async function pushApprovedToStore(archived) {
  const result = await pushRowPrice(archived, archived.final_price);
  const at = new Date().toISOString();
  await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3",
    [result.status, at, archived.id]);
  await q("UPDATE products SET shopify_status=$1,shopify_at=$2 WHERE key=$3",
    [result.status, at, archived.key]);
  return result;
}
app.post("/api/review/decide", wrap(async (req, res) => {
  const it = await one("SELECT * FROM products WHERE id=$1", [req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const by = sec.currentUser(req)?.email;
  if (req.body.decision === "approved") {
    const client = await (await import("./db.js")).pool.connect();
    let approved;
    try { approved = await approveOne(client, it, { ...req.body, _by: by }); }
    finally { client.release(); }
    const shopify = await pushApprovedToStore(approved.archived);
    res.json({ ok: true, final_price: approved.final, push_currency: approved.pushCur, archived: true, shopify });
  } else {
    await q("UPDATE products SET decision=$1,note=$2,decided_at=$3 WHERE id=$4",
      [req.body.decision, req.body.note || "", new Date().toISOString(), req.body.row]);
    res.json({ ok: true });
  }
}));
// Delete a product from the DB permanently (the ✗ button in Review). Removes it
// from both products and the staged sheet so a later sync won't re-add it.
app.post("/api/review/delete", wrap(async (req, res) => {
  const it = await one("SELECT key FROM products WHERE id=$1", [req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  await q("DELETE FROM products WHERE id=$1", [req.body.row]);
  await q("DELETE FROM import_catalog WHERE key=$1", [it.key]);
  res.json({ ok: true, counts: await store.counts() });
}));
app.post("/api/review/approve_all", wrap(async (req, res) => {
  const kind = req.body.kind || "mismatch";
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  const brands = (req.body.brands || []).filter(Boolean);
  let where = "state=$1 AND decision='pending'"; const p = [state];
  if (brands.length) { where += ` AND brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; p.push(...brands); }
  const rows = await q(`SELECT * FROM products WHERE ${where}`, p);
  const by = sec.currentUser(req)?.email;
  const { pool } = await import("./db.js"); const client = await pool.connect();
  let n = 0; const archived = [];
  try { await client.query("BEGIN");
    for (const r of rows) {
      const approved = await approveOne(client, r, { ...req.body, custom_price: null, _by: by });
      archived.push(approved.archived); n++;
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  // Push in the background through the serial queue (shopify.js) — one at a time,
  // each waiting for the prior to confirm — so a large batch neither hangs this
  // response nor 429s Shopify. Each push writes its status to review_history/
  // products; the UI reflects it on refresh.
  (async () => { for (const item of archived) {
    try { await pushApprovedToStore(item); } catch (e) { console.error("[MBO] approve_all push:", e.message); }
  } })();
  res.json({ ok: true, approved: n, queued: archived.length });
}));
// Reject ALL rows in the current Review view: mark them decided=rejected so they
// leave the review queue. The product rows stay in products + the staged sheet
// (the catalog is NOT touched). Same filter as the visible list (state + brands +
// pending). Nothing is pushed to Shopify.
app.post("/api/review/reject_all", wrap(async (req, res) => {
  const kind = req.body.kind || "mismatch";
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  const brands = (req.body.brands || []).filter(Boolean);
  let where = "state=$1 AND decision='pending'"; const p = [state, req.body.note || "", new Date().toISOString()];
  if (brands.length) { where += ` AND brand IN (${brands.map((_, i) => `$${i + 4}`).join(",")})`; p.push(...brands); }
  const r = await q(`UPDATE products SET decision='rejected', note=$2, decided_at=$3 WHERE ${where} RETURNING id`, p);
  res.json({ ok: true, rejected: r.length, counts: await store.counts() });
}));

// ---------- history ----------
app.get("/api/history", wrap(async (req, res) => res.json(await store.historyList((req.query.brand || "").trim(), (req.query.status || "").trim()))));
app.post("/api/history/push", wrap(async (req, res) => {
  const it = await one("SELECT * FROM review_history WHERE id=$1", [req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const r = await pushRowPrice(it, it.final_price);
  await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3",
    [r.status, new Date().toISOString(), it.id]);
  res.json({ ok: r.ok, status: r.status });
}));
app.post("/api/history/push_all", wrap(async (req, res) => {
  // Retry everything not yet SUCCESSFULLY pushed: rows with no status AND rows that
  // errored (e.g. the 429s). Successful rows ('updated%' / 'DRY RUN%') are skipped.
  // Background loop feeding the serial queue (one at a time) so it can't 429 again
  // or hang HTTP.
  const rows = await q(`SELECT * FROM review_history
    WHERE shopify_status IS NULL OR NOT (shopify_status LIKE 'updated%' OR shopify_status LIKE 'DRY RUN%')
    ORDER BY approved_at LIMIT 1000`);
  (async () => { for (const it of rows) {
    try {
      const r = await pushRowPrice(it, it.final_price);
      await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3", [r.status, new Date().toISOString(), it.id]);
    } catch (e) { console.error("[MBO] push_all:", e.message); }
  } })();
  res.json({ ok: true, queued: rows.length });
}));
app.post("/api/history/clear", wrap(async (req, res) => {
  const removed = await store.clearHistory();
  res.json({ ok: true, removed });
}));
app.get("/api/history/export", wrap(async (req, res) => {
  const rows = await q(`SELECT brand,url,base_price,live_price,currency,markup_pct,final_price,
    approved_by,approved_at,shopify_status FROM review_history ORDER BY approved_at DESC`);
  await sendXlsx(res, "approval_history", rows);
}));

// ---------- alerts ----------
app.get("/api/alerts", wrap(async (req, res) => {
  const thr = Math.abs(parseFloat(req.query.threshold || "5")) || 5;
  const dir = req.query.direction || "all"; const brand = (req.query.brand || "").trim();
  const p = []; let bc = "";
  if (brand) { bc = "AND brand=$1"; p.push(brand); }
  p.push(thr);
  const rows = await q(`SELECT key,url,brand,live_price,prev,created_at,status,
      (live_price-prev) AS abs_change, ROUND(((live_price-prev)/prev*100)::numeric,2) AS pct
    FROM ( SELECT key,url,brand,live_price,status,created_at,
        LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) AS prev,
        ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) AS rn
      FROM price_history WHERE live_price IS NOT NULL) t
    WHERE rn=1 AND prev IS NOT NULL AND prev<>0 ${bc}
      AND ABS((live_price-prev)/prev*100) >= $${p.length}
    ORDER BY ABS((live_price-prev)/prev*100) DESC LIMIT 1000`, p);
  const items = [];
  for (const r of rows) { const pct = Number(r.pct); const d = pct > 0 ? "spike" : "drop";
    if (dir !== "all" && d !== dir) continue;
    items.push({ ...r, pct, abs_change: r.abs_change == null ? null : Number(r.abs_change), direction: d, created_at: String(r.created_at) }); }
  res.json({ items, total: items.length, spikes: items.filter((i) => i.direction === "spike").length,
    drops: items.filter((i) => i.direction === "drop").length, threshold: thr });
}));
app.get("/api/alerts/brands", wrap(async (req, res) => {
  const rows = await q("SELECT brand, COUNT(DISTINCT key) c FROM price_history WHERE brand<>'' GROUP BY brand ORDER BY c DESC");
  res.json({ brands: rows.map((r) => ({ brand: r.brand, count: Number(r.c) })) });
}));
app.post("/api/alerts/email_mismatch", wrap(async (req, res) => {
  const r = await sendMismatchReport((req.body || {}).to);
  res.status(r.ok ? 200 : 400).json(r);
}));

// ---------- integrations (single store) ----------
app.get("/api/integration", wrap(async (req, res) => {
  const c = await store.getStoreIntegration();
  res.json({ shop_domain: c?.shop_domain || "", api_version: c?.api_version || "2024-10",
    dry_run: c ? !!(c.dry_run) : true, has_token: !!(c?.access_token),
    price_url_source: await getPriceUrlSource() });
}));
app.post("/api/integration/save", wrap(async (req, res) => {
  const d = req.body || {};
  const ex = await store.getStoreIntegration();
  const token = (d.access_token || "").trim() ? encrypt(d.access_token.trim()) : (ex?.access_token || "");
  await q(`INSERT INTO integrations(brand,shop_domain,access_token,api_version,dry_run,updated_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(brand) DO UPDATE SET shop_domain=excluded.shop_domain,
      access_token=excluded.access_token, api_version=excluded.api_version, dry_run=excluded.dry_run, updated_at=excluded.updated_at`,
    [store.STORE_KEY, (d.shop_domain || "").trim(), token, (d.api_version || "2024-10").trim(),
      d.dry_run ? 1 : 0, new Date().toISOString()]);
  if (d.price_url_source) await setPriceUrlSource(d.price_url_source);
  res.json({ ok: true });
}));
app.post("/api/integration/verify", wrap(async (req, res) => res.json(await verifyStore())));
app.get("/api/integrations", wrap(async (req, res) => res.json({ brands: await store.integrationBrands() })));
// Push currency config: default is USD; brands listed here push CAD instead.
// GET returns the current CAD brand list; POST {brands:[...] | "a.com,b.com"} replaces it (admin).
app.get("/api/push/cad", wrap(async (req, res) => res.json({ default: "USD", cad_brands: [...(await store.cadBrandSet())] })));
app.post("/api/push/cad", wrap(async (req, res) => res.json({ ok: true, cad_brands: await store.setCadBrands(req.body.brands ?? req.body.list ?? "") })));
app.post("/api/shopify/update_price", wrap(async (req, res) => {
  const productUrl = String(req.body.product_url || "").trim();
  const newPrice = req.body.new_price;
  if (!productUrl) return res.status(400).json({ ok: false, error: "product_url required" });
  if (newPrice === "" || newPrice == null || Number.isNaN(Number(newPrice))) {
    return res.status(400).json({ ok: false, error: "valid new_price required" });
  }
  const result = await pushPrice(productUrl, Number(newPrice));
  res.status(result.ok ? 200 : 404).json(result);
}));

// ---------- export ----------
async function sendXlsx(res, name, rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("export");
  const cols = rows.length ? Object.keys(rows[0]) : ["id"];
  ws.addRow(cols);
  const si = cols.indexOf("state");
  rows.forEach((r) => { const row = ws.addRow(cols.map((c) => r[c]));
    if (si >= 0) { const st = r.state; const f = st === "mismatch" ? "FFFFF2CC" : st === "error" ? "FFF8CBAD" : null;
      if (f) row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: f } }; }); } });
  res.setHeader("Content-Disposition", `attachment; filename=${name}.xlsx`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
}
app.get("/api/export", wrap(async (req, res) => {
  const kind = req.query.kind || "all";
  const where = { all: "1=1", mismatch: "state='mismatch'", error: "state='error'", approved: "decision='approved'" }[kind] || "1=1";
  const rows = await q(`SELECT id,brand,platform,url,base_price,live_price,currency,status,state,delta,
    decision,markup_pct,final_price FROM products WHERE ${where} ORDER BY id`);
  await sendXlsx(res, `mbo_${kind}`, rows);
}));

// ---------- owner console ----------
app.get("/api/admin/sessions", sec.ownerOnly, (req, res) => res.json({ sessions: sec.activeSessions() }));
app.get("/api/admin/users", sec.ownerOnly, wrap(async (req, res) => res.json({ users: (await sec.listUsers()).map((u) => ({ ...u, created_at: String(u.created_at) })) })));
app.post("/api/admin/users/role", sec.ownerOnly, wrap(async (req, res) => {
  const role = String(req.body.role || "");
  if (!sec.ROLES.has(role)) return res.status(400).json({ ok: false, error: "invalid role" });
  await sec.setRole(req.body.email, role);
  sec.clearRoleCache();                       // apply the new role on the user's next request
  res.json({ ok: true });
}));
app.post("/api/admin/users/delete", sec.ownerOnly, wrap(async (req, res) => {
  if (req.body.email === sec.currentUser(req)?.email) return res.status(400).json({ ok: false, error: "can't delete yourself" });
  await sec.deleteUser(req.body.email);
  sec.clearRoleCache();                        // revoke the deleted user's access immediately
  res.json({ ok: true });
}));

// ---------- client (SPA) ----------
if (fs.existsSync(CLIENT_DIST)) {
  // Hashed assets (index-*.js/css) are immutable -> cache hard. index.html is
  // never cached so a new deploy is picked up immediately (no stale UI).
  app.use(express.static(CLIENT_DIST, {
    index: false, maxAge: "1y", immutable: true,
    setHeaders: (res, p) => {
      if (p.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));
  app.get("*", (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
} else {
  app.get("/", (req, res) => res.type("html").send(
    "<h2 style='font-family:sans-serif'>MBO Tracker API (Node) is running.</h2>" +
    "<p>Client build not found — run the Vite client build (Phase 4).</p>"));
}

// ---------- boot ----------
const p = await ping();
if (!p.ok) { console.error("[MBO] Supabase FAILED:", p.msg); process.exit(1); }
await store.initStore();
pipe.setDefault('data_source', await store.getMeta('pipeline_data_source', 'database'));
setOverrides({ USD: await store.getMeta('fx_override_usd'), CAD: await store.getMeta('fx_override_cad') });
const seeded = await sec.seedOwner(config.adminEmail, config.adminPassword);
if (seeded) console.log("[MBO] Owner:", seeded);
const server = app.listen(config.port, config.host,
  () => console.log(`[MBO] http://${config.host}:${config.port}`));
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[MBO] Port ${config.port} is already in use. Stop the old server or set NODE_PORT.`);
  } else {
    console.error('[MBO] Server failed:', error);
  }
  process.exit(1);
});

// Graceful shutdown: Render sends SIGTERM on every redeploy. Stop accepting new
// connections, drain the PG pool, then exit — so in-flight requests finish and we
// don't leak DB connections. Hard cap at 10s so a stuck request can't hang the deploy.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[MBO] ${signal} received — shutting down gracefully`);
  server.close(() => { pool.end().catch(() => {}).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Never let a stray async error take down the single process. Route handlers are
// already wrapped (wrap()) and the pipeline has its own try/catch; this is a last
// resort so a background rejection is logged, not fatal.
process.on("unhandledRejection", (reason) => console.error("[MBO] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[MBO] uncaughtException:", err));
