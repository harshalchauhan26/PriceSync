// Read-only "what are we actually fetching?" audit.
//   node web/server/tools/fetch-audit.mjs [--per-brand 7] [--brand x.com,y.com]
//
// Takes the first N products of EVERY brand and re-fetches each one live
// through the real extractRow() with the real per-brand config, then writes
// FetchAudit_<date>.xlsx + .csv and prints a per-brand summary.
//
// Point of the tool: show the METHOD, not just the number. Every URL the
// fetcher actually requests is recorded, so you can see at a glance whether a
// row came from Shopify's .js JSON, the Woo Store API, a custom regex, or
// generic HTML scraping — and which currency was asked for.
//
// Writes NOTHING to the database. Safe to run against production data.
//
// CAVEAT: it fetches from wherever you run it. On the India dev laptop the
// geo-priced brands answer in INR; the Render box may see different numbers
// for brands without a country/currency lever. The `requested_currency` and
// `fetch_urls` columns are what stays true on both.
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { Fetcher, extractRow, requestedCurrency } from "../src/engine.js";
import { toInr } from "../src/fx.js";
import { config } from "../src/config.js";

const MBO_ID = Number(argOf("--mbo") || 1);
const PER_BRAND = Number(argOf("--per-brand") || 7);
const ONLY = (argOf("--brand") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const BRAND_CONCURRENCY = 6;

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// Records every URL the extractor really requests, so the report can show the
// method instead of asserting it. extractShopify probes .js first and silently
// falls back to HTML — only the call log distinguishes those two outcomes.
class LoggingFetcher extends Fetcher {
  constructor(o) { super(o); this.calls = []; }
  async get(url) { this.calls.push(url); return super.get(url); }
}

// Mirrors the dispatch in engine.js extractRow (~line 476). Kept as a LABEL
// only — the authoritative answer is the fetch_urls column below.
function methodLabel(platform, customRegex, wooApi) {
  const p = (platform || "").trim().toLowerCase();
  if (p === "shopify") return "Shopify .js JSON (HTML fallback)";
  if (wooApi) return "Woo Store API (/wp-json)";
  if (customRegex) return "custom regex on HTML";
  return p ? `${p} -> generic HTML/JSON-LD` : "unknown platform -> Shopify probe";
}

// What the recorded call log proves actually happened.
function methodActual(calls) {
  if (!calls.length) return "no request made";
  const last = calls[calls.length - 1];
  if (last.includes("/wp-json/wc/store")) return "Woo Store API";
  if (/\.js(\?|$)/.test(last)) return "Shopify .js JSON";
  if (calls.length > 1 && calls.some((c) => /\.js(\?|$)/.test(c))) return "HTML (Shopify .js failed)";
  return "HTML page";
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  // Exactly the config the pipeline loads for a run (store.js is the single
  // source of truth — code defaults unioned with the Supabase meta overrides).
  const eng = {
    usdFetchBrands: await store.usdFetchBrandSet(MBO_ID),
    rangeHighBrands: await store.rangeHighBrandSet(MBO_ID),
    wooApiBrands: await store.wooApiBrandSet(MBO_ID),
    gentleBrands: await store.gentleBrandSet(MBO_ID),
    localOnlyBrands: await store.localOnlyBrandSet(MBO_ID),
    nativeCurrency: await store.nativeCurrencyBrands(MBO_ID),
    relayParams: await store.relayAppendParams(MBO_ID),
  };

  const brandRows = await q(
    `SELECT brand, count(*)::int n FROM products WHERE mbo_id=$1 AND url IS NOT NULL AND url <> ''
     GROUP BY brand ORDER BY brand`, [MBO_ID]);
  const brands = brandRows.filter((b) => !ONLY.length || ONLY.includes(store.normBrand(b.brand)));

  console.log(`\n=== Fetch audit — MBO ${MBO_ID} | ${brands.length} brands x first ${PER_BRAND} products ===`);
  console.log(`Relay: ${config.fetchRelayUrl ? config.fetchRelayUrl : "(none — fetching direct from this machine)"}\n`);

  const results = [];
  let done = 0;
  await mapLimit(brands, BRAND_CONCURRENCY, async (b) => {
    const nb = store.normBrand(b.brand);
    const rows = await q(
      `SELECT id, brand, platform, custom_regex, url, base_price, base_usd, live_price, currency, state, status
       FROM products WHERE mbo_id=$1 AND brand=$2 AND url IS NOT NULL AND url <> ''
       ORDER BY id LIMIT $3`, [MBO_ID, b.brand, PER_BRAND]);

    const nativeCur = eng.nativeCurrency[nb] || null;
    const isUsd = eng.usdFetchBrands.has(nb);
    const preferHigh = eng.rangeHighBrands.has(nb);
    const wooApi = eng.wooApiBrands.has(nb);

    // One fetcher per brand: Fetcher._domainNext is static, so per-domain
    // pacing still holds across the whole run even at BRAND_CONCURRENCY 6.
    const f = new LoggingFetcher({ timeout: 20000, cooldown: [600, 1400], maxRetries: 2 });

    for (const r of rows) {
      const platform = (r.platform || "").trim();
      const fetchCur = requestedCurrency({
        isNativeCurrency: !!nativeCur, isUsdBrand: isUsd, platform,
      });
      f.calls = [];
      let live = null, currency = null, err = null;
      const t0 = Date.now();
      try {
        [live, currency] = await extractRow(f, r.url, platform, r.custom_regex || null, {
          fetchCurrency: fetchCur || undefined,
          preferHighPrice: preferHigh || undefined,
          appendParams: eng.relayParams[nb] || undefined,
          wooApi: wooApi || undefined,
        });
      } catch (e) { err = e.message; }
      const ms = Date.now() - t0;

      // Baseline the row is actually judged against: USD brands compare on
      // base_usd, native-currency brands on their own currency, else INR.
      const baseCol = isUsd ? "base_usd" : "base_price";
      const base = isUsd ? r.base_usd : r.base_price;
      const liveInr = live != null && !nativeCur && !isUsd ? await toInr(MBO_ID, live, currency) : live;
      const delta = base != null && liveInr != null ? Math.round((liveInr - base) * 100) / 100 : null;
      const ratio = base > 0 && liveInr != null ? Math.round((liveInr / base) * 1000) / 1000 : null;

      results.push({
        brand: r.brand,
        platform: platform || "(blank)",
        method_configured: methodLabel(platform, r.custom_regex, wooApi),
        method_actual: err ? `FAILED — ${err}` : methodActual(f.calls),
        flags: [preferHigh && "range-high", wooApi && "woo-api", isUsd && "usd-brand",
          nativeCur && `native:${nativeCur}`, eng.gentleBrands.has(nb) && "gentle",
          r.custom_regex && "custom-regex"].filter(Boolean).join(" "),
        requested_currency: fetchCur || "(none)",
        url: r.url,
        fetch_urls: f.calls.join("  |  "),
        baseline_column: baseCol,
        base_price: base ?? null,
        fetched_price: live ?? null,
        fetched_currency: currency || (err ? "" : "UNKNOWN"),
        price_in_inr: liveInr ?? null,
        delta,
        ratio,
        verdict: err ? "FETCH FAILED"
          : live == null ? "NO PRICE FOUND"
          : base == null ? "no baseline to compare"
          : ratio != null && Math.abs(liveInr - base) <= 1 ? "exact match"
          : `differs (${ratio}x)`,
        db_live_price: r.live_price ?? null,
        db_state: r.state || "",
        db_status: r.status || "",
        ms,
      });
    }
    done++;
    console.log(`  [${String(done).padStart(2)}/${brands.length}] ${b.brand.padEnd(28)} ${rows.length} rows`);
  });

  results.sort((a, b) => a.brand.localeCompare(b.brand) || a.url.localeCompare(b.url));

  // ---- per-brand summary ----
  const byBrand = new Map();
  for (const r of results) {
    const s = byBrand.get(r.brand) || { brand: r.brand, method: r.method_configured, flags: r.flags,
      requested_currency: r.requested_currency, n: 0, priced: 0, failed: 0, exact: 0, differs: 0, no_price: 0, currencies: new Set() };
    s.n++;
    if (r.verdict === "FETCH FAILED") s.failed++;
    else if (r.verdict === "NO PRICE FOUND") s.no_price++;
    else { s.priced++; if (r.verdict === "exact match") s.exact++; else if (r.verdict.startsWith("differs")) s.differs++; }
    if (r.fetched_currency) s.currencies.add(r.fetched_currency);
    byBrand.set(r.brand, s);
  }
  const summary = [...byBrand.values()].map((s) => ({ ...s, currencies: [...s.currencies].join("/") }));

  console.log(`\n${"BRAND".padEnd(26)}${"METHOD".padEnd(34)}${"ASK".padEnd(6)}${"GOT".padEnd(8)} OK  EXACT DIFF NONE FAIL`);
  for (const s of summary) {
    console.log(
      s.brand.slice(0, 25).padEnd(26) + s.method.slice(0, 33).padEnd(34) +
      s.requested_currency.slice(0, 5).padEnd(6) + (s.currencies || "-").slice(0, 7).padEnd(8) +
      String(s.priced).padStart(3) + String(s.exact).padStart(6) + String(s.differs).padStart(5) +
      String(s.no_price).padStart(5) + String(s.failed).padStart(5));
  }
  const tot = summary.reduce((a, s) => ({ n: a.n + s.n, priced: a.priced + s.priced, exact: a.exact + s.exact,
    differs: a.differs + s.differs, no_price: a.no_price + s.no_price, failed: a.failed + s.failed }),
    { n: 0, priced: 0, exact: 0, differs: 0, no_price: 0, failed: 0 });
  console.log(`\nTOTAL ${tot.n} products — ${tot.priced} priced (${tot.exact} exact vs baseline, ${tot.differs} differ), ${tot.no_price} no price, ${tot.failed} failed`);

  // ---- xlsx + csv ----
  const COLS = ["brand", "platform", "method_configured", "method_actual", "flags", "requested_currency",
    "url", "fetch_urls", "baseline_column", "base_price", "fetched_price", "fetched_currency",
    "price_in_inr", "delta", "ratio", "verdict", "db_live_price", "db_state", "db_status", "ms"];
  const SUM_COLS = ["brand", "method", "flags", "requested_currency", "currencies", "n", "priced", "exact", "differs", "no_price", "failed"];

  const wb = new ExcelJS.Workbook();
  const add = (name, data, cols, widths) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    data.forEach((d) => ws.addRow(cols.map((c) => d[c])));
    ws.columns.forEach((c, i) => { c.width = widths?.[i] ?? 22; });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  add("by_brand", summary, SUM_COLS, [26, 34, 30, 12, 12, 6, 8, 8, 8, 9, 7]);
  add("products", results, COLS, [24, 12, 32, 26, 30, 10, 60, 70, 15, 12, 13, 10, 12, 10, 8, 22, 13, 10, 30, 7]);

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const xlsx = path.join(outDir, `FetchAudit_${stamp}.xlsx`);
  const csv = path.join(outDir, `FetchAudit_${stamp}.csv`);
  await wb.xlsx.writeFile(xlsx);
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  fs.writeFileSync(csv, [COLS.join(","), ...results.map((r) => COLS.map((c) => esc(r[c])).join(","))].join("\n"), "utf8");
  console.log(`\nWrote ${xlsx}\n      ${csv}\n`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
