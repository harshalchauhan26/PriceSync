// Email the mismatch report (port of the smtplib flow -> nodemailer).
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { q } from "./db.js";
import { config } from "./config.js";

async function mismatchXlsx() {
  const rows = await q(`SELECT brand,url,base_price,live_price,currency,status,state,delta,
    decision,final_price FROM products WHERE state='mismatch' ORDER BY ABS(COALESCE(delta,0)) DESC`);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("mismatches");
  const cols = ["brand", "url", "base_price", "live_price", "currency", "status", "state",
    "delta", "decision", "final_price"];
  ws.addRow(cols);
  ws.getRow(1).eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A40" } };
    c.font = { color: { argb: "FFFFFFFF" }, bold: true }; });
  rows.forEach((r) => {
    const row = ws.addRow(cols.map((c) => r[c]));
    const fill = r.state === "mismatch" ? "FFFFF2CC" : r.state === "error" ? "FFF8CBAD" : null;
    if (fill) row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } }; });
  });
  return { buf: await wb.xlsx.writeBuffer(), n: rows.length };
}

export async function sendMismatchReport(to) {
  const { host, port, user, pass, from } = config.smtp;
  to = (to || config.smtp.to || "").trim();
  if (!user || !pass) return { ok: false, error: "email not configured (SMTP_USER/SMTP_PASS)" };
  if (!to) return { ok: false, error: "no recipient (ALERT_TO)" };
  const { buf, n } = await mismatchXlsx();
  const today = new Date().toISOString().slice(0, 10);
  const t = nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });
  await t.sendMail({
    from, to, subject: `MBO Tracker — ${n} price mismatches (${today})`,
    text: `MBO Tracker detected ${n} price mismatch(es) awaiting review.\n\n` +
      `The attached sheet lists every mismatch (yellow rows). These are PENDING APPROVAL — ` +
      `nothing has been pushed to any store.\n\n— MBO Tracker`,
    attachments: [{ filename: `price_mismatches_${today}.xlsx`, content: Buffer.from(buf) }],
  });
  return { ok: true, count: n, to };
}
