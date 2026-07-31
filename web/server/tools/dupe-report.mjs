// Read-only duplicate report.
//   node web/server/tools/dupe-report.mjs [--mbo 1]
//
// Groups products by designer URL (canonical: fetch-time params stripped,
// trailing slash and case normalised) and splits the duplicates in two, per
// the rule that matters operationally:
//
//   IDENTICAL  — every copy agrees on designer URL, MBO URL and base price.
//                Nothing is lost by keeping one; the rest are pure waste
//                (re-fetched every run, shown several times in Review).
//
//   CONFLICTING — copies share the designer URL but disagree on MBO URL or
//                base price. These are NOT safe to collapse automatically:
//                the disagreement is information, and picking a winner by
//                machine would silently discard somebody's edit.
//
// Writes DuplicateReport_<date>.xlsx and changes NOTHING in the database.
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import { productIdentity } from "../src/store.js";

const MBO_ID = Number(process.argv.includes("--mbo") ? process.argv[process.argv.indexOf("--mbo") + 1] : 1);
const norm = (v) => String(v ?? "").trim();
const money = (v) => (v == null ? "" : String(Number(v)));

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const rows = await q(
    `SELECT id, key, brand, url, mbo_url, base_price, base_usd, live_price, state, status, updated_at
     FROM products WHERE mbo_id=$1 ORDER BY id`, [MBO_ID]);

  const groups = new Map();
  for (const r of rows) {
    const id = productIdentity(r.url);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }

  const identical = [], conflicting = [];
  for (const [id, g] of groups) {
    if (g.length < 2) continue;
    const sameMbo = new Set(g.map((r) => norm(r.mbo_url))).size === 1;
    const samePrice = new Set(g.map((r) => money(r.base_price))).size === 1;
    // The oldest row is the keeper: it owns the price_history written under
    // its key, so discarding it would orphan that trail.
    const keep = g[0];
    const entry = {
      identity: id, brand: keep.brand, url: keep.url, copies: g.length,
      keep_key: keep.key, drop_keys: g.slice(1).map((r) => r.key).join(" | "),
      mbo_urls: [...new Set(g.map((r) => norm(r.mbo_url)))].join(" | ") || "(none)",
      base_prices: [...new Set(g.map((r) => money(r.base_price)))].join(" | "),
      states: [...new Set(g.map((r) => r.state))].join(" | "),
      differs_on: [!sameMbo && "MBO URL", !samePrice && "base price"].filter(Boolean).join(" + "),
    };
    (sameMbo && samePrice ? identical : conflicting).push(entry);
  }

  const wasted = identical.reduce((a, e) => a + e.copies - 1, 0);
  const conflictRows = conflicting.reduce((a, e) => a + e.copies - 1, 0);

  console.log(`\n=== Duplicate report — MBO ${MBO_ID} ===`);
  console.log(`Products                    : ${rows.length}`);
  console.log(`Distinct designer URLs      : ${groups.size}`);
  console.log(`\nIDENTICAL duplicate groups  : ${identical.length}  (${wasted} redundant rows — safe to collapse)`);
  console.log(`CONFLICTING groups          : ${conflicting.length}  (${conflictRows} extra rows — need a human)`);

  const byBrand = new Map();
  for (const e of identical) byBrand.set(e.brand, (byBrand.get(e.brand) || 0) + e.copies - 1);
  const top = [...byBrand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log(`\nRedundant rows by brand (top ${top.length}):`);
    for (const [b, n] of top) console.log(`  ${String(n).padStart(5)}  ${b}`);
  }
  if (conflicting.length) {
    console.log(`\nConflicting groups (first 10) — these are NOT safe to auto-collapse:`);
    for (const e of conflicting.slice(0, 10)) {
      console.log(`  x${e.copies} differs on ${e.differs_on.padEnd(22)} base=[${e.base_prices}]  ${e.url.slice(0, 58)}`);
    }
  }

  const wb = new ExcelJS.Workbook();
  const COLS = ["brand", "url", "copies", "differs_on", "base_prices", "mbo_urls", "states", "keep_key", "drop_keys"];
  const add = (name, data) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(COLS);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    data.forEach((d) => ws.addRow(COLS.map((c) => d[c])));
    ws.columns.forEach((c, i) => { c.width = [22, 62, 8, 20, 22, 40, 20, 34, 60][i] ?? 20; });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } };
  };
  add("identical_safe_to_drop", identical);
  add("conflicting_check_these", conflicting);

  const out = path.resolve(fileURLToPath(new URL(".", import.meta.url)),
    `../../../DuplicateReport_${new Date().toISOString().slice(0, 10)}.xlsx`);
  await wb.xlsx.writeFile(out);
  console.log(`\nWrote ${out}\nNothing was modified.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
