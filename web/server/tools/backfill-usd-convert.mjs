// Decision-006: one-time migration for the "USD is primary" switch.
//
//   node web/server/tools/backfill-usd-convert.mjs           # apply
//   node web/server/tools/backfill-usd-convert.mjs --dry-run  # preview only
//
// Sets `usd_convert_brands` (store.setUsdConvertBrands) to every brand EXCEPT:
//   - saakshakinni.com            (explicitly stays INR-to-INR, per instruction)
//   - native_currency_brands      (already USD/CAD-native, handled elsewhere)
//   - usd_fetch_brand_set         (already has a real USD storefront)
//   - us.anitadongre.com          (its base_price is ALREADY USD-denominated,
//                                   not INR like the others -- converting it
//                                   again here would corrupt the baseline.
//                                   Also 0% fetchable today, a pre-existing,
//                                   unrelated platform issue.)
// Then backfills products.base_usd = toUsd(base_price, base_currency) for
// every row in those brands where base_usd is still null, so
// pipeline.js/finalizeOne() and server.js/approveOne() have a real USD
// baseline to compare against and push from immediately, not just after the
// baseline auto-sets itself on next successful fetch.
//
// Does NOT touch base_price itself, and does NOT touch saakshakinni.com or
// any already-flagged brand's rows.
import { q, pool, ping } from "../src/db.js";
import * as store from "../src/store.js";
import { toUsd } from "../src/fx.js";

const MBO_ID = Number((process.argv.includes("--mbo") && process.argv[process.argv.indexOf("--mbo") + 1]) || 1);
const DRY = process.argv.includes("--dry-run");

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const brandRows = await q(
    `SELECT DISTINCT brand FROM products WHERE mbo_id=$1 AND brand IS NOT NULL AND brand<>''`, [MBO_ID]);
  const all = brandRows.map((r) => r.brand);
  const native = await store.nativeCurrencyBrands(MBO_ID);
  const usdFetch = await store.usdFetchBrandSet(MBO_ID);
  const exclude = new Set(["saakshakinni.com", "us.anitadongre.com", ...Object.keys(native), ...usdFetch]);
  const target = all.filter((b) => !exclude.has(store.normBrand(b)));

  console.log(`\n${target.length} brands -> usd_convert_brands:`);
  console.log(target.sort().join(", "));
  console.log(`\nExcluded (stays as-is): ${[...exclude].join(", ")}\n`);

  if (DRY) {
    const rows = await q(
      `SELECT brand, count(*)::int n, count(*) FILTER (WHERE base_usd IS NULL)::int need_backfill
         FROM products WHERE mbo_id=$1 AND brand = ANY($2::text[]) GROUP BY brand ORDER BY brand`,
      [MBO_ID, target]);
    rows.forEach((r) => console.log(`  ${r.brand.padEnd(28)} ${r.n} rows, ${r.need_backfill} need base_usd backfill`));
    console.log("\n--dry-run: no changes written.\n");
    await pool.end();
    return;
  }

  await store.setUsdConvertBrands(MBO_ID, target);
  console.log("usd_convert_brands meta set.\n");

  const rows = await q(
    `SELECT id, base_price, base_currency FROM products
      WHERE mbo_id=$1 AND brand = ANY($2::text[]) AND base_usd IS NULL AND base_price IS NOT NULL`,
    [MBO_ID, target]);
  console.log(`Backfilling base_usd for ${rows.length} rows...`);

  let done = 0, ok = 0, skipped = 0;
  for (const r of rows) {
    const usd = await toUsd(MBO_ID, r.base_price, r.base_currency || "INR");
    if (usd != null) {
      await q(`UPDATE products SET base_usd=$1 WHERE mbo_id=$2 AND id=$3`, [usd, MBO_ID, r.id]);
      ok++;
    } else skipped++;
    if (++done % 1000 === 0) console.log(`  ${done}/${rows.length}`);
  }
  console.log(`\nDone. base_usd backfilled=${ok}, skipped=${skipped} (no base_price or no fx rate).\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
