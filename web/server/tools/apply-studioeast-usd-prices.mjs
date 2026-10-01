// Apply Studio East's own Shopify products_export CSV(s) as the new USD base
// price for every matched product, across all brands. Only touches products
// already in the DB whose Studio East handle matches a row in a sheet.
//
//   node web/server/tools/apply-studioeast-usd-prices.mjs a.csv [b.csv ...]              # dry run
//   node web/server/tools/apply-studioeast-usd-prices.mjs a.csv [b.csv ...] --apply       # writes
//
// Expects Shopify's standard export columns: Handle, Vendor, Variant Price.
//
// MATCH KEY: the CSV's Handle is the tail of products.mbo_url
// (studioeast6.com/products/<handle>) -- this export is FROM Studio East's
// own store, not a designer's site, unlike apply-mahima-usd-prices.mjs which
// matched on products.url.
//
// DUPLICATE ROWS: the same Studio East listing sometimes exists as two
// separate product rows (re-imported at different times under a different
// internal key) -- identical mbo_url AND identical designer url. Matching on
// mbo_url alone can't tell those apart, and blindly updating every row that
// shares a handle papers over a real data-quality problem instead of
// surfacing it. So identity here is the (mbo_url, designer url) PAIR: a hit
// is only auto-updated when that exact pair is unique across the whole
// products table. A pair that occurs more than once is a true duplicate --
// skipped and reported, not guessed at.
//
// CURRENCY: sheet prices are USD (Studio East sells in USD). Every matched
// row is switched to native-USD tracking: base_price/base_usd both set to
// the sheet price, base_currency='USD'. Any touched brand still classified
// usd_convert (FX-derived base_usd) is moved to native_currency_brands=USD
// so future pipeline runs stop re-deriving base_usd via FX for it -- same
// fix as Decision 007 for mahimamahajan.in, generalized to every brand this
// sheet actually touches.
import * as XLSX from "xlsx";
import fs from "node:fs";
import { q, pool, ping, withTenant } from "../src/db.js";
import { usdConvertBrandSet, setUsdConvertBrands, nativeCurrencyBrands, setNativeCurrencyBrands, normBrand } from "../src/store.js";

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const FILES = ARGS.filter((a) => a !== "--apply");
const MBO_ID = 1;

if (!FILES.length || FILES.some((f) => !fs.existsSync(f))) {
  console.error("usage: node tools/apply-studioeast-usd-prices.mjs <export1.csv> [export2.csv ...] [--apply]");
  process.exit(1);
}

const handleOf = (url) => String(url || "").trim().replace(/\/+$/, "").split("/").pop();
const money = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
const norm = (u) => String(u || "").trim().toLowerCase().replace(/\/+$/, "");
const pairKeyOf = (r) => `${norm(r.mbo_url)}||${norm(r.url)}`;

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

// One price per Handle across ALL files; flag (and skip) any handle whose
// variant rows disagree, including disagreement between the two files.
const byHandle = new Map();
const inconsistent = new Set();
let totalRows = 0;
for (const file of FILES) {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  totalRows += rows.length;
  for (const r of rows) {
    const h = String(r["Handle"] || "").trim();
    const price = money(r["Variant Price"]);
    if (!h || price == null) continue;
    if (!byHandle.has(h)) byHandle.set(h, price);
    else if (byHandle.get(h) !== price) inconsistent.add(h);
  }
}
for (const h of inconsistent) byHandle.delete(h);

const prods = await q("SELECT id,key,brand,url,mbo_url,base_price,base_currency,base_usd FROM products WHERE mbo_id=$1", [MBO_ID]);
const byMboHandle = new Map();
const pairCounts = new Map();
for (const r of prods) {
  const h = handleOf(r.mbo_url);
  if (!byMboHandle.has(h)) byMboHandle.set(h, []);
  byMboHandle.get(h).push(r);
  const pk = pairKeyOf(r);
  pairCounts.set(pk, (pairCounts.get(pk) || 0) + 1);
}

