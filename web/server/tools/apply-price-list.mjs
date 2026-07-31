// Apply a Studio East price list to Supabase: add genuinely new products and
// correct base prices. Nothing else moves.
//
//   node web/server/tools/apply-price-list.mjs "path/to/list.xlsx"           # dry run
//   node web/server/tools/apply-price-list.mjs "path/to/list.xlsx" --apply   # writes
//
// Expects the standard columns: MBO Product URL, Designer Product URL,
// Platform Type, Custom Regex, Studio East Price.
//
// IDENTITY is the (designer URL, MBO URL) pair, not the designer URL alone.
// The same designer product is legitimately listed under several MBO URLs, and
// keying on the designer URL would treat a second listing as a duplicate and
// clobber its MBO URL.
//
// HOST ALIASES: a brand whose catalog was migrated to a regional storefront is
// still written the old way in the sheet. anitadongre.com was moved wholesale
// to us.anitadongre.com (tracked in USD against base_usd); without the alias
// below, 172 rows look "new" and get inserted a second time on the Indian
// host, then fetched in INR against a USD baseline. Add to this map whenever a
// brand's fetch host is switched in engine.js DEFAULT_FETCH_HOSTS.
import * as XLSX from "xlsx";
import fs from "node:fs";
import { q, pool, ping, withTenant } from "../src/db.js";
import { brandOf } from "../src/store.js";

const HOST_ALIASES = [[/^us\.anitadongre\.com/, "anitadongre.com"]];

const FILE = process.argv[2];
const APPLY = process.argv.includes("--apply");
const MBO_ID = 1;

if (!FILE || !fs.existsSync(FILE)) {
  console.error("usage: node tools/apply-price-list.mjs <sheet.xlsx> [--apply]");
  process.exit(1);
}

const ident = (u) => {
  let s = String(u || "").trim().toLowerCase().replace(/\/+$/, "");
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  for (const [re, to] of HOST_ALIASES) s = s.replace(re, to);
  return s;
};
const nm = (s) => String(s || "").trim().replace(/\/+$/, "").toLowerCase();
const money = (v) => { const x = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(x) && x > 0 ? x : null; };

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(FILE), { type: "buffer" }).Sheets.Sheet1, { defval: "" });
const prods = await q("SELECT key,url,mbo_url,base_price,brand FROM products WHERE mbo_id=$1", [MBO_ID]);

const byPair = new Map(), byDesigner = new Set();
for (const r of prods) {
  byPair.set(ident(r.url) + "||" + nm(r.mbo_url), r);
  byDesigner.add(ident(r.url));
}

const adds = [], changes = [], skipped = [];
let unchanged = 0;
const seen = new Set();
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const url = String(r["Designer Product URL"] || "").trim();
  const mbo = String(r["MBO Product URL"] || "").trim();
  const price = money(r["Studio East Price"]);
  if (!url || !price) { skipped.push({ row: i + 2, url, why: !url ? "no designer URL" : "no price" }); continue; }
  const pair = ident(url) + "||" + nm(mbo);
  if (seen.has(pair)) continue;
  seen.add(pair);
  const hit = byPair.get(pair);
  if (!hit) adds.push({ url, mbo, price, platform: String(r["Platform Type"] || "").trim(),
    custom_regex: String(r["Custom Regex"] || "").trim(), known: byDesigner.has(ident(url)) });
  else if (Number(hit.base_price) !== price) changes.push({ key: hit.key, brand: hit.brand, url: hit.url, old: Number(hit.base_price), next: price });
  else unchanged++;
}

console.log(`\nsheet rows ${rows.length} | DB ${prods.length}`);
console.log(`unchanged ${unchanged} | price changes ${changes.length} | to add ${adds.length} | unusable ${skipped.length}`);

if (!APPLY) { console.log("\nDRY RUN — pass --apply to write.\n"); await pool.end(); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const BAK = `products_bak_${stamp}_presheet`;
await q(`CREATE TABLE IF NOT EXISTS ${BAK} AS SELECT * FROM products`);
const bak = await q(`SELECT count(*)::int n FROM ${BAK}`);
console.log(`\nbackup: ${BAK} (${bak[0].n} rows)`);

const result = await withTenant(MBO_ID, async (db) => {
  // Labels the audit rows the base_price trigger writes for the corrections.
  await db.client.query("SELECT set_config('app.base_source','sheet_add',true)");
  let updated = 0;
  for (const c of changes) {
    const r = await db.client.query("UPDATE products SET base_price=$1 WHERE mbo_id=$2 AND key=$3", [c.next, MBO_ID, c.key]);
    updated += r.rowCount;
  }
  let idx = Number((await db.client.query(
    "SELECT COALESCE(MAX(split_part(key,'|',1)::int),0) m FROM products WHERE mbo_id=$1", [MBO_ID])).rows[0].m) || 0;
  let added = 0;
  for (const a of adds) {
    idx += 1;
    const key = `${String(idx).padStart(5, "0")}|${a.url.slice(0, 280)}`;
    const r = await db.client.query(
      `INSERT INTO products (mbo_id,key,mbo_url,url,platform,custom_regex,brand,base_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (mbo_id,key) DO NOTHING`,
      [MBO_ID, key, a.mbo, a.url, a.platform, a.custom_regex, brandOf(a.url), a.price]);
    added += r.rowCount;
  }
  return { added, updated };
});

const after = await q("SELECT count(*)::int n FROM products WHERE mbo_id=$1", [MBO_ID]);
console.log(`\nAPPLIED — added ${result.added}, base prices updated ${result.updated}`);
console.log(`products: ${prods.length} -> ${after[0].n}`);
console.log(`rollback if needed: the pre-change snapshot is ${BAK}\n`);
await pool.end();
