// One combined sheet across EVERY brand: designer URL + USD price, for the
// whole ~9k+ product catalog. Same fetch/currency logic as
// brand-live-prices.mjs / brand-live-prices-batch.mjs (reuses
// fetchBrandLivePrices() — one implementation of "how a product's live price
// and USD conversion get computed") — this tool only merges every brand's
// rows into a single worksheet instead of one file per brand.
//
//   node web/server/tools/all-products-usd-sheet.mjs
//   node web/server/tools/all-products-usd-sheet.mjs --brands amitaggarwal.com,manijassal.com --limit 5   # smoke test
//
// Writes NOTHING to the database.
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { fetchBrandLivePrices } from "./brand-live-prices.mjs";

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const MBO_ID = Number(argOf("--mbo") || 1);
const ONLY = (argOf("--brands") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LIMIT = Number(argOf("--limit") || 0); // per-brand row cap, for a fast smoke test
const BRAND_CONCURRENCY = Number(argOf("--brand-concurrency") || 4);

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const brandRows = await q(
    `SELECT DISTINCT brand FROM products WHERE mbo_id=$1 AND brand IS NOT NULL AND brand <> '' ORDER BY brand`,
    [MBO_ID]);
  const brands = brandRows.map((r) => r.brand)
    .filter((b) => !ONLY.length || ONLY.includes(store.normBrand(b)));
  if (!brands.length) { console.error("no matching brands"); await pool.end(); process.exit(1); }

  console.log(`\n${brands.length} brands, writing one combined sheet\n`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("All Products USD");
  const C = ["brand", "designer_url", "mbo_url", "price", "currency", "usd_price", "base_price", "state", "error"];
  ws.addRow(C); ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.length } };
  ws.columns.forEach((c, i) => { c.width = [22, 58, 58, 12, 10, 12, 12, 12, 26][i] || 16; });

  let done = 0, totalRows = 0, totalOk = 0, totalFailed = 0;
  await mapLimit(brands, BRAND_CONCURRENCY, async (brand) => {
    try {
      const r = await fetchBrandLivePrices(MBO_ID, brand, { limit: LIMIT });
      done++;
      if (!r.out.length) { console.log(`  [${done}/${brands.length}] ${brand} — SKIPPED (no fetchable rows)`); return; }
      r.out.forEach((o) => ws.addRow([
        brand, o.url, o.mbo_url || "", o.price ?? "", o.currency || "", o.usd_price ?? "",
        o.base_price ?? "", o.state || "", o.err || "",
      ]));
      totalRows += r.out.length; totalOk += r.ok; totalFailed += r.failed;
      console.log(`  [${done}/${brands.length}] ${brand} — ${r.out.length} rows, ok=${r.ok} failed=${r.failed}`);
    } catch (e) {
      done++;
      console.log(`  [${done}/${brands.length}] ${brand} — ERROR: ${e.message}`);
    }
  });

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const file = `AllProducts_USD_${stamp}.xlsx`;
  const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  await wb.xlsx.writeFile(path.join(outDir, file));
  console.log(`\n${totalRows} rows written (ok=${totalOk} failed=${totalFailed}) across ${brands.length} brands.`);
  console.log(`Wrote ${file}. No database was touched.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
