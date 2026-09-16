// One-off: turn "New url for update - August-22.xlsx" (designer_url=studioeast6
// URL, mbo_url=the actual designer-brand URL -- reversed naming from the DB's
// own url/mbo_url columns, see chat) into a sheet apply-price-list.mjs can
// consume. None of these 81 rows exist yet in products (checked by exact and
// normalized MBO-URL match), so this is an ADD, not an update -- and adding
// needs a Studio East Price, which the source sheet doesn't carry.
//
// Studio East Price is scraped straight from the studioeast6.com URL via its
// Shopify .js JSON endpoint, same method and same ?currency=INR pin as
// scrape-mbo-prices.mjs (studioeast6 is a USD-native Shopify store; INR must
// be requested explicitly, never sniffed off the page).
//
//   node web/server/tools/build-sheet-for-new-url-update.mjs
//
// Writes "New url for update - August-22 - priced.xlsx" next to the input.
// Touches no database. Feed the output to apply-price-list.mjs (dry-run
// first) to actually add the products.
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { q, pool, ping } from "../src/db.js";

const IN = path.resolve("../../New url for update - August-22.xlsx");
const OUT = IN.replace(/\.xlsx$/i, "") + " - priced.xlsx";
const CONCURRENCY = 6;

const jsUrl = (u) => { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/+$/, "")}.js?currency=INR`; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPrice(url, attempt = 0) {
  try {
    const r = await axios.get(jsUrl(url), {
      timeout: 20000, responseType: "text", transformResponse: (x) => x, validateStatus: () => true,
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json,*/*" },
    });
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= 3) return { error: `HTTP ${r.status}` };
      await sleep((2 ** attempt) * 1500 + Math.random() * 500);
      return fetchPrice(url, attempt + 1);
    }
    if (r.status === 404) return { error: "product not found (404)" };
    if (r.status >= 400) return { error: `HTTP ${r.status}` };
    let j;
    try { j = JSON.parse(r.data); } catch { return { error: "not a product page" }; }
    const v0 = (j.variants || [])[0] || j;
    const cand = [v0.compare_at_price, v0.price].map((x) => (Number.isInteger(x) ? x / 100 : null)).filter((x) => x != null);
    const price = cand.length ? Math.max(...cand) : null;
    if (!price) return { error: "no price in product JSON" };
    return { price, title: j.title || "" };
  } catch (e) {
    if (attempt >= 3) return { error: e.code || e.message.slice(0, 40) };
    await sleep((2 ** attempt) * 1500);
    return fetchPrice(url, attempt + 1);
  }
}

function brandOf(url) {
  try { const h = new URL(String(url || "")).host.toLowerCase(); return h.startsWith("www.") ? h.slice(4) : h; }
  catch { return ""; }
}

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

const wb = XLSX.read(fs.readFileSync(IN), { type: "buffer" });
const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
const rows = raw.filter((r) => r.designer_url && r.mbo_url);
console.log(`${rows.length} rows to price`);

// Majority Platform Type per designer-brand host, from what's already tracked.
const platformByBrand = new Map();
for (const r of rows) {
  const brand = brandOf(r.mbo_url);
  if (platformByBrand.has(brand)) continue;
  const hit = await q(
    `SELECT platform, count(*) c FROM products WHERE mbo_id=1 AND brand=$1 AND platform<>''
       GROUP BY platform ORDER BY c DESC LIMIT 1`, [brand]);
  platformByBrand.set(brand, hit[0]?.platform || "");
}
await pool.end();

const results = new Array(rows.length);
let cursor = 0, ok = 0, failed = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < rows.length) {
    const i = cursor++;
    const r = await fetchPrice(rows[i].designer_url);
    results[i] = r;
    r.error ? failed++ : ok++;
  }
}));

const outRows = [], errors = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i], res = results[i];
  const brand = brandOf(r.mbo_url);
  if (res.price != null) {
    outRows.push({
      "MBO Product URL": r.designer_url,
      "Designer Product URL": r.mbo_url,
      "Platform Type": platformByBrand.get(brand) || "",
      "Custom Regex": "",
      "Studio East Price": res.price,
    });
  } else {
    errors.push({ studioeast6_url: r.designer_url, designer_url: r.mbo_url, reason: res.error });
  }
}

const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(outRows), "Sheet1");
if (errors.length) XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(errors), "not_priced");
XLSX.writeFile(outWb, OUT);

console.log(`priced ok: ${ok}  failed: ${failed}`);
console.log(`wrote ${OUT}`);
console.log("No database was touched by this step.");
