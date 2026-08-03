// Fetch a brand's LIVE price from the DESIGNER's own site and write a sheet of
// designer URL + MBO URL + that price.
//
//   node web/server/tools/brand-live-prices.mjs --brand saakshakinni.com
//
// This is the mirror image of mbo-price-compare.mjs: that tool reads the MBO
// storefront (studioeast6) price, this one reads the designer's price — the
// number the tracker treats as the baseline's counterpart.
//
// It goes through the real extractRow() with the real per-brand config loaded
// from store.js, so a row here is fetched exactly the way a pipeline run would
// fetch it — same platform dispatch, same Woo Store API route, same pinned
// currency. Hand-rolling the fetch is how saakshakinni.com ended up compared in
// GBP against an INR baseline; don't reintroduce that by scraping it directly.
//
// Fetches sequentially by default. Brands on the gentle list are bot-protected
// and kept to one in-flight request per domain by the pipeline too.
//
// Writes NOTHING to the database.
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { Fetcher, extractRow, requestedCurrency } from "../src/engine.js";
import { config } from "../src/config.js";

const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const BRAND = arg("--brand");
const MBO_ID = Number(arg("--mbo") || 1);
const CONCURRENCY_ARG = arg("--concurrency");
const LIMIT = Number(arg("--limit") || 0);

const p = await ping();
if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

if (!BRAND) {
  const bs = await q("SELECT brand, count(*)::int n FROM products WHERE mbo_id=$1 GROUP BY brand ORDER BY brand", [MBO_ID]);
  console.log(`\n${bs.length} brands (A-Z):\n`);
  bs.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.brand.padEnd(30)} ${String(b.n).padStart(5)} rows`));
  console.log("\nrun one with:  node tools/brand-live-prices.mjs --brand <brand>\n");
  await pool.end();
  process.exit(0);
}

// Resolve the brand the same way store.js keys its config maps, so a brand
// typed without the TLD (or with different case) still picks up its flags.
const all = await q("SELECT DISTINCT brand FROM products WHERE mbo_id=$1", [MBO_ID]);
const want = store.normBrand(BRAND);
const brand = all.map((r) => r.brand).find((b) => store.normBrand(b) === want)
  || all.map((r) => r.brand).find((b) => store.normBrand(b).startsWith(want));
if (!brand) { console.error(`no brand matching "${BRAND}"`); await pool.end(); process.exit(1); }

const rows = await q(
  `SELECT id, brand, platform, custom_regex, url, mbo_url, base_price, base_usd,
          live_price, currency, state, status
     FROM products
    WHERE mbo_id=$1 AND brand=$2 AND url IS NOT NULL AND url <> ''
    ORDER BY url ${LIMIT ? "LIMIT " + LIMIT : ""}`, [MBO_ID, brand]);
if (!rows.length) { console.error(`no products with a designer URL for "${brand}"`); await pool.end(); process.exit(1); }

// Exactly the config a pipeline run loads (code defaults + Supabase overrides).
const nb = store.normBrand(brand);
const nativeCur = (await store.nativeCurrencyBrands(MBO_ID))[nb] || null;
const isUsd = (await store.usdFetchBrandSet(MBO_ID)).has(nb);
const preferHigh = (await store.rangeHighBrandSet(MBO_ID)).has(nb);
const wooApi = (await store.wooApiBrandSet(MBO_ID)).has(nb);
const gentle = (await store.gentleBrandSet(MBO_ID)).has(nb);
const appendParams = (await store.relayAppendParams(MBO_ID))[nb] || undefined;

console.log(`\n${brand} — ${rows.length} products (${rows.filter((r) => /^https?:/.test(r.mbo_url || "")).length} also have an MBO URL)`);
console.log(`platform ${rows[0].platform || "(blank)"} | flags: ${[preferHigh && "range-high", wooApi && "woo-api",
  isUsd && "usd-brand", nativeCur && `native:${nativeCur}`, gentle && "gentle"].filter(Boolean).join(" ") || "none"}`);
// Concurrency buys less than it looks like it should: Fetcher._domainNext is a
// STATIC per-domain schedule, so every worker queues behind one cooldown per
// domain and a single-brand run is paced at roughly cooldown + latency however
// many workers you start. 3 is enough to hide latency behind the cooldown; more
// just piles up waiting. Gentle (bot-protected) brands stay at 1 — that's the
// same treatment chunkArray() gives them in the real pipeline.
const CONCURRENCY = CONCURRENCY_ARG != null ? Math.max(1, Number(CONCURRENCY_ARG)) : (gentle ? 1 : 3);
console.log(`relay: ${config.fetchRelayUrl || "(none — fetching direct from this machine)"}`);
console.log(`concurrency ${CONCURRENCY}${CONCURRENCY_ARG == null ? " (default)" : ""}`);
if (gentle && CONCURRENCY > 1) console.log(`NOTE: ${brand} is a gentle (bot-protected) brand — concurrency ${CONCURRENCY} may draw 403s.`);

// Records the URL actually requested, so the sheet shows the method rather
// than asserting it (extractShopify silently falls back from .js to HTML).
class LoggingFetcher extends Fetcher {
  constructor(o) { super(o); this.calls = []; }
  async get(url) { this.calls.push(url); return super.get(url); }
}

const out = new Array(rows.length);
let cursor = 0, done = 0, ok = 0, failed = 0;
const t0 = Date.now();

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
  // Fetcher._domainNext is static, so per-domain pacing holds across workers.
  const f = new LoggingFetcher({ timeout: 20000, cooldown: [700, 1600], maxRetries: 3 });
  while (cursor < rows.length) {
    const i = cursor++;
    const r = rows[i];
    const platform = (r.platform || "").trim();
    const fetchCur = requestedCurrency({ isNativeCurrency: !!nativeCur, isUsdBrand: isUsd, platform });
    f.calls = [];
    let price = null, currency = null, err = null;
    try {
      [price, currency] = await extractRow(f, r.url, platform, r.custom_regex || null, {
        fetchCurrency: fetchCur || undefined,
        preferHighPrice: preferHigh || undefined,
        appendParams,
        wooApi: wooApi || undefined,
      });
    } catch (e) { err = e.message; }
    // The currency is ASSERTED from what was requested, never sniffed off the
    // page — a page carrying a ₹ figure in a country switcher is not evidence.
    out[i] = { ...r, price, currency: currency || (nativeCur || fetchCur || ""), err,
      requested_currency: fetchCur || (nativeCur ? `native:${nativeCur}` : "(none)"),
      fetch_url: f.calls[f.calls.length - 1] || "" };
    price != null ? ok++ : failed++;
    if (++done % 25 === 0 || done === rows.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${rows.length}  ok=${ok} failed=${failed}  ${rate.toFixed(2)}/s  eta ${Math.max(0, Math.round((rows.length - done) / rate / 60))}m`);
    }
  }
}));

