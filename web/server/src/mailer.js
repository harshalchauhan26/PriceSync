import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { q } from "./db.js";
import { config } from "./config.js";

const COLS = ["brand", "url", "base_price", "live_price", "currency", "status", "state",
  "delta", "decision", "final_price"];

async function stateRows(states, brands) {
  const p = [...states];
  let where = `state IN (${states.map((_, i) => `$${i + 1}`).join(",")})`;
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${i + 1 + states.length}`).join(",")})`;
    p.push(...brands);
  }
  return q(`SELECT brand,url,base_price,live_price,currency,status,state,delta,
    decision,final_price FROM products WHERE ${where}
    ORDER BY state, brand, ABS(COALESCE(delta,0)) DESC`, p);
}
const mismatchRows = (brands) => stateRows(["mismatch"], brands);

async function alertRows(threshold = 5) {
  try {
    return await q(`SELECT brand,url,prev,live_price,
        ROUND(((live_price-prev)/prev*100)::numeric,2) AS pct
      FROM ( SELECT brand,url,live_price,
          LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) AS prev,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) AS rn
        FROM price_history WHERE live_price IS NOT NULL) t
      WHERE rn=1 AND prev IS NOT NULL AND prev<>0
        AND ABS((live_price-prev)/prev*100) >= $1
      ORDER BY brand, ABS((live_price-prev)/prev*100) DESC LIMIT 1000`, [Math.abs(threshold)]);
  } catch { return []; }
}

function safeSheetName(name, used) {
  let base = String(name || "").replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "brand";
  let n = base, i = 2;
  while (used.has(n.toLowerCase())) {
    const suffix = ` (${i++})`;
    n = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(n.toLowerCase());
  return n;
}

function styleHeader(ws) {
  ws.getRow(1).eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A40" } };
    c.font = { color: { argb: "FFFFFFFF" }, bold: true };
  });
}

function addDataRows(ws, rows) {
  rows.forEach((r) => {
    const row = ws.addRow(COLS.map((c) => r[c]));
    const fill = r.state === "mismatch" ? "FFFFF2CC" : r.state === "error" ? "FFF8CBAD" : null;
    if (fill) row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }; });
  });
}

function buildWorkbook(rows, alerts) {
  const wb = new ExcelJS.Workbook();
  const used = new Set();

  const byBrand = new Map();
  for (const r of rows) {
    const b = (r.brand || "(no brand)").replace(/^www\./, "");
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push(r);
  }

  const nMis = (list) => list.filter((r) => r.state === "mismatch").length;
  const nErr = (list) => list.filter((r) => r.state === "error").length;
  const summary = wb.addWorksheet(safeSheetName("Summary", used));
  summary.addRow(["brand", "mismatches", "errors"]);
  styleHeader(summary);
  [...byBrand.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([b, list]) => summary.addRow([b, nMis(list), nErr(list)]));
  summary.addRow([]);
  summary.addRow(["TOTAL", nMis(rows), nErr(rows)]);

  for (const [b, list] of byBrand) {
    const ws = wb.addWorksheet(safeSheetName(b, used));
    ws.addRow(COLS);
    styleHeader(ws);
    addDataRows(ws, list);
  }

  if (alerts && alerts.length) {
    const ws = wb.addWorksheet(safeSheetName("Price Alerts", used));
    ws.addRow(["brand", "url", "prev_price", "live_price", "pct_change"]);
    styleHeader(ws);
    alerts.forEach((a) => ws.addRow([a.brand, a.url, a.prev, a.live_price, a.pct]));
  }

  return wb;
}

function transport() {
  const { host, port, user, pass } = config.smtp;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

function recipient(to) {
  return (to || config.smtp.to || "").trim();
}

// Shared guard for every mail entry point: returns { ok:false, error } when
// email can't be sent (unconfigured SMTP / no recipient) so callers can log
// and move on without throwing inside the pipeline.
function mailGuard(to) {
  const { user, pass } = config.smtp;
  to = recipient(to);
  if (!user || !pass) return { ok: false, error: "email not configured (SMTP_USER/SMTP_PASS)" };
  if (!to) return { ok: false, error: "no recipient (ALERT_TO)" };
  return { ok: true, to };
}

const today = () => new Date().toISOString().slice(0, 10);

// One flat, Excel-autofilterable sheet from an array of row objects.
function flatSheet(wb, sheetName, columns, rows) {
  const ws = wb.addWorksheet(safeSheetName(sheetName, new Set()));
  ws.addRow(columns.map((c) => c.header));
  styleHeader(ws);
  rows.forEach((r) => {
    const row = ws.addRow(columns.map((c) => r[c.key]));
    const fill = r.state === "mismatch" ? "FFFFF2CC" : r.state === "error" ? "FFF8CBAD"
      : r.state === "matched" ? "FFE2EFDA" : null;
    if (fill) row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }; });
  });
  ws.columns.forEach((c) => { c.width = 24; });
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

// ---- pipeline lifecycle emails ----

