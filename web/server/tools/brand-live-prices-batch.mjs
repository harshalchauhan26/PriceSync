// Run brand-live-prices.mjs's fetch across EVERY brand and write one .xlsx
// per brand into a new timestamped folder — the same designer_url/mbo_url/
// price/usd_price sheet you get from a single --brand run, just for all of
// them in one go.
//
//   node web/server/tools/brand-live-prices-batch.mjs
//   node web/server/tools/brand-live-prices-batch.mjs --brands amitaggarwal.com,manijassal.com --limit 5   # smoke test
//
// Reuses fetchBrandLivePrices()/buildWorkbook() from brand-live-prices.mjs —
// there is exactly one implementation of "how a brand's live price sheet gets
// built"; this tool only adds the brand-list loop and per-brand file writing.
//
// Brands run BRAND_CONCURRENCY at a time (mirrors fetch-audit.mjs's mapLimit
// pattern — safe because different brands are different domains, and
// Fetcher._domainNext paces each domain independently regardless of how many
// OTHER brands are in flight). Default 4, not fetch-audit's 6: each brand here
// also fans out internally to its own concurrency (3, or 1 for gentle brands)
// across a FULL catalog rather than a 7-row sample, so 4x3=12 peak connections
// is already enough parallelism without one giant brand starving the rest.
//
// A brand with zero fetchable rows, or one that throws mid-fetch, is skipped
// and logged — it does not stop the batch.
//
// Writes NOTHING to the database.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { fetchBrandLivePrices, buildWorkbook } from "./brand-live-prices.mjs";

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const MBO_ID = Number(argOf("--mbo") || 1);
const ONLY = (argOf("--brands") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LIMIT = Number(argOf("--limit") || 0); // per-brand row cap, for a fast smoke test
const BRAND_CONCURRENCY = Number(argOf("--brand-concurrency") || 4);

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

  const brandRows = await q(
    `SELECT DISTINCT brand FROM products WHERE mbo_id=$1 AND brand IS NOT NULL AND brand <> '' ORDER BY brand`,
    [MBO_ID]);
  const brands = brandRows.map((r) => r.brand)
    .filter((b) => !ONLY.length || ONLY.includes(store.normBrand(b)));

  if (!brands.length) { console.error("no matching brands"); await pool.end(); process.exit(1); }

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..", `BrandLivePrices_${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n${brands.length} brands -> ${outDir}\n`);
  let done = 0, skipped = 0, totalOk = 0, totalFailed = 0, totalWrong = 0;

  await mapLimit(brands, BRAND_CONCURRENCY, async (brand) => {
    try {
      const r = await fetchBrandLivePrices(MBO_ID, brand, { limit: LIMIT });
      done++;
      if (!r.out.length) { skipped++; console.log(`  [${done}/${brands.length}] ${brand} — SKIPPED (no fetchable rows)`); return; }
      const wb = buildWorkbook(brand, r.out, r.cfg);
      const file = `${brand.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/gi, "_")}_LivePrices.xlsx`;
      await wb.xlsx.writeFile(path.join(outDir, file));
      totalOk += r.ok; totalFailed += r.failed; totalWrong += r.wrongCur.length;
      console.log(`  [${done}/${brands.length}] ${brand} — ${r.out.length} rows, ok=${r.ok} failed=${r.failed}${r.wrongCur.length ? ` WRONG_CURRENCY=${r.wrongCur.length}` : ""}`);
    } catch (e) {
      done++; skipped++;
      console.log(`  [${done}/${brands.length}] ${brand} — ERROR: ${e.message}`);
    }
  });

  console.log(`\n${brands.length - skipped} files written, ${skipped} brands skipped, ok=${totalOk} failed=${totalFailed} wrong-currency=${totalWrong}`);
  console.log(`Output: ${outDir}\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
