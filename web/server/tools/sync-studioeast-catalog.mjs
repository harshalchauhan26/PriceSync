// Syncs the products table to exactly match Studio East's own Shopify
// products_export CSV(s): adds products present in the sheet but missing
// from the DB, and prunes products in the DB whose Studio East listing
// (mbo_url) is NOT in the sheet.
//
//   node web/server/tools/sync-studioeast-catalog.mjs a.csv [b.csv ...]            # dry run
//   node web/server/tools/sync-studioeast-catalog.mjs a.csv [b.csv ...] --apply    # writes
//
// ADDS: new rows get mbo_url + base_price/base_usd (USD) + brand (resolved
// from the sheet's Vendor via existing matched rows). No designer `url` is
// knowable from a Studio East export alone, so it's left blank -- these rows
// won't be live-fetched until a designer URL is supplied separately.
//
// PRUNES: a product whose mbo_url handle isn't anywhere in the sheet gets
// deleted, mirroring it out of import_catalog/buckets too. Full table
// snapshotted first.
import * as XLSX from "xlsx";
import fs from "node:fs";
import { q, pool, ping, withTenant } from "../src/db.js";

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const FILES = ARGS.filter((a) => a !== "--apply");
const MBO_ID = 1;

// Vendor-name spellings that don't match any brand on file otherwise.
const VENDOR_FIX = {
  "Amit Agarwal": "Amit Aggarwal",
  "Monica Nidhiee": "Monika Nidhee",
  "Mahima mahajan": "Mahima Mahajan",
};
// New vendor the sheet introduces that has no prior products at all.
const VENDOR_NEW_BRAND = { "Tarun Tahiliani": "taruntahiliani.com" };
// Not real designer names -- a miscategorized product / a test listing.
const VENDOR_SKIP = new Set(["Womenswear", "Testing"]);

if (!FILES.length || FILES.some((f) => !fs.existsSync(f))) {
  console.error("usage: node tools/sync-studioeast-catalog.mjs <export1.csv> [export2.csv ...] [--apply]");
  process.exit(1);
}

const handleOf = (url) => String(url || "").trim().replace(/\/+$/, "").split("/").pop();
const money = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

const byHandle = new Map(); // handle -> { vendor, price }
let totalRows = 0;
for (const file of FILES) {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  totalRows += rows.length;
  for (const r of rows) {
    const h = String(r["Handle"] || "").trim();
    const v = String(r["Vendor"] || "").trim();
    const price = money(r["Variant Price"]);
    if (!h) continue;
    if (!byHandle.has(h)) byHandle.set(h, { vendor: v, price });
  }
}
console.log(`files: ${FILES.join(", ")} (${totalRows} rows, ${byHandle.size} distinct handles)`);

const prods = await q(`SELECT id,key,brand,url,mbo_url FROM products WHERE mbo_id=$1`, [MBO_ID]);
const dbHandles = new Set();
for (const r of prods) { const h = handleOf(r.mbo_url); if (h) dbHandles.add(h); }

// Vendor -> brand, learned from rows that already exist in both places.
const vendorToBrand = new Map();
for (const r of prods) {
  const h = handleOf(r.mbo_url);
  const entry = byHandle.get(h);
  if (entry?.vendor && r.brand) {
    if (!vendorToBrand.has(entry.vendor)) vendorToBrand.set(entry.vendor, new Map());
    const m = vendorToBrand.get(entry.vendor);
    m.set(r.brand, (m.get(r.brand) || 0) + 1);
  }
}
const resolvedBrand = new Map();
for (const [vendor, counts] of vendorToBrand) resolvedBrand.set(vendor, [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]);

function brandFor(vendor) {
  if (resolvedBrand.has(vendor)) return resolvedBrand.get(vendor);
  if (VENDOR_FIX[vendor] && resolvedBrand.has(VENDOR_FIX[vendor])) return resolvedBrand.get(VENDOR_FIX[vendor]);
  if (VENDOR_NEW_BRAND[vendor]) return VENDOR_NEW_BRAND[vendor];
  return null;
}

const toAdd = [], skippedVendor = [];
for (const [h, entry] of byHandle) {
  if (dbHandles.has(h)) continue;
  if (VENDOR_SKIP.has(entry.vendor)) { skippedVendor.push({ handle: h, vendor: entry.vendor }); continue; }
  const brand = brandFor(entry.vendor);
  if (!brand) { skippedVendor.push({ handle: h, vendor: entry.vendor }); continue; }
  if (entry.price == null) continue;
  toAdd.push({ handle: h, brand, price: entry.price,
    mbo_url: `https://www.studioeast6.com/products/${h}` });
}

const toPrune = prods.filter((r) => { const h = handleOf(r.mbo_url); return !h || !byHandle.has(h); });

console.log(`\nto ADD (new products): ${toAdd.length}`);
console.log(`to PRUNE (not in any sheet): ${toPrune.length}`);
if (skippedVendor.length) {
  console.log(`skipped (unresolvable/non-brand vendor): ${skippedVendor.length}`);
  for (const s of skippedVendor.slice(0, 10)) console.log(`  [${s.vendor}] ${s.handle}`);
}

if (!APPLY) {
  console.log("\nsample adds:");
  for (const a of toAdd.slice(0, 5)) console.log(`  [${a.brand}] ${a.mbo_url} -> USD ${a.price}`);
  console.log("\nsample prunes:");
  for (const r of toPrune.slice(0, 5)) console.log(`  [${r.brand}] ${r.mbo_url || "(no mbo_url)"}  key=${r.key}`);
  console.log("\nDRY RUN — pass --apply to write.\n");
  await pool.end();
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const BAK = `products_bak_${stamp}_catalogsync`;
await q(`CREATE TABLE IF NOT EXISTS ${BAK} AS SELECT * FROM products`);
console.log(`\nbackup: ${BAK}`);

const added = await withTenant(MBO_ID, async (db) => {
  await db.client.query("SELECT set_config('app.base_source','studioeast_catalog_sync',true)");
  let idx = Number((await db.client.query(
    "SELECT COALESCE(MAX(split_part(key,'|',1)::int),0) m FROM products WHERE mbo_id=$1", [MBO_ID])).rows[0].m) || 0;
  let n = 0;
  for (const a of toAdd) {
    idx += 1;
    const key = `${String(idx).padStart(5, "0")}|studioeast:${a.handle}`;
    const r = await db.client.query(
      `INSERT INTO products (mbo_id,key,mbo_url,brand,base_price,base_currency,base_usd)
       VALUES ($1,$2,$3,$4,$5,'USD',$5) ON CONFLICT (mbo_id,key) DO NOTHING`,
      [MBO_ID, key, a.mbo_url, a.brand, a.price]);
    n += r.rowCount;
  }
  return n;
});

const pruneIds = toPrune.map((r) => r.id);
let pruned = 0;
const CH = 500;
for (let i = 0; i < pruneIds.length; i += CH) {
  const chunk = pruneIds.slice(i, i + CH);
  const r = await q(`DELETE FROM products WHERE mbo_id=$1 AND id = ANY($2::bigint[]) RETURNING key`, [MBO_ID, chunk]);
  pruned += r.length;
  const keys = r.map((x) => x.key);
  if (keys.length) await q(`DELETE FROM import_catalog WHERE mbo_id=$1 AND key = ANY($2::text[])`, [MBO_ID, keys]);
}

console.log(`\nAPPLIED — added ${added}, pruned ${pruned}`);
console.log(`rollback if needed: the pre-change snapshot is ${BAK}\n`);
await pool.end();