// Sent the moment a run kicks off.
export async function sendPipelineStarted({ to, total, runId } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  await transport().sendMail({
    from, to: g.to,
    subject: `MBO Tracker — pipeline started: ${total ?? "?"} product(s) (${today()})`,
    text: `A pricing pipeline run just started.\n\n` +
      `• Products to check: ${total ?? "?"}\n• Run id: ${runId || "—"}\n\n` +
      `You'll get a note at the halfway mark and a full report with two ` +
      `attached sheets when it finishes.\n\n— MBO Tracker`,
  });
  return { ok: true, to: g.to };
}

// Sent once, when the main pass crosses 50%.
export async function sendPipelineProgress({ to, done, total } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  const pct = total ? Math.round((done / total) * 100) : 50;
  await transport().sendMail({
    from, to: g.to,
    subject: `MBO Tracker — pipeline ${pct}% done (${done}/${total}) (${today()})`,
    text: `The pricing pipeline run is about halfway.\n\n` +
      `• Checked so far: ${done} of ${total} (${pct}%)\n\n— MBO Tracker`,
  });
  return { ok: true, to: g.to };
}

// Sent after the safe-retry pass — how many fetch errors recovered vs remain.
export async function sendErrorsResolved({ to, stats } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  const total = stats?.retry_total ?? 0;
  const recovered = stats?.retry_recovered ?? 0;
  const remaining = Math.max(0, total - recovered);
  const rows = await stateRows(["error"]);
  const wb = new ExcelJS.Workbook();
  flatSheet(wb, "Remaining Errors", [
    { key: "brand", header: "brand" }, { key: "url", header: "url" },
    { key: "base_price", header: "base_price" }, { key: "status", header: "status" },
  ], rows);
  const attach = rows.length
    ? [{ filename: `remaining_errors_${today()}.xlsx`, content: Buffer.from(await wb.xlsx.writeBuffer()) }]
    : [];
  await transport().sendMail({
    from, to: g.to,
    subject: `MBO Tracker — error retry done: ${recovered}/${total} recovered, ${remaining} remain (${today()})`,
    text: `The safe-retry pass finished re-checking fetch errors.\n\n` +
      `• Retried: ${total}\n• Recovered: ${recovered}\n• Still failing: ${remaining}\n\n` +
      (attach.length ? `The attached sheet lists the ${rows.length} row(s) still in error.\n\n` : ``) +
      `— MBO Tracker`,
    attachments: attach,
  });
  return { ok: true, to: g.to, recovered, remaining };
}

// Sent when the whole run is done. TWO attachments:
//   1. price_updates  — products actually pushed to Shopify in the last 24h
//      (approved in Review and confirmed updated) = "latest price updates".
//   2. price_fetch_all — every product the pipeline holds, with a state column
//      (matched / mismatch / error) so it filters in Excel = "latest fetch".
export async function sendPipelineComplete({ to, stats } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;

  const updated = await q(
    `SELECT brand, url, base_price, final_price, currency, status, shopify_status, approved_at
       FROM review_history
      WHERE (shopify_status LIKE 'updated%' OR shopify_status LIKE 'DRY RUN%')
        AND approved_at >= now() - interval '24 hours'
      ORDER BY approved_at DESC`).catch(() => []);
  const allRows = await q(
    `SELECT brand, url, base_price, live_price, currency, state, status, delta
       FROM products ORDER BY state, brand, ABS(COALESCE(delta,0)) DESC`).catch(() => []);

  const wbUpdated = new ExcelJS.Workbook();
  flatSheet(wbUpdated, "Price Updates", [
    { key: "brand", header: "brand" }, { key: "url", header: "url" },
    { key: "base_price", header: "base_price" }, { key: "final_price", header: "pushed_price" },
    { key: "currency", header: "currency" }, { key: "shopify_status", header: "shopify_status" },
    { key: "approved_at", header: "pushed_at" },
  ], updated);

  const wbAll = new ExcelJS.Workbook();
  flatSheet(wbAll, "All Fetched", [
    { key: "brand", header: "brand" }, { key: "url", header: "url" },
    { key: "base_price", header: "base_price" }, { key: "live_price", header: "live_price" },
    { key: "currency", header: "currency" }, { key: "state", header: "state" },
    { key: "delta", header: "delta" }, { key: "status", header: "status" },
  ], allRows);

  const parts = [];
  if (stats) parts.push(
    `${stats.completed ?? 0} product(s) checked — ${stats.matched ?? 0} matched, ` +
    `${stats.mismatch ?? 0} mismatched, ${stats.errors ?? 0} error(s)` +
    (stats.recovered ? ` (${stats.recovered} recovered on retry)` : "") +
    (stats.elapsed != null ? ` in ${stats.elapsed}s` : ""));
  parts.push(`${updated.length} price update(s) pushed to Shopify in the last 24h`);
  parts.push(`${allRows.length} product(s) in the latest fetch snapshot`);

  await transport().sendMail({
    from, to: g.to,
    subject: `MBO Tracker — pipeline finished: ${stats ? `${stats.completed ?? 0} checked, ` : ""}${stats?.mismatch ?? 0} mismatch, ${stats?.errors ?? 0} error (${today()})`,
    text: `A pricing pipeline run just finished.\n\n` +
      parts.map((p) => `• ${p}`).join("\n") + `\n\n` +
      `Two sheets are attached:\n` +
      `  1. price_updates — products whose price was updated (pushed to Shopify, last 24h).\n` +
      `  2. price_fetch_all — every product from the latest fetch; filter the "state" ` +
      `column into matched / mismatch / error.\n\n` +
      `Mismatches are PENDING APPROVAL — nothing is pushed automatically.\n\n— MBO Tracker`,
    attachments: [
      { filename: `price_updates_${today()}.xlsx`, content: Buffer.from(await wbUpdated.xlsx.writeBuffer()) },
      { filename: `price_fetch_all_${today()}.xlsx`, content: Buffer.from(await wbAll.xlsx.writeBuffer()) },
    ],
  });
  return { ok: true, to: g.to, updated: updated.length, all: allRows.length };
}

