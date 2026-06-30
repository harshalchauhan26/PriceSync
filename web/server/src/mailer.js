// Email the mismatch report (port of the smtplib flow -> nodemailer).
// The attached workbook carries ONE worksheet per brand (plus a Summary tab and,
// when relevant, a Price Alerts tab) so each brand's mismatches are separated.
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { q } from "./db.js";
import { config } from "./config.js";

const COLS = ["brand", "url", "base_price", "live_price", "currency", "status", "state",
  "delta", "decision", "final_price"];

// Pull every pending mismatch, optionally narrowed to a set of brands. Ordered by
// brand then by largest absolute delta so each brand's sheet leads with its
// biggest gaps.
async function mismatchRows(brands) {
  let where = "state='mismatch'"; const p = [];
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${i + 1}`).join(",")})`;
    p.push(...brands);
  }
  return q(`SELECT brand,url,base_price,live_price,currency,status,state,delta,
    decision,final_price FROM products WHERE ${where}
    ORDER BY brand, ABS(COALESCE(delta,0)) DESC`, p);
}

// Latest-vs-previous price moves >= threshold% (mirrors /api/alerts), for the
// optional alerts tab in the auto report.
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

// Excel sheet names: <=31 chars, none of \ / ? * [ ] :, must be unique & non-blank.
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

// Build a workbook with a Summary tab, one tab per brand, and (optionally) an
// alerts tab. `rows` are mismatch products; `alerts` are price-move rows.
function buildWorkbook(rows, alerts) {
  const wb = new ExcelJS.Workbook();
  const used = new Set();

  // Group mismatches by brand, preserving the brand-sorted order from the query.
  const byBrand = new Map();
  for (const r of rows) {
    const b = (r.brand || "(no brand)").replace(/^www\./, "");
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push(r);
  }

  // Summary tab.
  const summary = wb.addWorksheet(safeSheetName("Summary", used));
  summary.addRow(["brand", "mismatches"]);
  styleHeader(summary);
  [...byBrand.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([b, list]) => summary.addRow([b, list.length]));
  summary.addRow([]);
  summary.addRow(["TOTAL", rows.length]);

  // One tab per brand.
  for (const [b, list] of byBrand) {
    const ws = wb.addWorksheet(safeSheetName(b, used));
    ws.addRow(COLS);
    styleHeader(ws);
    addDataRows(ws, list);
  }

  // Alerts tab (only when there are alert rows).
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
  return nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });
}

function recipient(to) {
  return (to || config.smtp.to || "").trim();
}

// Manual "Email sheet" button. `brands` (optional) scopes the report to the
// selected brands; omitted/empty means every mismatch.
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

// Auto-report fired when a pipeline run terminates. Sends ONLY when there is
// something to report — pending mismatches and/or price alerts. Returns a status
// object; never throws (the caller is a background pipeline).
export async function sendPipelineReport({ to, threshold = 5 } = {}) {
  const { user, pass, from } = config.smtp;
  to = recipient(to);
  if (!user || !pass) return { ok: false, error: "email not configured (SMTP_USER/SMTP_PASS)" };
  if (!to) return { ok: false, error: "no recipient (ALERT_TO)" };
  const [rows, alerts] = await Promise.all([mismatchRows(null), alertRows(threshold)]);
  if (!rows.length && !alerts.length) return { ok: true, skipped: true, count: 0, alerts: 0 };
  const wb = buildWorkbook(rows, alerts);
  const today = new Date().toISOString().slice(0, 10);
  const brandCount = new Set(rows.map((r) => (r.brand || "").replace(/^www\./, ""))).size;
  const parts = [];
  if (rows.length) parts.push(`${rows.length} price mismatch(es) across ${brandCount} brand(s)`);
  if (alerts.length) parts.push(`${alerts.length} price alert(s) (>=${threshold}% move)`);
  await transport().sendMail({
    from, to, subject: `MBO Tracker — pipeline finished: ${parts.join(", ")} (${today})`,
    text: `A pricing pipeline run just finished.\n\n` +
      parts.map((p) => `• ${p}`).join("\n") + `\n\n` +
      `The attached workbook has one sheet per brand for every mismatch (plus a Summary tab` +
      (alerts.length ? ` and a Price Alerts tab` : ``) + `). Mismatches are PENDING APPROVAL ` +
      `— nothing has been pushed to any store.\n\n— MBO Tracker`,
    attachments: [{ filename: `pipeline_report_${today}.xlsx`, content: Buffer.from(await wb.xlsx.writeBuffer()) }],
  });
  return { ok: true, count: rows.length, alerts: alerts.length, brands: brandCount, to };
}
