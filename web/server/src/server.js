// MBO Tracker — Express server (Supabase-backed). Mirrors the Flask API surface.
import express from "express";
import session from "express-session";
import multer from "multer";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { q, one, ping } from "./db.js";
import * as sec from "./security.js";
import * as store from "./store.js";
import { encrypt } from "./crypto.js";
import { snapshot, rates } from "./fx.js";
import * as pipe from "./pipeline.js";
import { sendMismatchReport } from "./mailer.js";
import { pushPrice, verifyStore } from "./shopify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(session({
  secret: config.secret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 12 * 3600 * 1000 },
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
app.get("/api/health", (req, res) => res.json({ ok: true, running: pipe.STATE.running, phase: pipe.STATE.phase }));

// gate everything else
app.use("/api", sec.guard);

app.get("/api/me", (req, res) => res.json(sec.currentUser(req) || {}));
app.get("/api/logout", (req, res) => { sec.logoutUser(req); res.json({ ok: true }); });

// ---------- meta / fx / insights ----------
app.get("/api/meta", wrap(async (req, res) => {
  res.json({ counts: await store.counts(), alerts: await store.alertCount(5),
    last_import: await store.getMeta("last_import"), last_import_rows: await store.getMeta("last_import_rows") });
}));
app.get("/api/fx", wrap(async (req, res) => res.json({ rates: await snapshot() })));
app.get("/api/vendors", wrap(async (req, res) => res.json({ vendors: await store.vendors(req.query.kind) })));

app.get("/api/insights", wrap(async (req, res) => {
  const c = await store.counts();
  const topMis = await q("SELECT brand, COUNT(*) c FROM products WHERE state='mismatch' AND brand<>'' GROUP BY brand ORDER BY c DESC LIMIT 10");
  const topProd = await q("SELECT brand, COUNT(*) c FROM products WHERE brand<>'' GROUP BY brand ORDER BY c DESC LIMIT 10");
  const agg = await one(`SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) over_,
    COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) under_,
    COALESCE(AVG(ABS(delta)),0) avgd FROM products WHERE state='mismatch'`);
  const vend = Number((await one("SELECT COUNT(DISTINCT brand) c FROM products WHERE brand<>''")).c);
  const av = await one("SELECT COALESCE(SUM(final_price),0) v, COUNT(*) c FROM review_history");
  res.json({ counts: c, vendors: vend,
    top_mismatch: topMis.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    top_products: topProd.map((r) => ({ brand: r.brand, count: Number(r.c) })),
    exposure: { over: Number(agg.over_), under: Number(agg.under_), avg: Number(agg.avgd) },
    approved_value: Number(av.v), approved_count: Number(av.c), fx: await snapshot() });
}));

// ---------- pipeline ----------
app.post("/api/pipe/config", (req, res) => { Object.assign(pipe.CONFIG, req.body || {}); res.json({ ok: true, config: pipe.CONFIG }); });
app.post("/api/pipe/start", wrap(async (req, res) => {
  if (pipe.STATE.running) return res.status(409).json({ error: "already running" });
  if ((await store.counts()).total === 0) return res.status(400).json({ error: "no products — import a sheet" });
  Object.assign(pipe.STATE, { running: true, abort: false, phase: "main", completed: 0, matched: 0,
    mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0, retry_recovered: 0, started_at: Date.now() });
  pipe.LOG.length = 0; pipe.LOGMETA.offset = 0;
  pipe.startPipeline();
  res.json({ ok: true });
}));
app.post("/api/pipe/abort", (req, res) => { pipe.STATE.abort = true; res.json({ ok: true }); });
app.post("/api/pipe/clear_log", (req, res) => { pipe.LOG.length = 0; pipe.LOGMETA.offset = 0; res.json({ ok: true }); });
app.get("/api/pipe/status", (req, res) => {
  const cursor = parseInt(req.query.cursor || "0", 10);
  const start = Math.max(0, cursor - pipe.LOGMETA.offset);
  const entries = pipe.LOG.slice(start);
  const total = pipe.LOGMETA.offset + pipe.LOG.length;
  const s = pipe.STATE;
  res.json({ running: s.running, phase: s.phase, total_rows: s.total_rows, pre_done: s.pre_done,
    completed: s.completed, current_row: s.pre_done + s.completed, matched: s.matched,
    mismatch: s.mismatch, errors: s.errors, retry_total: s.retry_total, retry_completed: s.retry_completed,
    retry_recovered: s.retry_recovered, elapsed: s.started_at ? Math.floor((Date.now() - s.started_at) / 1000) : 0,
    message: s.message, config: pipe.CONFIG, cursor: total, entries, log_total: total });
});

// ---------- import ----------
app.post("/api/import/preview", upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "no file" });
  global.__lastUpload = req.file.buffer;
  try { const p = store.previewSheet(req.file.buffer); res.json({ ok: true, path: "uploaded", ...p }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));