export async function sendMismatchReport(to, brands) {
  const { user, pass, from } = config.smtp;
  to = recipient(to);
  if (!user || !pass) return { ok: false, error: "email not configured (SMTP_USER/SMTP_PASS)" };
  if (!to) return { ok: false, error: "no recipient (ALERT_TO)" };
  const rows = await mismatchRows(brands);
  const wb = buildWorkbook(rows, []);
  const today = new Date().toISOString().slice(0, 10);
  const scope = brands && brands.length ? ` for ${brands.length} brand(s)` : "";
  await transport().sendMail({
    from, to, subject: `MBO Tracker — ${rows.length} price mismatches${scope} (${today})`,
    text: `MBO Tracker detected ${rows.length} price mismatch(es)${scope} awaiting review.\n\n` +
      `The attached workbook has one sheet per brand (plus a Summary tab). These are ` +
      `PENDING APPROVAL — nothing has been pushed to any store.\n\n— MBO Tracker`,
    attachments: [{ filename: `price_mismatches_${today}.xlsx`, content: Buffer.from(await wb.xlsx.writeBuffer()) }],
  });
  return { ok: true, count: rows.length, to };
}

// Always sends after a pipeline run (any number of products). Attaches a
// per-brand workbook covering mismatches AND fetch errors when any exist.
export async function sendPipelineReport({ to, threshold = 5, stats = null } = {}) {
  const { user, pass, from } = config.smtp;
  to = recipient(to);
  if (!user || !pass) return { ok: false, error: "email not configured (SMTP_USER/SMTP_PASS)" };
  if (!to) return { ok: false, error: "no recipient (ALERT_TO)" };
  const [rows, alerts] = await Promise.all([stateRows(["mismatch", "error"]), alertRows(threshold)]);
  const mism = rows.filter((r) => r.state === "mismatch").length;
  const errs = rows.filter((r) => r.state === "error").length;
  const today = new Date().toISOString().slice(0, 10);
  const brandCount = new Set(rows.map((r) => (r.brand || "").replace(/^www\./, ""))).size;
  const parts = [];
  if (stats) parts.push(
    `${stats.completed ?? 0} product(s) checked — ${stats.matched ?? 0} matched, ` +
    `${stats.mismatch ?? 0} mismatched, ${stats.errors ?? 0} error(s)` +
    (stats.recovered ? ` (${stats.recovered} recovered on retry)` : "") +
    (stats.elapsed != null ? ` in ${stats.elapsed}s` : ""));
  if (mism) parts.push(`${mism} price mismatch(es) pending review across ${brandCount} brand(s)`);
  if (errs) parts.push(`${errs} fetch error(s) needing attention`);
  if (alerts.length) parts.push(`${alerts.length} price alert(s) (>=${threshold}% move)`);
  if (!mism && !errs && !alerts.length) parts.push("all prices matched — nothing pending");
  const attach = (rows.length || alerts.length)
    ? [{ filename: `pipeline_report_${today}.xlsx`,
        content: Buffer.from(await buildWorkbook(rows, alerts).xlsx.writeBuffer()) }]
    : [];
  await transport().sendMail({
    from, to,
    subject: `MBO Tracker — pipeline finished: ${stats ? `${stats.completed ?? 0} checked, ` : ""}${mism} mismatch, ${errs} error (${today})`,
    text: `A pricing pipeline run just finished.\n\n` +
      parts.map((p) => `• ${p}`).join("\n") + `\n\n` +
      (attach.length
        ? `The attached workbook has one sheet per brand covering every mismatch and fetch error (plus a Summary tab` +
          (alerts.length ? ` and a Price Alerts tab` : ``) + `). Mismatches are PENDING APPROVAL ` +
          `— nothing has been pushed to any store.`
        : `No attachment — there were no mismatches, errors or alerts.`) +
      `\n\n— MBO Tracker`,
    attachments: attach,
  });
  return { ok: true, count: mism, errors: errs, alerts: alerts.length, brands: brandCount, to };
}
