import express from "express";
import compression from "compression";
import crypto from "node:crypto";
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
import * as tenant from "./tenant.js";
import { sendMismatchReport, sendNewSignup } from "./mailer.js";
import { pushPrice, verifyStore, invalidateShopifyCfg } from "./shopify.js";
import { getPriceUrlSource, setPriceUrlSource, pushRowPrice } from './price-update.js';
import { startPushJob, getPushJob, runningPushJob, startReviewPushJob } from './push-job.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
const pendingUploads = new Map();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(compression());
// Lightweight request log with a short request id (no extra dependency).
// Skips the health check so uptime pings don't flood the log.
app.use((req, res, next) => {
  if (req.path === "/api/health") return next();
  const rid = crypto.randomBytes(4).toString("hex");
  req.rid = rid;
  const started = Date.now();
  res.on("finish", () => {
    console.log(`[MBO] ${rid} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use(session({
  store: new (connectPgSimple(session))({ pool, createTableIfMissing: true }),
  secret: config.secret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: config.isCloud, maxAge: 12 * 3600 * 1000 },
}));

// Log the real error server-side (with the request id) but return a generic
// message — internal error text must not leak to the client. Validation
// errors are still returned explicitly with 400 inside each handler.
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(`[MBO] ${req.rid || "-"} handler error:`, e);
  res.status(500).json({ ok: false, error: "internal error" });
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
// Self-serve signup is closed platform-wide — onboarding is admin/super-admin
// provisioned only (see the plan's decision #3). This endpoint stays mounted
// (so old clients get a clear rejection instead of a 404) but never creates
// an account.
app.post("/api/register", wrap(async (req, res) => {
  res.status(403).json({ ok: false, error: "self sign-up is not open — ask your MBO's owner or the platform admin to create your account" });
}));
app.get("/api/health", (req, res) => { const active = pipe.runningCount(); res.json({ ok: true, running: active > 0, active_runs: active }); });
app.get("/api/auth/google/config", (req, res) => res.json({ client_id: config.googleClientId }));
app.post("/api/auth/google", wrap(async (req, res) => {
  if (!config.googleClientId) {
    return res.status(400).json({ ok: false, error: "Google sign-in not configured (set GOOGLE_CLIENT_ID in .env)" });
  }
  const credential = String(req.body.credential || "").trim();
  if (!credential) return res.status(400).json({ ok: false, error: "missing Google credential" });
  const g = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!g.ok) return res.status(401).json({ ok: false, error: "invalid or expired Google token" });
  const info = await g.json();
  if (info.aud !== config.googleClientId) return res.status(401).json({ ok: false, error: "Google token issued for a different app" });
  if (String(info.email_verified) !== "true") return res.status(401).json({ ok: false, error: "Google email not verified" });
  const email = String(info.email || "").toLowerCase().trim();
  if (!email.includes("@")) return res.status(400).json({ ok: false, error: "no email in Google account" });
  const u = await sec.getUser(email);
  // Self-serve signup is closed platform-wide (see decision #3) — Google
  // sign-in now only authenticates an ALREADY admin-provisioned account; it
  // no longer auto-creates a tenant-less viewer for any verified email.
  if (!u) return res.status(403).json({ ok: false, error: "no account found for this Google email — ask your MBO's owner or the platform admin to create your account" });
  sec.loginUser(req, u);
  res.json({ ok: true, email: u.email, role: u.role });
}));

app.use("/api", sec.guard);

app.get("/api/me", (req, res) => res.json(sec.currentUser(req) || {}));
app.get("/api/logout", (req, res) => { sec.logoutUser(req); res.json({ ok: true }); });

// Every route below this point operates on one tenant's data. resolveTenant
// sets req.mboId from the session (viewer/admin/owner always have one); a
// super_admin has none and is 403'd here — it uses /api/superadmin/* instead.
const tenantRouter = express.Router();
tenantRouter.use(tenant.resolveTenant);

// ---------- meta / fx / insights ----------
tenantRouter.get("/meta", wrap(async (req, res) => {
  const mboId = req.mboId;
  const [counts, alerts, imported_count, last_import, last_import_rows] = await Promise.all([
    store.counts(mboId), store.alertCount(mboId, 5), store.countImported(mboId),
    store.getMeta(mboId, "last_import"), store.getMeta(mboId, "last_import_rows"),
  ]);
  res.json({ counts, alerts, imported_count, last_import, last_import_rows });
}));
async function fxState(mboId) {
  return { rates: await snapshot(mboId), overrides: getOverrides(mboId),
    markup: Number(await store.getMeta(mboId, "default_markup", 0)) || 0 };
}
tenantRouter.get("/fx", wrap(async (req, res) => res.json(await fxState(req.mboId))));
tenantRouter.post("/fx/override", wrap(async (req, res) => {
  const mboId = req.mboId;
  const norm = (v) => {
    const n = v === "" || v == null ? null : Number(v);
    return n != null && Number.isFinite(n) && n > 0 ? String(n) : "";
  };
  await store.setMeta(mboId, "fx_override_usd", norm(req.body.usd));
  await store.setMeta(mboId, "fx_override_cad", norm(req.body.cad));
  if (req.body.markup !== undefined)
    await store.setMeta(mboId, "default_markup", String(Number(req.body.markup) || 0));
  setOverrides(mboId, { USD: await store.getMeta(mboId, "fx_override_usd"), CAD: await store.getMeta(mboId, "fx_override_cad") });
  res.json({ ok: true, ...(await fxState(mboId)) });
}));
tenantRouter.get("/vendors", wrap(async (req, res) => {
  const { kind, source, scope } = req.query;
  const mboId = req.mboId;
  if (scope === "review") return res.json({ vendors: await store.reviewVendors(mboId) });
  if (scope === "history") return res.json({ vendors: await store.historyVendors(mboId) });
  res.json({ vendors: await store.vendors(mboId, kind, source) });
}));

tenantRouter.get("/insights", wrap(async (req, res) => {
  const mboId = req.mboId;
  const brand = (req.query.brand || "").trim();
  const bw = brand ? "AND brand=$2" : "";
  const bp = brand ? [mboId, brand] : [mboId];
  const [c, topMis, topProd, agg, vendRow, av] = await Promise.all([
    store.counts(mboId, brand),
    q(`SELECT brand, COUNT(*) c FROM products WHERE mbo_id=$1 AND state='mismatch' AND brand<>'' ${bw} GROUP BY brand ORDER BY c DESC LIMIT 10`, bp),
    q(`SELECT brand, COUNT(*) c FROM products WHERE mbo_id=$1 AND brand<>'' ${bw} GROUP BY brand ORDER BY c DESC LIMIT 10`, bp),
    one(`SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) over_,
      COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) under_,
      COALESCE(AVG(ABS(delta)),0) avgd FROM products WHERE mbo_id=$1 AND state='mismatch' ${bw}`, bp),
    one(`SELECT COUNT(DISTINCT brand) c FROM products WHERE mbo_id=$1 AND brand<>'' ${bw}`, bp),
    brand
      ? one("SELECT COALESCE(SUM(final_price),0) v, COUNT(*) c FROM review_history WHERE mbo_id=$1 AND brand=$2", [mboId, brand])
      : one("SELECT COALESCE(SUM(final_price),0) v, COUNT(*) c FROM review_history WHERE mbo_id=$1", [mboId]),
  ]);
  const vend = Number(vendRow.c);
  res.json({ counts: c, vendors: vend,
    top_mismatch: topMis.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    top_products: topProd.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    exposure: { over: Number(agg.over_), under: Number(agg.under_), avg: Number(agg.avgd) },
    approved_value: Number(av.v), approved_count: Number(av.c), fx: await snapshot(mboId) });
}));
// Per-brand error-rate breakdown (the "meter") — which brand/site is
// erroring and why, reusing the `Fetch Error (<cause>)` status convention.
tenantRouter.get("/insights/errors", wrap(async (req, res) => {
  const brand = (req.query.brand || "").trim();
  res.json({ items: await store.errorMeter(req.mboId, brand ? { brand } : {}) });
}));

// ---------- pipeline (per-tenant-per-user engine) ----------
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || "3", 10);
tenantRouter.post("/pipe/config", wrap(async (req, res) => {
  const mboId = req.mboId;
  const eng = pipe.getEngine(mboId, req.session.uid);
  const next = req.body || {};
  if (next.data_source && !['database', 'imported'].includes(next.data_source)) {
    return res.status(400).json({ ok: false, error: 'invalid pipeline data source' });
  }
  Object.assign(eng.config, next);
  if (next.data_source) await store.setMeta(mboId, 'pipeline_data_source', next.data_source);
  res.json({ ok: true, config: eng.config });
}));
tenantRouter.post("/products/set_currency", wrap(async (req, res) => {
  const mboId = req.mboId;
  const cur = String(req.body.currency || "").trim().toUpperCase();
  if (!["INR", "USD", "CAD"].includes(cur)) return res.status(400).json({ ok: false, error: "currency must be INR, USD or CAD" });
  const rate = cur === "INR" ? 1 : ((await rates(mboId))[cur] || 1);
  const brands = (req.body.vendors || []).filter(Boolean);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const params = [cur, rate, now, mboId];
  let brandFilter = "";
  if (brands.length) { brandFilter = ` AND brand IN (${brands.map((_, i) => `$${i + 5}`).join(",")})`; params.push(...brands); }
  const rows = await q(`
    WITH scope AS (
      SELECT id, (CASE WHEN $1='INR' THEN live_price ELSE live_price * $2 END) AS live_inr, base_price AS base
      FROM products
      WHERE mbo_id=$4 AND live_price IS NOT NULL AND base_price IS NOT NULL AND state <> 'error'${brandFilter}
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
tenantRouter.post("/pipe/start", wrap(async (req, res) => {
  const mboId = req.mboId;
  const eng = pipe.getEngine(mboId, req.session.uid);
  if (eng.state.running) return res.status(409).json({ error: "already running" });
  if (pipe.runningCount() >= MAX_CONCURRENT_RUNS) {
    return res.status(429).json({ error: `too many runs in progress (max ${MAX_CONCURRENT_RUNS}) — try again shortly` });
  }
  const source = eng.config.data_source === 'imported' ? 'imported' : 'database';
  const sourceCount = source === 'imported' ? await store.countImported(mboId) : (await store.counts(mboId)).total;
  if (sourceCount === 0) {
    return res.status(400).json({ error: source === 'imported'
      ? "no uploaded sheet products - upload a sheet or turn the source toggle off"
      : "no products in Supabase database" });
  }
  Object.assign(eng.state, { running: true, abort: false, phase: "main", completed: 0, matched: 0,
    mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0, retry_recovered: 0, started_at: Date.now() });
  eng.log.length = 0; eng.logmeta.offset = 0;
  // Pipeline lifecycle emails go to whoever started the run, not a fixed address.
  eng.userEmail = req.session.email;
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-" + req.session.uid;
  pipe.startPipeline(eng, runId);
  res.json({ ok: true });
}));
tenantRouter.post("/pipe/abort", (req, res) => { pipe.getEngine(req.mboId, req.session.uid).state.abort = true; res.json({ ok: true }); });
tenantRouter.post("/pipe/clear_log", (req, res) => { const eng = pipe.getEngine(req.mboId, req.session.uid); eng.log.length = 0; eng.logmeta.offset = 0; res.json({ ok: true }); });
tenantRouter.get("/pipe/status", (req, res) => {
  const eng = pipe.getEngine(req.mboId, req.session.uid);
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

// ---------- add products (manual entry / standalone sheet) ----------
// Purely additive — see store.addProducts. Never touches or removes an
// existing product, so it's safe to use without the sheet-sync hazards
// import/commit has.
// Blank template sheet with the exact column names the importer expects.
// Sheet 1 ("products") is headers-only on purpose — parseAddSheet/importSheet
// read the FIRST sheet, so example rows live on sheet 2 where they can never
// be imported by accident.
tenantRouter.get("/products/add_template", wrap(async (req, res) => {
  const HEADERS = ["MBO Product URL", "Designer Product URL", "Platform Type", "Custom Regex", "Studio East Price"];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("products");
  ws.addRow(HEADERS);
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A40" } };
  });
  ws.columns = [{ width: 45 }, { width: 45 }, { width: 14 }, { width: 30 }, { width: 18 }];
  const ex = wb.addWorksheet("how to fill (examples)");
  ex.addRow(["Fill your products into the FIRST sheet ('products'). This sheet is just a guide — it is ignored on upload."]);
  ex.addRow([]);
  ex.addRow(HEADERS);
  ex.getRow(3).eachCell((c) => { c.font = { bold: true }; });
  ex.addRow(["https://your-mbo-store.com/products/example-kurta", "https://designerbrand.com/products/example-kurta", "shopify", "", 45000]);
  ex.addRow(["", "https://otherbrand.in/product/example-saree/", "wordpress", "", 112500]);
  ex.addRow([]);
  ex.addRow(["Column notes:"]);
  ex.addRow(["- Designer Product URL (required): the designer's own product page — this is what gets scraped."]);
  ex.addRow(["- Studio East Price (required): your base price, numbers only (no ₹ or commas needed)."]);
  ex.addRow(["- MBO Product URL (optional): your store's product page — used when pushing prices to Shopify."]);
  ex.addRow(["- Platform Type (optional): shopify / wordpress / Custom. Leave blank to auto-detect."]);
  ex.addRow(["- Custom Regex (optional): only for sites needing a custom price pattern — leave blank normally."]);
  ex.columns = [{ width: 110 }];
  res.setHeader("Content-Disposition", "attachment; filename=add_products_template.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
}));
tenantRouter.post("/products/add_preview", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "no file" });
  try { res.json({ ok: true, rows: store.parseAddSheet(req.file.buffer) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
tenantRouter.post("/products/add", wrap(async (req, res) => {
  const mboId = req.mboId;
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const r = await store.addProducts(mboId, rows);
  res.json({ ok: true, ...r, counts: await store.counts(mboId) });
}));

// ---------- import ----------
tenantRouter.post("/import/preview", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "no file" });
  const pending = { buffer: req.file.buffer, at: Date.now() };
  pendingUploads.set(req.sessionID, pending);
  setTimeout(() => {
    if (pendingUploads.get(req.sessionID) === pending) pendingUploads.delete(req.sessionID);
  }, 15 * 60 * 1000).unref();
  try { const p = store.previewSheet(req.file.buffer); res.json({ ok: true, path: "uploaded", ...p }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
tenantRouter.post("/import", upload.single("file"), wrap(async (req, res) => {
  const mboId = req.mboId;
  const pending = pendingUploads.get(req.sessionID);
  const buf = req.file ? req.file.buffer : pending?.buffer;
  if (!buf) return res.status(400).json({ ok: false, error: "no file" });
  const domains = Array.isArray(req.body.domains) ? req.body.domains :
    String(req.body.domains || '').split(',').filter(Boolean);
  try {
    const r = await store.importSheet(mboId, buf, {
      replace: req.body.mode !== 'add', contains: req.body.contains || '', domains,
    });
    pendingUploads.delete(req.sessionID);
    res.json({ ok: true, ...r, counts: await store.counts(mboId), imported_count: await store.countImported(mboId) });
  }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
tenantRouter.post("/import/commit", wrap(async (req, res) => {
  const mboId = req.mboId;
  const r = await store.commitImportToProducts(mboId);
  res.json({ ok: true, ...r, counts: await store.counts(mboId) });
}));

// ---------- review ----------
tenantRouter.get("/review/items", wrap(async (req, res) => {
  const brands = (req.query.brands || "").split(",").filter(Boolean);
  res.json(await store.reviewItems(req.mboId, req.query.kind || "mismatch", brands));
}));
// Priority-ordered (mismatch, then error, then matched) list — scoped to
// the brand(s) selected in the top filter, or every brand when none is set.
tenantRouter.get("/review/items_by_brand", wrap(async (req, res) => {
  const brands = (req.query.brands || "").split(",").map((s) => s.trim()).filter(Boolean);
  res.json(await store.reviewItemsByBrands(req.mboId, brands));
}));
// Review table's per-row "Clear" — hides just that row (UPDATE flag, never
// a delete); the product and its price data are untouched in the database.
tenantRouter.post("/review/hide", wrap(async (req, res) => {
  const it = await store.dismissRow(req.mboId, req.body.row);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  res.json({ ok: true });
}));
// "Master Clean" — hides every row the Review table is currently showing
// (same scope as items_by_brand, empty brands = all). UPDATE flag only,
// never a delete — nothing is removed from the database.
tenantRouter.post("/review/hide_all", wrap(async (req, res) => {
  const mboId = req.mboId;
  const brands = Array.isArray(req.body.brands) ? req.body.brands.filter(Boolean) : [];
  const removed = await store.dismissReviewByBrands(mboId, brands);
  res.json({ ok: true, removed, counts: await store.counts(mboId) });
}));
tenantRouter.get("/review/brands", wrap(async (req, res) => res.json({ brands: (await store.vendors(req.mboId, req.query.kind)).map((v) => ({ brand: v.vendor, count: v.count })) })));

async function approveOne(mboId, client, prow, body) {
  const markup = body.markup_pct === "" || body.markup_pct == null ? 0 : Number(body.markup_pct);
  const custom = body.custom_price === "" || body.custom_price == null ? null : Number(body.custom_price);
  const amount = body.price_amount === "" || body.price_amount == null ? null : Number(body.price_amount);
  const amountCurrency = String(body.price_currency || prow.currency || "INR").trim().toUpperCase();
  const fx = await rates(mboId);
  const amountRate = ["INR", "UNKNOWN", ""].includes(amountCurrency) ? 1 : (fx[amountCurrency] || 1);
  const hasAmount = amount != null && Number.isFinite(amount) && amount > 0;
  const ref = hasAmount ? `amount:${amountCurrency}` : (body.ref || "live");
  const targetCur = await store.pushCurrencyFor(mboId, prow.brand);
  const targetRate = fx[targetCur] || 1;
  const convert = true;
  const liveInr = await toInr(mboId, prow.live_price, prow.currency);
  const finalRaw = hasAmount
    ? Math.round((amount * amountRate / targetRate) * 100) / 100
    : store.computeFinal(prow.base_price, liveInr, ref, markup, custom, convert, targetRate);
  const final = store.roundFinal(finalRaw);
  const archived = await store.archiveApproved(mboId, client, prow, final, markup, ref, body.note || "", body._by);
  return { final, archived, pushCur: targetCur };
}
// approveOne wrapped in its own short transaction — used by the combined
// "Push and update price" job below, one row at a time.
async function archiveForPush(mboId, prow, spec) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const approved = await approveOne(mboId, client, prow, spec);
    await client.query("COMMIT");
    return approved;
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
// Review page's single combined action for the brand selected at top:
// archives every pending mismatch/error/matched row for that brand to
// History, then pushes it to Shopify — same batch-progress job shape as
// /api/history push_all/push_job, scoped strictly to one brand (never all).
tenantRouter.post("/review/push_brand", wrap(async (req, res) => {
  const mboId = req.mboId;
  const brands = Array.isArray(req.body.brands) ? req.body.brands.filter(Boolean) : [];
  if (!brands.length) return res.status(400).json({ ok: false, error: "select at least one brand before pushing" });
  // Optional "only mismatched" scope — push just the price-mismatch rows and
  // leave matched/error rows untouched (the default pushes all three states).
  const onlyMismatch = req.body.only_mismatch === true || req.body.only_mismatch === "true";
  const stateClause = onlyMismatch ? "state='mismatch'" : "state IN ('mismatch','error','matched')";
  const rows = await q(`SELECT * FROM products WHERE mbo_id=$1 AND brand = ANY($2::text[]) AND decision='pending'
    AND ${stateClause} AND review_dismissed_at IS NULL
    ORDER BY ${store.STATE_PRIORITY_SQL}`, [mboId, brands]);
  if (!rows.length) return res.json({ ok: true, queued: 0 });
  const by = sec.currentUser(req)?.email;
  const overrideMap = new Map((req.body.overrides || []).map((o) => [String(o.id), o]));
  const { markup_pct, convert, convert_currency } = req.body;
  const label = `Push & update — ${brands.length===1?brands[0]:brands.length+" brands"}`;
  const push = startReviewPushJob(mboId, rows, (prow) => {
    const ov = overrideMap.get(String(prow.id)) || {};
    return archiveForPush(mboId, prow, {
      markup_pct, convert, convert_currency,
      price_amount: ov.price_amount, price_currency: ov.price_currency, _by: by,
    });
  }, label);
  res.json({ ok: push.ok, queued: push.ok ? rows.length : 0, job: push.job, error: push.error });
}));
tenantRouter.post("/review/decide", wrap(async (req, res) => {
  const mboId = req.mboId;
  const it = await one("SELECT * FROM products WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const by = sec.currentUser(req)?.email;
  if (req.body.decision === "approved") {
    const client = await pool.connect();
    let approved;
    try {
      await client.query("BEGIN");
      approved = await approveOne(mboId, client, it, { ...req.body, _by: by });
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
    // Approve only archives to History now — the Shopify push is a separate,
    // deliberate step from the History tab (push/push_all), not automatic.
    res.json({ ok: true, final_price: approved.final, push_currency: approved.pushCur, archived: true });
  } else {
    await q("UPDATE products SET decision=$1,note=$2,decided_at=$3 WHERE mbo_id=$4 AND id=$5",
      [req.body.decision, req.body.note || "", new Date().toISOString(), mboId, req.body.row]);
    res.json({ ok: true });
  }
}));
tenantRouter.post("/review/update_base", wrap(async (req, res) => {
  const mboId = req.mboId;
  const it = await one("SELECT * FROM products WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  if (it.live_price == null) return res.status(400).json({ ok: false, error: "row has no live price" });
  const cur = String(req.body.currency || it.currency || "INR").trim().toUpperCase();
  // Native-currency brands keep base_price in their own currency (no FX) —
  // converting to INR here would corrupt the baseline for every future run.
  const nativeCur = (await store.nativeCurrencyBrands(mboId))[store.normBrand(it.brand)];
  const isNative = !!(nativeCur && cur === nativeCur);
  const baseInr = isNative ? Number(it.live_price) : await toInr(mboId, it.live_price, cur);
  if (baseInr == null || !Number.isFinite(baseInr) || baseInr <= 0) {
    return res.status(400).json({ ok: false, error: "could not convert live price to INR" });
  }
  // USD baseline only makes sense when the live price itself is USD; otherwise
  // clear it so the next USD-fetch run freezes a fresh baseline.
  const baseUsd = !isNative && cur === "USD" ? it.live_price : null;
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await q(`UPDATE products SET base_price=$1, base_usd=$2, live_price=NULL, currency=NULL,
      delta=NULL, state='pending', status='', decision='pending', decided_at=NULL, updated_at=$3
    WHERE mbo_id=$4 AND id=$5`, [baseInr, baseUsd, now, mboId, it.id]);
  await q("UPDATE import_catalog SET base_price=$1 WHERE mbo_id=$2 AND key=$3", [baseInr, mboId, it.key]);
  await store.clearBuckets(mboId, q, it.key);
  res.json({ ok: true, base_price: baseInr, base_usd: baseUsd, currency: cur, native: isNative, counts: await store.counts(mboId) });
}));
tenantRouter.post("/review/update_base_all", wrap(async (req, res) => {
  const mboId = req.mboId;
  const stateMap = { mismatch: "mismatch", error: "error", resolved: "matched" };
  const state = stateMap[req.body.kind] || "mismatch";
  const brands = Array.isArray(req.body.brands) ? req.body.brands.filter(Boolean) : [];
  if (!brands.length) return res.status(400).json({ ok: false, error: "select at least one vendor before updating base = live for all" });
  const cl = ["mbo_id=$1", "state=$2", "live_price IS NOT NULL", `brand IN (${brands.map((_, i) => `$${i + 3}`).join(",")})`]; const p = [mboId, state, ...brands];
  const rows = await q(`SELECT id,key,brand,live_price,currency FROM products WHERE ${cl.join(" AND ")}`, p);
  const nativeMap = await store.nativeCurrencyBrands(mboId);
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let updated = 0;
  for (const r of rows) {
    const cur = String(r.currency || "INR").trim().toUpperCase();
    const isNative = nativeMap[store.normBrand(r.brand)] === cur;
    const baseInr = isNative ? Number(r.live_price) : await toInr(mboId, r.live_price, cur);
    if (baseInr == null || !Number.isFinite(baseInr) || baseInr <= 0) continue;
    const baseUsd = !isNative && cur === "USD" ? r.live_price : null;
    await q(`UPDATE products SET base_price=$1, base_usd=$2, live_price=NULL, currency=NULL,
        delta=NULL, state='pending', status='', decision='pending', decided_at=NULL, updated_at=$3
      WHERE mbo_id=$4 AND id=$5`, [baseInr, baseUsd, now, mboId, r.id]);
    await q("UPDATE import_catalog SET base_price=$1 WHERE mbo_id=$2 AND key=$3", [baseInr, mboId, r.key]);
    await store.clearBuckets(mboId, q, r.key);
    updated++;
  }
  res.json({ ok: true, updated, counts: await store.counts(mboId) });
}));
tenantRouter.post("/review/delete", wrap(async (req, res) => {
  const mboId = req.mboId;
  const it = await one("SELECT key FROM products WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  await q("DELETE FROM products WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  await q("DELETE FROM import_catalog WHERE mbo_id=$1 AND key=$2", [mboId, it.key]);
  await store.clearBuckets(mboId, q, it.key);
  res.json({ ok: true, counts: await store.counts(mboId) });
}));
// Re-fetches a single product's live price right now, using the exact same
// per-brand extraction rules as a real pipeline run (see pipe.rerunOne) —
// used by the Review page's per-row/bulk "Rerun" on the Errors tab.
tenantRouter.post("/review/rerun", wrap(async (req, res) => {
  const mboId = req.mboId;
  const it = await one("SELECT * FROM products WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const fresh = await pipe.rerunOne(mboId, it);
  res.json({ ok: true, item: fresh, state: fresh?.state, counts: await store.counts(mboId) });
}));
// Archives rows to History in the background, one row/transaction at a
// time, so each finished row shows up in History immediately instead of
// the whole batch appearing only once every row is done. Fire-and-forget —
// the route responds before this runs.
async function approveRowsInBackground(mboId, entries) {
  for (const { prow, spec } of entries) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await approveOne(mboId, client, prow, spec);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[MBO] approve failed for", prow.key, ":", e.message);
    } finally { client.release(); }
  }
}
// "Approve Selected" (the checkbox multi-select) — archives to History
// only; no Shopify push happens here (that's a separate, deliberate step
// from the History tab). Responds immediately; archiving runs in the
// background so rows land in History as each completes, not all at once.
tenantRouter.post("/review/approve_selected", wrap(async (req, res) => {
  const mboId = req.mboId;
  const specs = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!specs.length) return res.status(400).json({ ok: false, error: "no rows selected" });
  const ids = specs.map((s) => s.id).filter((id) => id != null);
  const prows = await q(`SELECT * FROM products WHERE mbo_id=$1 AND id = ANY($2)`, [mboId, ids]);
  const byId = new Map(prows.map((r) => [String(r.id), r]));
  const by = sec.currentUser(req)?.email;
  const entries = specs.map((spec) => ({ prow: byId.get(String(spec.id)), spec: { ...spec, _by: by } }))
    .filter((e) => e.prow);
  res.json({ ok: true, queued: entries.length });
  approveRowsInBackground(mboId, entries).catch((e) => console.error("[MBO] approve_selected background loop crashed:", e.message));
}));
tenantRouter.post("/review/approve_all", wrap(async (req, res) => {
  // Archives every matching row to History; no Shopify push happens here —
  // that's a separate, deliberate step from the History tab. Responds
  // immediately; see approveRowsInBackground.
  const mboId = req.mboId;
  const kind = req.body.kind || "mismatch";
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  const brands = (req.body.brands || []).filter(Boolean);
  // Never allow this to run unscoped — a stray click with no vendor selected
  // must not approve every brand at once (that's exactly what happened and
  // pushed 600+ wrong prices live). Pick at least one vendor first.
  if (!brands.length) return res.status(400).json({ ok: false, error: "select at least one vendor before approving all" });
  const where = `mbo_id=$1 AND state=$2 AND decision='pending' AND brand IN (${brands.map((_, i) => `$${i + 3}`).join(",")})`;
  const p = [mboId, state, ...brands];
  const rows = await q(`SELECT * FROM products WHERE ${where}`, p);
  const by = sec.currentUser(req)?.email;
  const spec = { ...req.body, custom_price: null, _by: by };
  res.json({ ok: true, queued: rows.length });
  approveRowsInBackground(mboId, rows.map((prow) => ({ prow, spec }))).catch((e) => console.error("[MBO] approve_all background loop crashed:", e.message));
}));
tenantRouter.post("/review/reject_all", wrap(async (req, res) => {
  const mboId = req.mboId;
  const kind = req.body.kind || "mismatch";
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  const brands = (req.body.brands || []).filter(Boolean);
  if (!brands.length) return res.status(400).json({ ok: false, error: "select at least one vendor before rejecting all" });
  const where = `mbo_id=$1 AND state=$2 AND decision='pending' AND brand IN (${brands.map((_, i) => `$${i + 5}`).join(",")})`;
  const p = [mboId, state, req.body.note || "", new Date().toISOString(), ...brands];
  const r = await q(`UPDATE products SET decision='rejected', note=$3, decided_at=$4 WHERE ${where} RETURNING id`, p);
  res.json({ ok: true, rejected: r.length, counts: await store.counts(mboId) });
}));
// Hides the current tab+vendor scope from the review queue permanently —
// an UPDATE flag (review_dismissed_at), never a delete. Product/price data
// is untouched; approving/rejecting/pushing to Shopify still works exactly
// as before for these rows, they just no longer show up here.
tenantRouter.post("/review/dismiss_view", wrap(async (req, res) => {
  const mboId = req.mboId;
  const removed = await store.dismissView(mboId, req.body.kind, (req.body.brands || []).filter(Boolean));
  res.json({ ok: true, removed, counts: await store.counts(mboId) });
}));

// ---------- history ----------
tenantRouter.get("/history", wrap(async (req, res) => {
  const brands = (req.query.brands || "").split(",").map((s) => s.trim()).filter(Boolean);
  res.json(await store.historyList(req.mboId, brands, (req.query.status || "").trim()));
}));
tenantRouter.post("/history/push", wrap(async (req, res) => {
  const mboId = req.mboId;
  const it = await one("SELECT * FROM review_history WHERE mbo_id=$1 AND id=$2", [mboId, req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const r = await pushRowPrice(mboId, it, it.final_price);
  await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE mbo_id=$3 AND id=$4",
    [r.status, new Date().toISOString(), mboId, it.id]);
  if (r.ok && it.key) { await store.promoteLiveToBase(mboId, q, it); await store.clearBuckets(mboId, q, it.key); }
  res.json({ ok: r.ok, status: r.status });
}));
tenantRouter.post("/history/push_all", wrap(async (req, res) => {
  const mboId = req.mboId;
  const brands = Array.isArray(req.body.brands) ? req.body.brands.filter(Boolean) : [];
  if (!brands.length) return res.status(400).json({ ok: false, error: "select at least one brand before retrying pushes" });
  const busy = runningPushJob(mboId);
  if (busy) return res.status(409).json({ ok: false, error: "a Shopify push is already running — wait for it to finish", job: busy });
  const rows = await q(`SELECT * FROM review_history
    WHERE mbo_id=$1 AND brand = ANY($2::text[]) AND (shopify_status IS NULL OR NOT (shopify_status LIKE 'updated%' OR shopify_status LIKE 'DRY RUN%'))
    ORDER BY approved_at LIMIT 1000`, [mboId, brands]);
  const label = `Retry / Push all — ${brands.length===1?brands[0]:brands.length+" brands"}`;
  const push = rows.length ? startPushJob(mboId, rows, label) : null;
  res.json({ ok: true, queued: rows.length, job: push?.job || null });
}));

// ---------- push job progress ----------
tenantRouter.get("/push/job", wrap(async (req, res) => res.json({ ok: true, job: getPushJob(req.mboId, req.query.id) })));
tenantRouter.get("/history/export", wrap(async (req, res) => {
  const rows = await q(`SELECT brand,url,base_price,live_price,currency,markup_pct,final_price,
    approved_by,approved_at,shopify_status FROM review_history WHERE mbo_id=$1 ORDER BY approved_at DESC`, [req.mboId]);
  await sendXlsx(res, "approval_history", rows);
}));

// ---------- alerts ----------
tenantRouter.get("/alerts", wrap(async (req, res) => {
  const mboId = req.mboId;
  const thr = Math.abs(parseFloat(req.query.threshold || "5")) || 5;
  const dir = req.query.direction || "all";
  const brands = (req.query.brands || "").split(",").map((s) => s.trim()).filter(Boolean);
  const p = [mboId]; let bc = "";
  if (brands.length) { p.push(brands); bc = `AND brand = ANY($${p.length}::text[])`; }
  p.push(thr);
  const rows = await q(`SELECT key,url,brand,live_price,prev,created_at,status,
      (live_price-prev) AS abs_change, ROUND(((live_price-prev)/prev*100)::numeric,2) AS pct
    FROM ( SELECT key,url,brand,live_price,status,created_at,
        LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) AS prev,
        ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) AS rn
      FROM price_history WHERE mbo_id=$1 AND live_price IS NOT NULL) t
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
tenantRouter.get("/alerts/brands", wrap(async (req, res) => {
  const rows = await q("SELECT brand, COUNT(DISTINCT key) c FROM price_history WHERE mbo_id=$1 AND brand<>'' GROUP BY brand ORDER BY c DESC", [req.mboId]);
  res.json({ brands: rows.map((r) => ({ brand: r.brand, count: Number(r.c) })) });
}));
tenantRouter.post("/alerts/email_mismatch", wrap(async (req, res) => {
  const body = req.body || {};
  const brands = Array.isArray(body.brands) ? body.brands.filter(Boolean)
    : String(body.brands || "").split(",").map((b) => b.trim()).filter(Boolean);
  const r = await sendMismatchReport(req.mboId, body.to, brands);
  res.status(r.ok ? 200 : 400).json(r);
}));

// ---------- integrations (one Shopify store per tenant) ----------
tenantRouter.get("/integration", wrap(async (req, res) => {
  const mboId = req.mboId;
  const c = await store.getStoreIntegration(mboId);
  res.json({ shop_domain: c?.shop_domain || "", api_version: c?.api_version || "2024-10",
    dry_run: c ? !!(c.dry_run) : true, has_token: !!(c?.access_token),
    price_url_source: await getPriceUrlSource(mboId) });
}));
tenantRouter.post("/integration/save", wrap(async (req, res) => {
  const mboId = req.mboId;
  const d = req.body || {};
  const ex = await store.getStoreIntegration(mboId);
  const token = (d.access_token || "").trim() ? encrypt(d.access_token.trim()) : (ex?.access_token || "");
  await q(`INSERT INTO integrations(mbo_id,brand,shop_domain,access_token,api_version,dry_run,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(mbo_id,brand) DO UPDATE SET shop_domain=excluded.shop_domain,
      access_token=excluded.access_token, api_version=excluded.api_version, dry_run=excluded.dry_run, updated_at=excluded.updated_at`,
    [mboId, store.STORE_KEY, (d.shop_domain || "").trim(), token, (d.api_version || "2024-10").trim(),
      d.dry_run ? 1 : 0, new Date().toISOString()]);
  if (d.price_url_source) await setPriceUrlSource(mboId, d.price_url_source);
  invalidateShopifyCfg(mboId);
  res.json({ ok: true });
}));
tenantRouter.post("/integration/verify", wrap(async (req, res) => res.json(await verifyStore(req.mboId))));
tenantRouter.get("/integrations", wrap(async (req, res) => res.json({ brands: await store.integrationBrands(req.mboId) })));
tenantRouter.get("/push/cad", wrap(async (req, res) => res.json({ default: "USD", cad_brands: [...(await store.cadBrandSet(req.mboId))] })));
tenantRouter.post("/push/cad", wrap(async (req, res) => res.json({ ok: true, cad_brands: await store.setCadBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/usd", wrap(async (req, res) => res.json({ default: "native", usd_brands: [...(await store.usdFetchBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/usd", wrap(async (req, res) => res.json({ ok: true, usd_brands: await store.setUsdFetchBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/range_high", wrap(async (req, res) => res.json({ range_high_brands: [...(await store.rangeHighBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/range_high", wrap(async (req, res) => res.json({ ok: true, range_high_brands: await store.setRangeHighBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/gentle", wrap(async (req, res) => res.json({ gentle_brands: [...(await store.gentleBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/gentle", wrap(async (req, res) => res.json({ ok: true, gentle_brands: await store.setGentleBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/proxy", wrap(async (req, res) => res.json({ proxy_configured: !!config.fetchProxyUrl, proxy_brands: [...(await store.proxyBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/proxy", wrap(async (req, res) => res.json({ ok: true, proxy_brands: await store.setProxyBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/local_only", wrap(async (req, res) => res.json({ relay_configured: !!config.fetchRelayUrl, local_only_brands: [...(await store.localOnlyBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/local_only", wrap(async (req, res) => res.json({ ok: true, local_only_brands: await store.setLocalOnlyBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/native_currency", wrap(async (req, res) => res.json({ native_currency_brands: await store.nativeCurrencyBrands(req.mboId) })));
tenantRouter.post("/fetch/native_currency", wrap(async (req, res) => res.json({ ok: true, native_currency_brands: await store.setNativeCurrencyBrands(req.mboId, req.body.brands || {}) })));
tenantRouter.get("/fetch/woo_api", wrap(async (req, res) => res.json({ woo_api_brands: [...(await store.wooApiBrandSet(req.mboId))] })));
tenantRouter.post("/fetch/woo_api", wrap(async (req, res) => res.json({ ok: true, woo_api_brands: await store.setWooApiBrands(req.mboId, req.body.brands ?? req.body.list ?? "") })));
tenantRouter.get("/fetch/relay_params", wrap(async (req, res) => res.json({ relay_append_params: await store.relayAppendParams(req.mboId) })));
tenantRouter.post("/fetch/relay_params", wrap(async (req, res) => res.json({ ok: true, relay_append_params: await store.setRelayAppendParams(req.mboId, req.body.params || {}) })));
tenantRouter.post("/shopify/update_price", wrap(async (req, res) => {
  const productUrl = String(req.body.product_url || "").trim();
  const newPrice = req.body.new_price;
  if (!productUrl) return res.status(400).json({ ok: false, error: "product_url required" });
  if (newPrice === "" || newPrice == null || Number.isNaN(Number(newPrice))) {
    return res.status(400).json({ ok: false, error: "valid new_price required" });
  }
  const result = await pushPrice(req.mboId, productUrl, Number(newPrice));
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
tenantRouter.get("/export", wrap(async (req, res) => {
  const mboId = req.mboId;
  const kind = req.query.kind || "all";
  const stateWhere = { all: "1=1", mismatch: "state='mismatch'", error: "state='error'", approved: "decision='approved'" }[kind] || "1=1";
  const brands = (req.query.brands || "").split(",").map((b) => b.trim()).filter(Boolean);
  const params = [mboId];
  const cols = "id,brand,platform,url,base_price,live_price,currency,status,state,delta,decision,markup_pct,final_price";
  let rows, suffix;
  if (req.query.source === "imported") {
    // "Sheet products" runs are scoped to whatever's staged in
    // import_catalog, not a brand filter — join to it so the export is
    // exactly the rows that ran, regardless of how many brands they span.
    let where = "p.mbo_id=$1 AND " + stateWhere.replace(/^(state|decision)/, "p.$1");
    if (brands.length) { where += ` AND p.brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; params.push(...brands); }
    rows = await q(`SELECT ${cols.split(",").map((c) => "p." + c).join(",")}
      FROM products p JOIN import_catalog c ON c.key = p.key AND c.mbo_id = p.mbo_id WHERE ${where} ORDER BY p.brand, p.id`, params);
    suffix = "_sheet";
  } else {
    let where = "mbo_id=$1 AND " + stateWhere;
    if (brands.length) { where += ` AND brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; params.push(...brands); }
    rows = await q(`SELECT ${cols} FROM products WHERE ${where} ORDER BY brand, id`, params);
    suffix = brands.length ? `_${brands.length}brands` : "";
  }
  await sendXlsx(res, `mbo_${kind}${suffix}`, rows);
}));

// ---------- owner console (tenant-scoped) ----------
tenantRouter.get("/admin/sessions", sec.ownerOnly, (req, res) => res.json({ sessions: sec.activeSessions(req.mboId) }));
tenantRouter.get("/admin/users", sec.ownerOnly, wrap(async (req, res) => res.json({ users: (await sec.listUsers(req.mboId)).map((u) => ({ ...u, created_at: String(u.created_at) })) })));
tenantRouter.post("/admin/users/role", sec.ownerOnly, wrap(async (req, res) => {
  const role = String(req.body.role || "");
  if (!sec.ROLES.has(role)) return res.status(400).json({ ok: false, error: "invalid role" });
  await sec.setRole(req.mboId, req.body.email, role);
  sec.clearRoleCache();
  res.json({ ok: true });
}));
tenantRouter.post("/admin/users/delete", sec.ownerOnly, wrap(async (req, res) => {
  if (req.body.email === sec.currentUser(req)?.email) return res.status(400).json({ ok: false, error: "can't delete yourself" });
  await sec.deleteUser(req.mboId, req.body.email);
  sec.clearRoleCache();
  res.json({ ok: true });
}));

// ---------- platform super-admin (cross-tenant, no req.mboId) ----------
// Mounted at the MORE SPECIFIC path "/api/superadmin" and registered BEFORE
// the tenantRouter's blanket "/api" mount — Express matches middleware in
// registration order, not by path specificity, so this order is load-bearing:
// mounting tenantRouter first would let its resolveTenant (which 403s any
// super_admin) intercept every /api/superadmin/* request before it ever
// reached superRouter's own sec.superAdminOnly gate.
const superRouter = express.Router();
superRouter.use(sec.superAdminOnly);
superRouter.get("/mbos", wrap(async (req, res) => {
  const rows = await q(`SELECT m.id, m.slug, m.name, m.status, m.created_at,
      (SELECT COUNT(*) FROM products p WHERE p.mbo_id=m.id) product_count,
      (SELECT COUNT(*) FROM products p WHERE p.mbo_id=m.id AND p.state='error') error_count,
      (SELECT COUNT(*) FROM products p WHERE p.mbo_id=m.id AND p.state='mismatch') mismatch_count,
      (SELECT COUNT(*) FROM users u WHERE u.mbo_id=m.id) user_count
    FROM mbo m ORDER BY m.id`);
  res.json({ mbos: rows });
}));
superRouter.get("/mbos/:id/insights/errors", wrap(async (req, res) => {
  const mboId = Number(req.params.id);
  if (!Number.isInteger(mboId)) return res.status(400).json({ ok: false, error: "invalid mbo id" });
  res.json({ items: await store.errorMeter(mboId) });
}));
superRouter.get("/mbos/:id/users", wrap(async (req, res) => {
  const mboId = Number(req.params.id);
  if (!Number.isInteger(mboId)) return res.status(400).json({ ok: false, error: "invalid mbo id" });
  res.json({ users: (await sec.listUsers(mboId)).map((u) => ({ ...u, created_at: String(u.created_at) })) });
}));
superRouter.get("/sessions", (req, res) => res.json({ sessions: sec.superAdminActiveSessions() }));
app.use("/api/superadmin", superRouter);

app.use("/api", tenantRouter);

// ---------- client (SPA) ----------
if (fs.existsSync(CLIENT_DIST)) {
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
    "<p>Client build not found — run the Vite client build.</p>"));
}

// ---------- boot ----------
const p = await ping();
if (!p.ok) { console.error("[MBO] Supabase FAILED:", p.msg); process.exit(1); }
await store.initStore();
pipe.setDefault('data_source', 'database');
// Restore Tenant #1's saved FX overrides (pre-existing behavior, preserved
// exactly). Other tenants start with no override until they explicitly set
// one via /api/fx/override — fx.js's getOverrides()/rates() handle a tenant
// with no Map entry gracefully (empty overrides).
setOverrides(1, { USD: await store.getMeta(1, 'fx_override_usd'), CAD: await store.getMeta(1, 'fx_override_cad') });
// Super-admin seeding is opt-in and uses a SEPARATE email from any tenant
// owner (see config.js's superAdminEmail comment for the 2026-07-23
// incident this fixes) — blank (default) means no seeding happens at all,
// so an existing tenant-owner login is never silently repurposed.
if (config.superAdminEmail && config.superAdminPassword) {
  const seeded = await sec.seedSuperAdmin(config.superAdminEmail, config.superAdminPassword);
  if (seeded) console.log("[MBO] Super-admin:", seeded);
}
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

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(`[MBO] ${signal} received — shutting down gracefully`);
  server.close(() => { pool.end().catch(() => {}).finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => console.error("[MBO] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[MBO] uncaughtException:", err));
