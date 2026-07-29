import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { q } from "./db.js";
import { config } from "./config.js";

const COLS = ["brand", "url", "base_price", "live_price", "currency", "status", "state",
  "delta", "decision", "final_price"];

async function stateRows(mboId, states, brands) {
  const p = [mboId, ...states];
  let where = `mbo_id=$1 AND state IN (${states.map((_, i) => `$${i + 2}`).join(",")})`;
  if (brands && brands.length) {
    where += ` AND brand IN (${brands.map((_, i) => `$${i + 2 + states.length}`).join(",")})`;
    p.push(...brands);
  }
  return q(`SELECT brand,url,base_price,live_price,currency,status,state,delta,
    decision,final_price FROM products WHERE ${where}
    ORDER BY state, brand, ABS(COALESCE(delta,0)) DESC`, p);
}
const mismatchRows = (mboId, brands) => stateRows(mboId, ["mismatch"], brands);

async function alertRows(mboId, threshold = 5) {
  try {
    return await q(`SELECT brand,url,prev,live_price,
        ROUND(((live_price-prev)/prev*100)::numeric,2) AS pct
      FROM ( SELECT brand,url,live_price,
          LAG(live_price) OVER (PARTITION BY key ORDER BY created_at) AS prev,
          ROW_NUMBER() OVER (PARTITION BY key ORDER BY created_at DESC) AS rn
        FROM price_history WHERE mbo_id=$1 AND live_price IS NOT NULL) t
      WHERE rn=1 AND prev IS NOT NULL AND prev<>0
        AND ABS((live_price-prev)/prev*100) >= $2
      ORDER BY brand, ABS((live_price-prev)/prev*100) DESC LIMIT 1000`, [mboId, Math.abs(threshold)]);
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
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass },
    // Fail fast instead of hanging ~2 minutes per send. On a blocked-SMTP host
    // every attempt times out, and the pipeline fires 3-4 mails per run — with
    // nodemailer's defaults that stalled the run log for minutes with no clue why.
    connectionTimeout: 15_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
}

// Which transport is in play. Named so /api/health can report it: "why did no
// mail arrive" is otherwise invisible from outside the box.
export function mailProvider() {
  const m = config.mail;
  if (m.resendKey) return "resend";
  if (m.brevoKey) return "brevo";
  if (m.sendgridKey) return "sendgrid";
  const { user, pass } = config.smtp;
  return user && pass ? "smtp" : "none";
}

// "Name <a@b.com>" / "a@b.com" -> { email, name }. Providers want the address
// structured; nodemailer accepted either, so existing callers pass whatever
// SMTP_FROM holds.
function parseFrom(from) {
  const s = String(from || "").trim();
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim(), name: m[1].replace(/^"|"$/g, "").trim() || undefined };
  return { email: s, name: undefined };
}
const toList = (to) => String(to || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const b64 = (c) => Buffer.isBuffer(c) ? c.toString("base64") : Buffer.from(String(c)).toString("base64");
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// POST helper with an explicit timeout — a hung provider must not wedge a run.
async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }
  return res;
}

