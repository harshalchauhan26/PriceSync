// Read-only: pulls each product's CURRENT live price straight from the
// Studio East Shopify backend (studioe6.myshopify.com) and reports it next
// to what Supabase has on file. Never writes to Supabase, never pushes to
// Shopify.
//
//   node web/server/tools/studio-east-price-report.mjs
//
// Writes StudioEastPrices_<date>.xlsx to the repo root.
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { q, pool, ping } from "../src/db.js";
import { fetchLiveVariants } from "../src/shopify.js";

const MBO_ID = 1;
const CONCURRENCY = 5; // gql() already backs off on Shopify's THROTTLED cost errors; this just caps in-flight requests.

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

const rows = await q(
  `SELECT key, brand, url, mbo_url, base_price, base_currency, base_usd
     FROM products WHERE mbo_id=$1 AND mbo_url IS NOT NULL AND mbo_url <> '' ORDER BY brand, key`,
  [MBO_ID]);
console.log(`fetching Studio East live price for ${rows.length} products (concurrency ${CONCURRENCY})...`);

const limit = pLimit(CONCURRENCY);
let done = 0, ok = 0, failed = 0;
const results = await Promise.all(rows.map((r) => limit(async () => {
  const res = await fetchLiveVariants(MBO_ID, r.mbo_url);
  done++;
  if (done % 500 === 0) console.log(`  ${done}/${rows.length}...`);
  if (res.ok) ok++; else failed++;
  return {
    brand: r.brand, url: r.url, mbo_url: r.mbo_url,
    base_price: r.base_price, base_currency: r.base_currency, base_usd: r.base_usd,
    studio_east_price: res.ok ? Math.min(...res.prices) : null,
    studio_east_price_max: res.ok && res.prices.length > 1 ? Math.max(...res.prices) : null,
    variant_count: res.ok ? res.prices.length : null,
    error: res.ok ? "" : res.error,
  };
})));

console.log(`\ndone. ok ${ok} | failed ${failed}`);

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("studio_east_prices");
const cols = ["brand", "url", "mbo_url", "base_price", "base_currency", "base_usd",
  "studio_east_price", "studio_east_price_max", "variant_count", "error"];
ws.addRow(cols);
ws.getRow(1).font = { bold: true };
for (const r of results) ws.addRow(cols.map((c) => r[c]));
ws.columns.forEach((c) => { c.width = 26; });

const out = path.resolve(fileURLToPath(new URL(".", import.meta.url)), `../../../StudioEastPrices_${new Date().toISOString().slice(0, 10)}.xlsx`);
await wb.xlsx.writeFile(out);
console.log(`wrote ${out}`);
await pool.end();
