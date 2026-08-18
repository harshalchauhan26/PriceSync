// Fetch a brand's LIVE price from the DESIGNER's own site and write a sheet of
// designer URL + MBO URL + that price (+ a USD conversion of it).
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
// usd_price is computed via fx.js (the app's one shared, cached, tenant-aware
// currency module — same rates used everywhere else prices get converted),
// never by scraping a brand's own currency-converter widget. A brand-specific
// widget rate is ~0.1-0.2% more "accurate" to that one site's own display, but
// only exists on some Shopify stores; fx.js works for every brand/platform and
// is one shared rate fetch for a whole run instead of one per brand domain.
//
// fetchBrandLivePrices()/buildWorkbook() are exported so brand-live-prices-batch.mjs
// can run the exact same fetch+currency logic across every brand — there is
// only one implementation of "how a brand's live price sheet gets built."
//
// Writes NOTHING to the database.
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { Fetcher, extractRow, extractShopify, requestedCurrency, withCurrencyParam } from "../src/engine.js";
import { toUsd } from "../src/fx.js";
import { config } from "../src/config.js";

// Records the URL actually requested, so the sheet shows the method rather
// than asserting it (extractShopify silently falls back from .js to HTML).
class LoggingFetcher extends Fetcher {
  constructor(o) { super(o); this.calls = []; }
  async get(url) { this.calls.push(url); return super.get(url); }
}

// Some Shopify stores have REAL multi-currency (Shopify Markets) enabled —
// manijassal.com quotes CAD 350 natively but genuinely charges USD 270.47 to
// a US buyer, which is NOT the same as 350 * a generic FX rate (Shopify adds
// its own markup/rounding on top of the raw rate: 270.47/350 = 0.773, vs the
// live market rate of ~0.719 fx.js would use — a ~7.5% gap). ?country=US on
// the plain .js endpoint returns that exact authoritative number with zero
// extra auth. Cached per-domain (not per-row) so a domain WITHOUT Markets
// (the common case) only pays this extra request once, not on every product.
const MARKETS_USD_CACHE = new Map();
async function shopifyMarketsUsd(fetcher, domain, url, nativePrice, preferHigh) {
  if (MARKETS_USD_CACHE.get(domain) === false) return null;
  let usPrice = null;
  try { [usPrice] = await extractShopify(fetcher, withCurrencyParam(url, "country", "US"), preferHigh); } catch { /* fall through */ }
  // A store without Markets USD just re-serves the native price unchanged —
  // treating that as "USD" would silently mislabel a CAD/INR number.
  const real = usPrice != null && Math.abs(usPrice - nativePrice) > 0.01;
  if (MARKETS_USD_CACHE.get(domain) === undefined) MARKETS_USD_CACHE.set(domain, real);
  return real ? usPrice : null;
}

// Fetches every row.url for `brand`, resolves each price + currency + USD
// conversion, and returns everything buildWorkbook() needs. Never throws for
// "no fetchable rows" — callers looping many brands need to skip, not crash.
export async function fetchBrandLivePrices(mboId, brand, opts = {}) {
  const { limit = 0, currencyOverride, concurrency, onProgress } = opts;

  const rows = await q(
    `SELECT id, brand, platform, custom_regex, url, mbo_url, base_price, base_usd,
            live_price, currency, state, status
       FROM products
      WHERE mbo_id=$1 AND brand=$2 AND url IS NOT NULL AND url <> ''
      ORDER BY url ${limit ? "LIMIT " + limit : ""}`, [mboId, brand]);
  if (!rows.length) return { brand, platform: "", cfg: null, out: [], ok: 0, failed: 0, wrongCur: [] };

  // Exactly the config a pipeline run loads (code defaults + Supabase overrides).
  const nb = store.normBrand(brand);
  const nativeCur = (await store.nativeCurrencyBrands(mboId))[nb] || null;
  const isUsd = (await store.usdFetchBrandSet(mboId)).has(nb);
  const preferHigh = (await store.rangeHighBrandSet(mboId)).has(nb);
  const wooApi = (await store.wooApiBrandSet(mboId)).has(nb);
  const gentle = (await store.gentleBrandSet(mboId)).has(nb);
  const appendParams = (await store.relayAppendParams(mboId))[nb] || undefined;
  const cfg = { nativeCur, isUsd, preferHigh, wooApi, gentle };

  // Concurrency buys less than it looks like it should: Fetcher._domainNext is a
  // STATIC per-domain schedule, so every worker queues behind one cooldown per
  // domain and a single-brand run is paced at roughly cooldown + latency however
  // many workers you start. 3 is enough to hide latency behind the cooldown; more
  // just piles up waiting. Gentle (bot-protected) brands stay at 1 — that's the
  // same treatment chunkArray() gives them in the real pipeline.
  const CONCURRENCY = concurrency != null ? Math.max(1, Number(concurrency)) : (gentle ? 1 : 3);

  const out = new Array(rows.length);
  let cursor = 0, done = 0, ok = 0, failed = 0;

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    // Fetcher._domainNext is static, so per-domain pacing holds across workers.
    const f = new LoggingFetcher({ timeout: 20000, cooldown: [700, 1600], maxRetries: 3 });
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      const platform = (r.platform || "").trim();
      const fetchCur = currencyOverride || requestedCurrency({ isNativeCurrency: !!nativeCur, isUsdBrand: isUsd, platform });
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
      const resolvedCur = currency || (nativeCur || fetchCur || "");

      // usd_price is left blank (never guessed) when we don't have a real
      // currency label to convert from — same "visible blank over plausible
      // wrong figure" rule the WRONG CURRENCY guard below already applies.
      let usd_price = "", usd_rate_used = "";
      if (price != null && resolvedCur && resolvedCur !== "UNKNOWN") {
        if (resolvedCur === "USD") { usd_price = Math.round(price * 100) / 100; usd_rate_used = "1:1 native"; }
        else {
          let marketsUsd = null;
          if (platform.toLowerCase() === "shopify") {
            const domain = (() => { try { return new URL(r.url).host; } catch { return ""; } })();
            marketsUsd = await shopifyMarketsUsd(f, domain, r.url, price, preferHigh);
          }
          if (marketsUsd != null) { usd_price = Math.round(marketsUsd * 100) / 100; usd_rate_used = "shopify:country=US"; }
          else {
            const u = await toUsd(mboId, price, resolvedCur);
            if (u != null) { usd_price = u; usd_rate_used = Math.round((u / price) * 1e6) / 1e6; }
          }
        }
      }

      out[i] = { ...r, price, currency: resolvedCur, err, usd_price, usd_rate_used,
        requested_currency: fetchCur || (nativeCur ? `native:${nativeCur}` : "(none)"),
        fetch_url: f.calls[f.calls.length - 1] || "" };
      price != null ? ok++ : failed++;
      done++;
      onProgress?.(done, rows.length, ok, failed);
    }
  }));

  // A price that came back in a currency we did not ask for is NOT written as a
  // number — that is the guard pipeline.js applies, and the same trap applies to
  // a sheet: a plausible wrong figure is worse than a visible blank.
  const wrongCur = out.filter((o) => o.price != null && o.currency && o.requested_currency !== "(none)"
    && !o.requested_currency.startsWith("native:") && o.currency !== "UNKNOWN"
    && o.currency !== o.requested_currency);

  return { brand, platform: rows[0].platform || "", cfg, out, ok, failed, wrongCur };
}