const changes = [], unmatched = [], ambiguous = [];
const byBrand = new Map();
let unchanged = 0;
for (const [h, price] of byHandle) {
  const hits = byMboHandle.get(h);
  if (!hits) { unmatched.push(h); continue; }
  for (const hit of hits) {
    if (pairCounts.get(pairKeyOf(hit)) > 1) {
      ambiguous.push({ brand: hit.brand, url: hit.url, mbo_url: hit.mbo_url, key: hit.key });
      continue;
    }
    if (Number(hit.base_price) === price && String(hit.base_currency).toUpperCase() === "USD") { unchanged++; continue; }
    changes.push({ id: hit.id, key: hit.key, brand: hit.brand, url: hit.url, mbo_url: hit.mbo_url,
      oldPrice: hit.base_price, oldCurrency: hit.base_currency, newPrice: price });
    const bs = byBrand.get(hit.brand) || { count: 0 };
    bs.count++;
    byBrand.set(hit.brand, bs);
  }
}

console.log(`\nfiles: ${FILES.join(", ")} (${totalRows} total CSV rows)`);
console.log(`sheet handles ${byHandle.size} (${inconsistent.size} dropped: inconsistent variant prices)`);
console.log(`DB products (all brands): ${prods.length}`);
console.log(`already USD @ this price: ${unchanged} | to update: ${changes.length} | sheet handles with no DB match: ${unmatched.length}`);
console.log(`ambiguous (mbo_url+url pair not unique) -- skipped: ${ambiguous.length}`);
console.log(`\nbrands touched: ${byBrand.size}`);
for (const [b, s] of [...byBrand.entries()].sort((a, b) => b[1].count - a[1].count)) console.log(`  ${b}: ${s.count}`);

if (!APPLY) {
  console.log("\nsample changes:");
  for (const c of changes.slice(0, 10)) console.log(`  [${c.brand}] ${c.mbo_url} : ${c.oldCurrency} ${c.oldPrice} -> USD ${c.newPrice}`);
  if (ambiguous.length) {
    console.log("\nsample ambiguous (needs manual dedup, not touched):");
    for (const a of ambiguous.slice(0, 10)) console.log(`  [${a.brand}] ${a.mbo_url}  <-  ${a.url}  (key ${a.key})`);
  }
  console.log("\nDRY RUN — pass --apply to write.\n");
  await pool.end();
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const BAK = `products_bak_${stamp}_studioeastusd`;
await q(`CREATE TABLE IF NOT EXISTS ${BAK} AS SELECT * FROM products`);
const bak = await q(`SELECT count(*)::int n FROM ${BAK}`);
console.log(`\nbackup: ${BAK} (${bak[0].n} rows)`);

// Batched UNNEST updates, not one round-trip per row -- 8,821 sequential
// single-row UPDATEs held one connection open long enough for Supabase to
// drop it mid-transaction (see refreshUsdBaselines' identical fix in store.js).
const CH = 300;
const result = await withTenant(MBO_ID, async (db) => {
  await db.client.query("SELECT set_config('app.base_source','studioeast_usd_sheet',true)");
  await db.client.query("SET LOCAL statement_timeout = '120000'");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  let updated = 0;
  for (let i = 0; i < changes.length; i += CH) {
    const chunk = changes.slice(i, i + CH);
    const r = await db.client.query(
      `UPDATE products p SET base_price=v.price, base_currency='USD', base_usd=v.price, updated_at=$2
         FROM UNNEST($3::bigint[], $4::float8[]) AS v(id, price)
        WHERE p.mbo_id=$1 AND p.id=v.id`,
      [MBO_ID, now, chunk.map((c) => c.id), chunk.map((c) => c.newPrice)]);
    updated += r.rowCount;
    console.log(`  updated ${updated}/${changes.length}`);
  }
  return { updated };
});

// Reclassify every touched brand still on FX-derived base_usd (usd_convert)
// to native-USD, so the next pipeline run doesn't overwrite what we just set.
const native = await nativeCurrencyBrands(MBO_ID);
const convertSet = await usdConvertBrandSet(MBO_ID);
let reclassified = 0;
for (const brand of byBrand.keys()) {
  const nb = normBrand(brand);
  if (convertSet.has(nb) || native[nb] !== "USD") {
    native[nb] = "USD";
    convertSet.delete(nb);
    reclassified++;
  }
}
await setNativeCurrencyBrands(MBO_ID, native);
await setUsdConvertBrands(MBO_ID, [...convertSet]);

console.log(`\nAPPLIED — base prices updated ${result.updated}`);
console.log(`brands reclassified to native USD: ${reclassified}`);
console.log(`rollback if needed: the pre-change snapshot is ${BAK}\n`);
await pool.end();