// Single send path for every mail in this module. Takes the nodemailer message
// shape the callers already build ({ from, to, subject, text, attachments }) and
// routes it over the configured provider's HTTPS API, falling back to SMTP.
// Keeping ONE function means a provider swap never has to touch a call site.
async function deliver(msg) {
  const provider = mailProvider();
  const from = parseFrom(msg.from);
  const rcpt = toList(msg.to);
  const atts = msg.attachments || [];
  if (!rcpt.length) throw new Error("no recipient");

  if (provider === "resend") {
    await postJson("https://api.resend.com/emails",
      { authorization: `Bearer ${config.mail.resendKey}` },
      { from: from.name ? `${from.name} <${from.email}>` : from.email, to: rcpt,
        subject: msg.subject, text: msg.text,
        ...(atts.length ? { attachments: atts.map((a) => ({ filename: a.filename, content: b64(a.content) })) } : {}) });
    return;
  }
  if (provider === "brevo") {
    await postJson("https://api.brevo.com/v3/smtp/email",
      { "api-key": config.mail.brevoKey, accept: "application/json" },
      { sender: { email: from.email, ...(from.name ? { name: from.name } : {}) },
        to: rcpt.map((email) => ({ email })), subject: msg.subject, textContent: msg.text,
        ...(atts.length ? { attachment: atts.map((a) => ({ name: a.filename, content: b64(a.content) })) } : {}) });
    return;
  }
  if (provider === "sendgrid") {
    await postJson("https://api.sendgrid.com/v3/mail/send",
      { authorization: `Bearer ${config.mail.sendgridKey}` },
      { personalizations: [{ to: rcpt.map((email) => ({ email })) }],
        from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
        subject: msg.subject, content: [{ type: "text/plain", value: msg.text }],
        ...(atts.length ? { attachments: atts.map((a) => ({ filename: a.filename,
          content: b64(a.content), type: XLSX_MIME, disposition: "attachment" })) } : {}) });
    return;
  }
  // SMTP. Works locally and on paid Render; blocked on Render's free plan.
  await transport().sendMail(msg);
}

// Domains that can never actually receive mail. This guard exists because
// Gmail's SMTP answers "250 OK" for a .local recipient and then blackholes
// the message — so an undeliverable address looks like a SUCCESSFUL send in
// the run log and is never received. Two real accounts sit on such domains
// (admin@pricesync.local, admin@datapricesync.local), so without this a run
// started by either would silently report "sent" forever.
const UNROUTABLE_DOMAIN = /\.(local|localhost|localdomain|internal|intranet|invalid|test|example|home|lan)$/i;
const ADDR_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

// Normalises one address; returns null when it could never be delivered.
function deliverable(addr) {
  const a = String(addr || "").trim().toLowerCase();
  if (!a || !ADDR_RE.test(a)) return null;
  if (UNROUTABLE_DOMAIN.test(a.split("@")[1] || "")) return null;
  return a;
}

// Every pipeline/report mail goes to the UNION of:
//   • the user who started the run (so the operator gets their own report), and
//   • ALERT_TO (so the account owner sees every run regardless of who ran it).
// Both matter: addressing the initiator ALONE is what hid a week of pipeline
// mail — the admin who clicks "Run" each morning received all of it while the
// owner watching ALERT_TO received none and assumed email was broken.
// Deduped, order-stable (initiator first), undeliverable addresses dropped.
function recipients(to) {
  const seen = new Set(), keep = [], dropped = [];
  const consider = [
    ...String(to || "").split(/[,;]/),
    ...String(config.smtp.to || "").split(/[,;]/),
  ];
  for (const raw of consider) {
    if (!String(raw || "").trim()) continue;
    const ok = deliverable(raw);
    if (!ok) { dropped.push(String(raw).trim()); continue; }
    if (seen.has(ok)) continue;
    seen.add(ok); keep.push(ok);
  }
  return { to: keep.join(", "), list: keep, dropped };
}

