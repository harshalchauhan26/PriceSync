// Compare a brand's stored base_price against the MBO storefront's INR price.
//
//   node web/server/tools/mbo-price-compare.mjs --brand aisharao.com
//   node web/server/tools/mbo-price-compare.mjs --list          # brands A-Z
//
// Reads the MBO Product URL only, asks Shopify Markets for the INR presentment
// (?currency=INR — the store itself is USD), and writes
// <Brand>_StudioEast_INR.xlsx. Touches no database.
//
// These two numbers are NOT the same quantity and are not expected to match:
//   base_price      = the DESIGNER's price, what a mismatch is judged against
//   studio_east_inr = the MBO's RETAIL price, designer price plus margin
// So a ratio above 1 is margin, not drift. Do not feed studio_east_inr back
// into base_price — that would set the baseline to your own retail price and
// every product would read as matched against a comparison never made.
import ExcelJS from "exceljs";
import axios from "axios";
import { q, pool, ping } from "../src/db.js";

const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const BRAND = arg("--brand");
const MBO_ID = Number(arg("--mbo") || 1);
const CONCURRENCY = Number(arg("--concurrency") || 3);
const GAP_MS = Number(arg("--gap") || 250);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsUrl = (u) => { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/+$/, "")}.js?currency=INR`; };

// Shopify throttles hard on a full-catalog sweep (a 8,777-row run lost 1,072
// rows to 429 even at 1.2/s), so retries back off generously rather than
// giving up — a brand-sized run should come back complete.
async function fetchOne(u, attempt = 0) {
  try {
    const r = await axios.get(jsUrl(u), {
      timeout: 20000, responseType: "text", transformResponse: (x) => x,
      validateStatus: () => true, maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json,*/*" },
    });
    if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep(3000 * (attempt + 1)); return fetchOne(u, attempt + 1); }
    if (r.status === 404) return { err: "404 - gone from the MBO store" };
    if (r.status >= 400) return { err: `HTTP ${r.status}` };
    const j = JSON.parse(r.data);
    const v = (j.variants || [])[0] || j;
    const cand = [v.compare_at_price, v.price].map((x) => (Number.isInteger(x) ? x / 100 : null)).filter((x) => x != null);
    return { price: cand.length ? Math.max(...cand) : null, min: j.price_min / 100, max: j.price_max / 100, title: j.title };
  } catch (e) {
    if (attempt < 3) { await sleep(2500); return fetchOne(u, attempt + 1); }
    return { err: String(e.code || e.message).slice(0, 30) };
  }
}

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

if (!BRAND) {
  const bs = await q("SELECT brand, count(*)::int n FROM products WHERE mbo_id=$1 GROUP BY brand ORDER BY brand", [MBO_ID]);
  console.log(`\n${bs.length} brands (A-Z):\n`);
  bs.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.brand.padEnd(30)} ${String(b.n).padStart(5)} rows`));
  console.log("\nrun one with:  node tools/mbo-price-compare.mjs --brand <brand>\n");
  await pool.end();
  process.exit(0);
}

const rows = await q(
  `SELECT url, mbo_url, base_price, live_price, currency, state FROM products
   WHERE mbo_id=$1 AND brand=$2 ORDER BY url`, [MBO_ID, BRAND]);
if (!rows.length) { console.error(`no products for brand "${BRAND}"`); await pool.end(); process.exit(1); }
console.log(`${BRAND}: ${rows.length} rows (${rows.filter((r) => /^https?:/.test(r.mbo_url || "")).length} with an MBO URL)`);

const out = [];
let cursor = 0, done = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < rows.length) {
    const i = cursor++;
    const r = rows[i];
    out[i] = /^https?:/.test(r.mbo_url || "") ? { ...r, ...(await fetchOne(r.mbo_url)) } : { ...r, err: "no MBO URL" };
    if (++done % 50 === 0) console.log(`  ${done}/${rows.length}`);
    await sleep(GAP_MS);
  }
}));

const ok = out.filter((o) => o.price != null);
const diff = ok.filter((o) => Number(o.base_price) !== o.price);
const ratios = diff.filter((o) => o.base_price > 0).map((o) => o.price / o.base_price).sort((a, b) => a - b);
const pc = (x) => (ratios.length ? ratios[Math.floor(ratios.length * x)].toFixed(3) : "-");

console.log(`\nscraped ${ok.length} | failed ${out.length - ok.length}`);
console.log(`base == studio ${ok.length - diff.length} | differs ${diff.length}`);
if (ratios.length) console.log(`ratio studio/base — min ${ratios[0].toFixed(3)}  p25 ${pc(0.25)}  median ${pc(0.5)}  p75 ${pc(0.75)}  max ${ratios[ratios.length - 1].toFixed(3)}`);
const fails = {};
out.filter((o) => o.price == null).forEach((o) => { fails[o.err] = (fails[o.err] || 0) + 1; });
if (Object.keys(fails).length) { console.log("failures:"); Object.entries(fails).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`)); }

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet(BRAND.slice(0, 30));
const C = ["designer_url", "mbo_url", "title", "base_price", "studio_east_inr", "diff", "ratio", "variant_range", "db_live_price", "db_state", "error"];
ws.addRow(C); ws.getRow(1).font = { bold: true };
ws.views = [{ state: "frozen", ySplit: 1 }];
ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.length } };
out.forEach((o) => ws.addRow([o.url, o.mbo_url, o.title || "", o.base_price, o.price ?? "",
  o.price != null ? o.price - Number(o.base_price) : "",
  o.price != null && o.base_price > 0 ? Math.round((o.price / o.base_price) * 1000) / 1000 : "",
  o.min != null && o.min !== o.max ? `${o.min}-${o.max}` : "", o.live_price, o.state, o.err || ""]));
ws.columns.forEach((c, i) => { c.width = [56, 58, 30, 12, 16, 12, 9, 16, 13, 10, 26][i] || 16; });

const file = `${BRAND.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/gi, "_")}_StudioEast_INR.xlsx`;
await wb.xlsx.writeFile(`c:/Users/HARSHAL/OneDrive/Desktop/New folder (7)/${file}`);
console.log(`\nWrote ${file}. No database was touched.\n`);
await pool.end();