app.post("/api/import", upload.single("file"), wrap(async (req, res) => {
  const buf = req.file ? req.file.buffer : global.__lastUpload;
  if (!buf) return res.status(400).json({ ok: false, error: "no file" });
  try { const r = await store.importSheet(buf, { replace: true }); res.json({ ok: true, ...r, counts: await store.counts() }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));

// ---------- review ----------
app.get("/api/review/items", wrap(async (req, res) => {
  const brands = (req.query.brands || "").split(",").filter(Boolean);
  res.json(await store.reviewItems(req.query.kind || "mismatch", brands));
}));
app.get("/api/review/brands", wrap(async (req, res) => res.json({ brands: (await store.vendors(req.query.kind)).map((v) => ({ brand: v.vendor, count: v.count })) })));

async function approveOne(client, prow, body) {
  const markup = body.markup_pct === "" || body.markup_pct == null ? 0 : Number(body.markup_pct);
  const custom = body.custom_price === "" || body.custom_price == null ? null : Number(body.custom_price);
  const ref = body.ref || "live", convert = body.convert !== false;
  const rate = convert ? (await rates())[(prow.currency || "INR").toUpperCase()] || 1 : 1;
  const final = store.computeFinal(prow.base_price, prow.live_price, prow.currency, ref, markup, custom, convert, rate);
  await store.archiveApproved(client, prow, final, markup, ref, body.note || "", body._by);
  return final;
}
app.post("/api/review/decide", wrap(async (req, res) => {
  const it = await one("SELECT * FROM products WHERE id=$1", [req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const by = sec.currentUser(req)?.email;
  if (req.body.decision === "approved") {
    const client = await (await import("./db.js")).pool.connect();
    try { const final = await approveOne(client, it, { ...req.body, _by: by }); res.json({ ok: true, final_price: final, archived: true }); }
    finally { client.release(); }
  } else {
    await q("UPDATE products SET decision=$1,note=$2,decided_at=$3 WHERE id=$4",
      [req.body.decision, req.body.note || "", new Date().toISOString(), req.body.row]);
    res.json({ ok: true });
  }
}));
app.post("/api/review/approve_all", wrap(async (req, res) => {
  const kind = req.body.kind || "mismatch";
  const state = { mismatch: "mismatch", error: "error", resolved: "matched" }[kind] || "mismatch";
  const brands = (req.body.brands || []).filter(Boolean);
  let where = "state=$1"; const p = [state];
  if (brands.length) { where += ` AND brand IN (${brands.map((_, i) => `$${i + 2}`).join(",")})`; p.push(...brands); }
  const rows = await q(`SELECT * FROM products WHERE ${where}`, p);
  const by = sec.currentUser(req)?.email;
  const { pool } = await import("./db.js"); const client = await pool.connect();
  let n = 0;
  try { await client.query("BEGIN");
    for (const r of rows) { await approveOne(client, r, { ...req.body, custom_price: null, _by: by }); n++; }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  res.json({ ok: true, approved: n });
}));

// ---------- history ----------
app.get("/api/history", wrap(async (req, res) => res.json(await store.historyList((req.query.brand || "").trim()))));
app.post("/api/history/push", wrap(async (req, res) => {
  const it = await one("SELECT * FROM review_history WHERE id=$1", [req.body.row]);
  if (!it) return res.status(404).json({ ok: false, error: "unknown row" });
  const r = await pushPrice(it.url, it.final_price);
  await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3",
    [r.status, new Date().toISOString(), it.id]);
  res.json({ ok: r.ok, status: r.status });
}));
app.post("/api/history/push_all", wrap(async (req, res) => {
  const rows = await q("SELECT * FROM review_history WHERE shopify_status IS NULL ORDER BY approved_at LIMIT 500");
  let ok = 0, fail = 0;
  for (const it of rows) { const r = await pushPrice(it.url, it.final_price);
    await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3", [r.status, new Date().toISOString(), it.id]);
    r.ok ? ok++ : fail++; }
  res.json({ ok: true, pushed: ok, failed: fail });
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
    dry_run: !!(c?.dry_run), has_token: !!(c?.access_token) });
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
  res.json({ ok: true });
}));
app.post("/api/integration/verify", wrap(async (req, res) => res.json(await verifyStore())));
app.get("/api/integrations", wrap(async (req, res) => res.json({ brands: await store.integrationBrands() })));

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
app.post("/api/admin/users/role", sec.ownerOnly, wrap(async (req, res) => { await sec.setRole(req.body.email, req.body.role); res.json({ ok: true }); }));
app.post("/api/admin/users/delete", sec.ownerOnly, wrap(async (req, res) => {
  if (req.body.email === sec.currentUser(req)?.email) return res.status(400).json({ ok: false, error: "can't delete yourself" });
  await sec.deleteUser(req.body.email); res.json({ ok: true });
}));

// ---------- client (SPA) ----------
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
} else {
  app.get("/", (req, res) => res.type("html").send(
    "<h2 style='font-family:sans-serif'>MBO Tracker API (Node) is running.</h2>" +
    "<p>Client build not found — run the Vite client build (Phase 4).</p>"));
}

// ---------- boot ----------
const p = await ping();
if (!p.ok) { console.error("[MBO] Supabase FAILED:", p.msg); process.exit(1); }
const seeded = await sec.seedOwner(config.adminEmail, config.adminPassword);
if (seeded) console.log("[MBO] Owner:", seeded);
app.listen(config.port, config.host, () => console.log(`[MBO] http://${config.host}:${config.port}`));
