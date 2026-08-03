// Scrape the MBO storefront's INR price for every row of a price list and
// write the SAME sheet back with Studio East Price refreshed.
//
//   node web/server/tools/scrape-mbo-prices.mjs "<sheet.xlsx>" ["<out.xlsx>"]
//
// Reads ONLY the MBO Product URL column. Touches no database.
//
// WHY ?currency=INR: studioeast6.com is a USD store — Shopify.currency.active
// is "USD" and product.js returns 59000 = $590.00. Appending ?currency=INR
// asks Shopify Markets for the INR presentment (5720000 = ₹57,200). That
// number is the USD price times Shopify's live rate, so it moves day to day;
// it is what an Indian visitor sees, not an independent INR price list.
//
// Do NOT read the currency off the page here. detectCurrency() reports INR for
// this USD storefront because the country switcher carries a ₹ figure — the
// same trap already fixed for anitadongre. The currency is known because it
// was pinned in the request, so it is asserted, never sniffed.
import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import fs from "node:fs";
import axios from "axios";

const IN = process.argv[2];
const OUT = process.argv[3] || IN.replace(/\.xlsx$/i, "") + " - MBO INR.xlsx";
const CONCURRENCY = 6;
const PRICE_COL = "Studio East Price";
const MBO_COL = "MBO Product URL";

if (!IN || !fs.existsSync(IN)) { console.error("usage: node tools/scrape-mbo-prices.mjs <sheet.xlsx> [out.xlsx]"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsUrl = (u) => { const x = new URL(u); return `${x.origin}${x.pathname.replace(/\/+$/, "")}.js?currency=INR`; };

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
    // Same pre-sale rule the engine uses for Shopify: an on-sale product keeps
    // the original in compare_at_price while price holds the discounted one.
    const v0 = (j.variants || [])[0] || j;
    const cand = [v0.compare_at_price, v0.price].map((x) => (Number.isInteger(x) ? x / 100 : null)).filter((x) => x != null);
    const price = cand.length ? Math.max(...cand) : null;
    if (!price) return { error: "no price in product JSON" };
    return { price, min: j.price_min != null ? j.price_min / 100 : null, max: j.price_max != null ? j.price_max / 100 : null,
      variants: (j.variants || []).length, title: j.title || "" };
  } catch (e) {
    if (attempt >= 3) return { error: e.code || e.message.slice(0, 40) };
    await sleep((2 ** attempt) * 1500);
    return fetchPrice(url, attempt + 1);
  }
}

const wbIn = XLSX.read(fs.readFileSync(IN), { type: "buffer" });
const sheetName = wbIn.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wbIn.Sheets[sheetName], { defval: "" });
const COLS = Object.keys(rows[0]);
console.log(`${rows.length} rows | columns: ${COLS.join(", ")}`);

const results = new Array(rows.length);
let done = 0, ok = 0, failed = 0, noUrl = 0;
let cursor = 0;
const t0 = Date.now();

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < rows.length) {
    const i = cursor++;
    const url = String(rows[i][MBO_COL] || "").trim();
    if (!/^https?:\/\//.test(url)) { results[i] = { error: "no MBO URL" }; noUrl++; done++; continue; }
    const r = await fetchPrice(url);
    results[i] = r;
    r.error ? failed++ : ok++;
    done++;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${rows.length}  ok=${ok} failed=${failed}  ${rate.toFixed(1)}/s  eta ${Math.round((rows.length - done) / rate / 60)}m`);
    }
  }
}));

// Rebuild the sheet EXACTLY as it came in, with the price column refreshed.
const changes = [], errors = [];
const outRows = rows.map((r, i) => {
  const res = results[i] || {};
  const old = Number(String(r[PRICE_COL] ?? "").replace(/[^0-9.]/g, "")) || null;
  const copy = { ...r };
  if (res.price != null) {
    copy[PRICE_COL] = res.price;
    if (old !== res.price) changes.push({ mbo_url: r[MBO_COL], designer_url: r["Designer Product URL"],
      title: res.title, old_price: old, new_price: res.price, diff: old != null ? res.price - old : null,
      variants: res.variants, range: res.min != null && res.max != null && res.min !== res.max ? `${res.min}-${res.max}` : "" });
  } else {
    // Unreadable row keeps its original price — a blank would look like ₹0.
    errors.push({ mbo_url: r[MBO_COL] || "(blank)", designer_url: r["Designer Product URL"], kept_price: old, reason: res.error });
  }
  return copy;
});

const wb = new ExcelJS.Workbook();
const add = (name, data, cols, widths) => {
  const ws = wb.addWorksheet(name);
  ws.addRow(cols); ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  data.forEach((d) => ws.addRow(cols.map((c) => d[c])));
  ws.columns.forEach((c, i) => { c.width = widths?.[i] ?? 24; });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
};
add(sheetName, outRows, COLS, [58, 58, 14, 16, 18, 20]);
add("changes", changes, ["designer_url", "mbo_url", "title", "old_price", "new_price", "diff", "variants", "range"], [52, 52, 30, 12, 12, 12, 10, 16]);
add("not_scraped", errors, ["designer_url", "mbo_url", "kept_price", "reason"], [52, 52, 12, 34]);
await wb.xlsx.writeFile(OUT);

console.log(`\nscraped ok      : ${ok}`);
console.log(`price changed   : ${changes.length}`);
console.log(`unchanged       : ${ok - changes.length}`);
console.log(`could not read  : ${failed} (${noUrl} of them had no MBO URL) — original price kept`);
console.log(`\nWrote ${OUT}`);
console.log("No database was touched.\n");