// A price that came back in a currency we did not ask for is NOT written as a
// number — that is the guard pipeline.js applies, and the same trap applies to
// a sheet: a plausible wrong figure is worse than a visible blank.
const wrongCur = out.filter((o) => o.price != null && o.currency && o.requested_currency !== "(none)"
  && !o.requested_currency.startsWith("native:") && o.currency !== "UNKNOWN"
  && o.currency !== o.requested_currency);

const priced = out.filter((o) => o.price != null);
const changed = priced.filter((o) => Number(o.base_price) !== o.price);
console.log(`\nfetched ok        : ${ok}`);
console.log(`could not read    : ${failed}`);
console.log(`same as base_price: ${priced.length - changed.length}`);
console.log(`differs from base : ${changed.length}`);
if (wrongCur.length) console.log(`WRONG CURRENCY    : ${wrongCur.length} rows came back in a currency that was not requested — see the currency column`);
const fails = {};
out.filter((o) => o.price == null).forEach((o) => { fails[o.err || "no price found"] = (fails[o.err || "no price found"] || 0) + 1; });
if (Object.keys(fails).length) { console.log("failures:"); Object.entries(fails).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`)); }

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet(brand.replace(/[^a-z0-9]/gi, "_").slice(0, 30));
const C = ["designer_url", "mbo_url", "designer_price", "currency", "requested_currency",
  "base_price", "diff_vs_base", "fetch_url", "db_live_price", "db_state", "db_status", "error"];
ws.addRow(C); ws.getRow(1).font = { bold: true };
ws.views = [{ state: "frozen", ySplit: 1 }];
ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.length } };
out.forEach((o) => ws.addRow([
  o.url, o.mbo_url || "", o.price ?? "", o.currency || "", o.requested_currency,
  isUsd ? o.base_usd : o.base_price,
  o.price != null ? Math.round((o.price - Number(isUsd ? o.base_usd : o.base_price)) * 100) / 100 : "",
  o.fetch_url, o.live_price ?? "", o.state || "", o.status || "", o.err || "",
]));
ws.columns.forEach((c, i) => { c.width = [58, 58, 15, 10, 18, 12, 13, 72, 13, 10, 24, 30][i] || 16; });

// A --limit run is a spot check, so it must NOT land on the full run's
// filename — otherwise a 5-row smoke test silently replaces a finished
// export with a file that looks complete and isn't.
const file = `${brand.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/gi, "_")}_LivePrices${LIMIT ? `_first${LIMIT}` : ""}.xlsx`;
const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
await wb.xlsx.writeFile(path.join(outDir, file));
console.log(`\nWrote ${file}. No database was touched.\n`);
await pool.end();