export function buildWorkbook(brand, out, cfg) {
  const isUsd = !!cfg?.isUsd;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(brand.replace(/[^a-z0-9]/gi, "_").slice(0, 30));
  const C = ["designer_url", "mbo_url", "designer_price", "currency", "requested_currency",
    "usd_price", "usd_rate_used", "base_price", "diff_vs_base", "fetch_url",
    "db_live_price", "db_state", "db_status", "error"];
  ws.addRow(C); ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.length } };
  out.forEach((o) => ws.addRow([
    o.url, o.mbo_url || "", o.price ?? "", o.currency || "", o.requested_currency,
    o.usd_price, o.usd_rate_used,
    isUsd ? o.base_usd : o.base_price,
    o.price != null ? Math.round((o.price - Number(isUsd ? o.base_usd : o.base_price)) * 100) / 100 : "",
    o.fetch_url, o.live_price ?? "", o.state || "", o.status || "", o.err || "",
  ]));
  ws.columns.forEach((c, i) => { c.width = [58, 58, 15, 10, 18, 12, 14, 12, 13, 72, 13, 10, 24, 30][i] || 16; });
  const usdCol = C.indexOf("usd_price") + 1;
  for (let r = 1; r <= out.length + 1; r++) {
    ws.getCell(r, usdCol).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  }
  return wb;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
  const BRAND = arg("--brand");
  const MBO_ID = Number(arg("--mbo") || 1);
  const CONCURRENCY_ARG = arg("--concurrency");
  const LIMIT = Number(arg("--limit") || 0);
  const CURRENCY_OVERRIDE = arg("--currency"); // e.g. --currency USD, to force a currency the brand isn't configured for

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

  const t0 = Date.now();
  const { platform, cfg, out, ok, failed, wrongCur } = await fetchBrandLivePrices(MBO_ID, brand, {
    limit: LIMIT, currencyOverride: CURRENCY_OVERRIDE, concurrency: CONCURRENCY_ARG,
    onProgress: (done, total, okN, failedN) => {
      if (done % 25 === 0 || done === total) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${total}  ok=${okN} failed=${failedN}  ${rate.toFixed(2)}/s  eta ${Math.max(0, Math.round((total - done) / rate / 60))}m`);
      }
    },
  });
  if (!out.length) { console.error(`no products with a designer URL for "${brand}"`); await pool.end(); process.exit(1); }

  console.log(`\n${brand} — ${out.length} products (${out.filter((r) => /^https?:/.test(r.mbo_url || "")).length} also have an MBO URL)`);
  console.log(`platform ${platform || "(blank)"} | flags: ${[cfg.preferHigh && "range-high", cfg.wooApi && "woo-api",
    cfg.isUsd && "usd-brand", cfg.nativeCur && `native:${cfg.nativeCur}`, cfg.gentle && "gentle"].filter(Boolean).join(" ") || "none"}`);
  console.log(`relay: ${config.fetchRelayUrl || "(none — fetching direct from this machine)"}`);
  console.log(`concurrency ${CONCURRENCY_ARG != null ? Math.max(1, Number(CONCURRENCY_ARG)) : (cfg.gentle ? 1 : 3)}${CONCURRENCY_ARG == null ? " (default)" : ""}`);
  if (cfg.gentle && CONCURRENCY_ARG > 1) console.log(`NOTE: ${brand} is a gentle (bot-protected) brand — concurrency ${CONCURRENCY_ARG} may draw 403s.`);

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

  const wb = buildWorkbook(brand, out, cfg);

  // A --limit run is a spot check, so it must NOT land on the full run's
  // filename — otherwise a 5-row smoke test silently replaces a finished
  // export with a file that looks complete and isn't.
  const file = `${brand.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/gi, "_")}_LivePrices${CURRENCY_OVERRIDE ? `_${CURRENCY_OVERRIDE}` : ""}${LIMIT ? `_first${LIMIT}` : ""}.xlsx`;
  const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  await wb.xlsx.writeFile(path.join(outDir, file));
  console.log(`\nWrote ${file}. No database was touched.\n`);
  await pool.end();
}
