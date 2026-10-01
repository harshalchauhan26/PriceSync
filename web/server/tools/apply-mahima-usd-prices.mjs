// Apply Mahima Mahajan's Shopify products_export CSV as the new USD base
// price for mahimamahajan.in. Only touches products already in the DB whose
// designer URL handle matches a row in the sheet — nothing else moves.
//
//   node web/server/tools/apply-mahima-usd-prices.mjs "products_export_1.csv"           # dry run
//   node web/server/tools/apply-mahima-usd-prices.mjs "products_export_1.csv" --apply    # writes
//
// Expects Shopify's standard export columns: Handle, Variant Price.
//
// MATCH KEY: the CSV's Handle is the tail of the designer product URL
// (products.url, e.g. mahimamahajan.in/products/<handle>) -- NOT products.mbo_url
// (that's the MBO's own listing, which uses a different handle per product).
//
// CURRENCY: mahimamahajan.in is currently tracked as usd_convert (base_price
// in INR, base_usd derived via live FX every pipeline run). This sheet gives
// real USD prices, so matched rows are switched to native-USD tracking:
// base_price/base_usd both set to the sheet price, base_currency='USD', and
// the brand is moved from usd_convert_brands into native_currency_brands so
// future pipeline runs stop re-deriving base_usd via FX for it.
import * as XLSX from "xlsx";
import fs from "node:fs";
import { q, pool, ping, withTenant } from "../src/db.js";
import { usdConvertBrandSet, setUsdConvertBrands, nativeCurrencyBrands, setNativeCurrencyBrands } from "../src/store.js";

const FILE = process.argv[2];
const APPLY = process.argv.includes("--apply");
const MBO_ID = 1;
const BRAND = "mahimamahajan.in";

if (!FILE || !fs.existsSync(FILE)) {
  console.error("usage: node tools/apply-mahima-usd-prices.mjs <products_export.csv> [--apply]");
  process.exit(1);
}

const handleOf = (url) => String(url || "").trim().replace(/\/+$/, "").split("/").pop();
const money = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

const wb = XLSX.read(fs.readFileSync(FILE), { type: "buffer" });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

// One price per Handle; flag (and skip) any handle whose variant rows disagree.
const byHandle = new Map();
const inconsistent = new Set();
for (const r of rows) {
  const h = String(r["Handle"] || "").trim();
  const price = money(r["Variant Price"]);
  if (!h || price == null) continue;
  if (!byHandle.has(h)) byHandle.set(h, price);
  else if (byHandle.get(h) !== price) inconsistent.add(h);
}
for (const h of inconsistent) byHandle.delete(h);

const prods = await q(
  "SELECT id,key,url,base_price,base_currency,base_usd FROM products WHERE mbo_id=$1 AND brand=$2",
  [MBO_ID, BRAND]);
const byUrlHandle = new Map();
for (const r of prods) {
  const h = handleOf(r.url);
  if (!byUrlHandle.has(h)) byUrlHandle.set(h, []);
  byUrlHandle.get(h).push(r);
}

const changes = [], unmatched = [];
let unchanged = 0;
for (const [h, price] of byHandle) {
  const hits = byUrlHandle.get(h);
  if (!hits) { unmatched.push(h); continue; }
  for (const hit of hits) {
    if (Number(hit.base_price) === price && String(hit.base_currency).toUpperCase() === "USD") { unchanged++; continue; }
    changes.push({ id: hit.id, key: hit.key, url: hit.url, oldPrice: hit.base_price, oldCurrency: hit.base_currency, newPrice: price });
  }
}

console.log(`\nsheet handles ${byHandle.size} (${inconsistent.size} dropped: inconsistent variant prices)`);
console.log(`DB products for ${BRAND}: ${prods.length}`);
console.log(`already USD @ this price: ${unchanged} | to update: ${changes.length} | sheet handles with no DB match: ${unmatched.length}`);

if (!APPLY) {
  console.log("\nsample changes:");
  for (const c of changes.slice(0, 10)) console.log(`  ${c.url} : ${c.oldCurrency} ${c.oldPrice} -> USD ${c.newPrice}`);
  console.log("\nDRY RUN — pass --apply to write.\n");
  await pool.end();
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const BAK = `products_bak_${stamp}_mahimausd`;
await q(`CREATE TABLE IF NOT EXISTS ${BAK} AS SELECT * FROM products`);
const bak = await q(`SELECT count(*)::int n FROM ${BAK}`);
console.log(`\nbackup: ${BAK} (${bak[0].n} rows)`);

const result = await withTenant(MBO_ID, async (db) => {
  await db.client.query("SELECT set_config('app.base_source','mahima_usd_sheet',true)");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let updated = 0;
  for (const c of changes) {
    const r = await db.client.query(
      "UPDATE products SET base_price=$1, base_currency='USD', base_usd=$1, updated_at=$2 WHERE mbo_id=$3 AND id=$4",
      [c.newPrice, now, MBO_ID, c.id]);
    updated += r.rowCount;
  }
  return { updated };
});

const native = await nativeCurrencyBrands(MBO_ID);
native[BRAND] = "USD";
await setNativeCurrencyBrands(MBO_ID, native);
const convert = [...(await usdConvertBrandSet(MBO_ID))].filter((b) => b !== BRAND);
await setUsdConvertBrands(MBO_ID, convert);

console.log(`\nAPPLIED — base prices updated ${result.updated}`);
console.log(`${BRAND} reclassified: native_currency_brands=USD, removed from usd_convert_brands`);
console.log(`rollback if needed: the pre-change snapshot is ${BAK}\n`);
await pool.end();