// Shared guard for every mail entry point: returns { ok:false, error } when
// email can't be sent (no transport / no sender / no deliverable recipient) so
// callers can log and move on without throwing inside the pipeline.
function mailGuard(to) {
  const r = recipients(to);
  // Any configured transport counts — an HTTPS provider needs no SMTP_USER/PASS.
  if (mailProvider() === "none") {
    return { ok: false, error: "email not configured (set RESEND_API_KEY / BREVO_API_KEY / SENDGRID_API_KEY, or SMTP_USER+SMTP_PASS)" };
  }
  // The HTTPS APIs reject a send with no From, and SMTP_FROM defaults off
  // SMTP_USER — which is absent when only an API key is set.
  if (!config.smtp.from) return { ok: false, error: "no sender address (set MAIL_FROM)" };
  if (!r.list.length) {
    return { ok: false, error: r.dropped.length
      ? `no deliverable recipient — dropped undeliverable ${r.dropped.join(", ")} (set ALERT_TO to a real address)`
      : "no recipient (ALERT_TO)" };
  }
  return { ok: true, to: r.to, list: r.list, dropped: r.dropped };
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

// One-shot deliverability check, wired to the "Send test email" button in
// Settings. Goes through the SAME recipients()/deliver() path as a real report
// and carries a small .xlsx, so a pass proves the whole chain — provider auth,
// sender verification, recipient resolution AND attachment handling — without
// waiting on a pipeline run. Returns the provider's own error text on failure
// (e.g. Brevo's 400 for an unverified MAIL_FROM) instead of a generic message.
export async function sendTestEmail({ to } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  const provider = mailProvider();
  const wb = new ExcelJS.Workbook();
  flatSheet(wb, "Test", [{ key: "check", header: "check" }, { key: "value", header: "value" }],
    [{ check: "provider", value: provider }, { check: "from", value: from },
      { check: "to", value: g.to }, { check: "sent_at", value: new Date().toISOString() }]);
  try {
    await deliver({
      from, to: g.to,
      subject: `MBO Tracker — test email (${provider}) ${today()}`,
      text: `This is a test from MBO Tracker.\n\n` +
        `• Transport: ${provider}\n• From: ${from}\n• To: ${g.to}\n` +
        (g.dropped.length ? `• Dropped as undeliverable: ${g.dropped.join(", ")}\n` : "") +
        `\nIf this arrived WITH the attached sheet, pipeline reports will arrive too.\n\n— MBO Tracker`,
      attachments: [{ filename: `test_${today()}.xlsx`, content: Buffer.from(await wb.xlsx.writeBuffer()) }],
    });
  } catch (e) {
    return { ok: false, error: e.message, provider, to: g.to, dropped: g.dropped };
  }
  return { ok: true, provider, to: g.to, dropped: g.dropped };
}

// Sent the moment a run kicks off.
export async function sendPipelineStarted({ to, total, runId } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  await deliver({
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
  await deliver({
    from, to: g.to,
    subject: `MBO Tracker — pipeline ${pct}% done (${done}/${total}) (${today()})`,
    text: `The pricing pipeline run is about halfway.\n\n` +
      `• Checked so far: ${done} of ${total} (${pct}%)\n\n— MBO Tracker`,
  });
  return { ok: true, to: g.to };
}

// Sent after the safe-retry pass — how many fetch errors recovered vs remain.
export async function sendErrorsResolved({ mboId, to, stats } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  const total = stats?.retry_total ?? 0;
  const recovered = stats?.retry_recovered ?? 0;
  const remaining = Math.max(0, total - recovered);
  const rows = await stateRows(mboId, ["error"]);
  const wb = new ExcelJS.Workbook();
  flatSheet(wb, "Remaining Errors", [
    { key: "brand", header: "brand" }, { key: "url", header: "url" },
    { key: "base_price", header: "base_price" }, { key: "status", header: "status" },
  ], rows);
  const attach = rows.length
    ? [{ filename: `remaining_errors_${today()}.xlsx`, content: Buffer.from(await wb.xlsx.writeBuffer()) }]
    : [];
  await deliver({
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
export async function sendPipelineComplete({ mboId, to, stats, runId } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;

  // Scoped to THIS RUN, not the whole catalogue. products.run_id is stamped by
  // saveResult for every row the run touched, so filtering on it yields exactly
  // the products that ran — nothing more, nothing less. A 95-product run used to
  // attach a sheet of all 8,900+ rows in the tenant, which made the attachment
  // useless for seeing what the run actually did.
  // runId is absent only for engines built outside the API (local refresh
  // scripts); those keep the old whole-tenant snapshot.
  const scoped = !!runId;
  const params = scoped ? [mboId, runId] : [mboId];
  const updated = await q(
    `SELECT rh.brand, rh.url, rh.base_price, rh.final_price, rh.currency, rh.status,
            rh.shopify_status, rh.approved_at
       FROM review_history rh
      WHERE rh.mbo_id=$1 AND (rh.shopify_status LIKE 'updated%' OR rh.shopify_status LIKE 'DRY RUN%')
        AND rh.approved_at >= now() - interval '24 hours'` +
    (scoped ? ` AND EXISTS (SELECT 1 FROM products p
        WHERE p.mbo_id=rh.mbo_id AND p.key=rh.key AND p.run_id=$2)` : ``) +
    ` ORDER BY rh.approved_at DESC`, params).catch(() => []);
  const allRows = await q(
    `SELECT brand, url, base_price, live_price, currency, state, status, delta
       FROM products WHERE mbo_id=$1${scoped ? " AND run_id=$2" : ""}
      ORDER BY state, brand, ABS(COALESCE(delta,0)) DESC`, params).catch(() => []);

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
  parts.push(`${allRows.length} product(s) in this run — the attached sheets cover exactly these`);
  parts.push(`${updated.length} of them had a price pushed to Shopify in the last 24h`);

  await deliver({
    from, to: g.to,
    subject: `MBO Tracker — pipeline finished: ${allRows.length} product(s), ` +
      `${stats?.mismatch ?? 0} mismatch, ${stats?.errors ?? 0} error (${today()})`,
    text: `A pricing pipeline run just finished.\n\n` +
      parts.map((p) => `• ${p}`).join("\n") + `\n\n` +
      `Two sheets are attached, both covering ONLY the ${allRows.length} product(s) ` +
      `in this run:\n` +
      `  1. price_updates — those whose price was pushed to Shopify (last 24h).\n` +
      `  2. price_fetch_all — every product this run fetched; filter the "state" ` +
      `column into matched / mismatch / error.\n\n` +
      `Mismatches are PENDING APPROVAL — nothing is pushed automatically.\n\n— MBO Tracker`,
    attachments: [
      { filename: `price_updates_${today()}.xlsx`, content: Buffer.from(await wbUpdated.xlsx.writeBuffer()) },
      { filename: `price_fetch_all_${today()}.xlsx`, content: Buffer.from(await wbAll.xlsx.writeBuffer()) },
    ],
  });
  return { ok: true, to: g.to, updated: updated.length, all: allRows.length };
}

// Sent once per NEW account created via Google sign-in, always to the owner
// (not the configurable ALERT_TO) so account creation is never silently
// missed just because someone changes the alert recipient.
const OWNER_NOTIFY_TO = "harshal.growify@gmail.com";
export async function sendNewSignup({ email, brand } = {}) {
  const { from } = config.smtp;
  if (mailProvider() === "none") return { ok: false, error: "email not configured" };
  if (!from) return { ok: false, error: "no sender address (set MAIL_FROM)" };
  const to = deliverable(OWNER_NOTIFY_TO);
  if (!to) return { ok: false, error: `owner notify address undeliverable (${OWNER_NOTIFY_TO})` };
  // The brand matters now that a signup joins whichever brand the user picked
  // on the login page — without it there's no way to tell which Settings →
  // Users list the pending account is actually sitting in.
  const where = brand ? ` for ${brand}` : "";
  await deliver({
    from, to,
    subject: `MBO Tracker — new sign-up awaiting approval${where}: ${email}`,
    text: `${email} just signed in with Google and a "viewer" account was ` +
      `created for them${where} — but it is PENDING APPROVAL and currently ` +
      `has no access to any data.\n\nOpen Settings → Users${where} to approve ` +
      `them (and change their role if needed). Until you do, they'll only see ` +
      `an "Awaiting approval" screen.\n\n— MBO Tracker`,
  });
  return { ok: true, to };
}

export async function sendMismatchReport(mboId, to, brands) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  to = g.to;
  const rows = await mismatchRows(mboId, brands);
  const wb = buildWorkbook(rows, []);
  const today = new Date().toISOString().slice(0, 10);
  const scope = brands && brands.length ? ` for ${brands.length} brand(s)` : "";
  await deliver({
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
export async function sendPipelineReport({ mboId, to, threshold = 5, stats = null } = {}) {
  const g = mailGuard(to); if (!g.ok) return g;
  const { from } = config.smtp;
  to = g.to;
  const [rows, alerts] = await Promise.all([stateRows(mboId, ["mismatch", "error"]), alertRows(mboId, threshold)]);
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
  await deliver({
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
