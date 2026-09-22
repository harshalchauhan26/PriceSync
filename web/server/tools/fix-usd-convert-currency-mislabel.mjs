// Fixes rows in usd_convert_brands whose base_currency is mislabeled "USD".
//
//   node web/server/tools/fix-usd-convert-currency-mislabel.mjs             # dry run (default)
//   node web/server/tools/fix-usd-convert-currency-mislabel.mjs --apply     # write the fix
//
// usd_convert_brands (Decision-006) fetches a brand's NATIVE price and
// converts it to USD via fx.js for comparison -- by definition base_price
// for these brands must be denominated in a non-USD currency. A handful of
// rows carry base_currency='USD' anyway: leftovers from when the brand was
// briefly in fetch_usd_brands at import time (baseCurrencyResolver stamps
// base_currency='USD' for that set), later moved to usd_convert_brands
// without correcting the already-imported rows.
//
// refreshUsdBaselines() (called every pipeline run) does
// toUsd(base_price, base_currency) per row. For these rows that's
// toUsd(x, "USD") -- convert to INR then immediately back by the same rate,
// a same-currency round trip that leaves base_usd === base_price: a
// six-figure INR number mislabeled as a USD baseline. finalizeOne() then
// compares that against a genuinely-converted (two/three-figure) USD live
// price and reports a five/six-figure "mismatch".
//
// Fix: relabel base_currency='INR' (the only currency usd_convert_brands
// rows are ever imported in besides a real native-currency override, and
// what every unaffected sibling row for the same brand already has), then
// recompute base_usd = toUsd(base_price, 'INR'). Where live_price is
// already on file (currency='USD'), also recompute delta/state/status
// immediately rather than leaving the stale corrupted values in Review
// until the next pipeline run.
import { q, pool, ping } from "../src/db.js";
import { toUsd } from "../src/fx.js";
import { usdConvertBrandSet, isPriceMatch } from "../src/store.js";

const MBO_ID = Number((process.argv.includes("--mbo") && process.argv[process.argv.indexOf("--mbo") + 1]) || 1);
const APPLY = process.argv.includes("--apply");

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const brands = [...await usdConvertBrandSet(MBO_ID)];
  const rows = await q(
    `SELECT id, key, brand, url, base_price, base_usd, live_price, currency, delta, state
       FROM products
      WHERE mbo_id=$1 AND brand = ANY($2::text[]) AND base_currency='USD' AND base_price IS NOT NULL
      ORDER BY brand, id`,
    [MBO_ID, brands]);

  if (!rows.length) { console.log("No mislabeled rows found."); await pool.end(); return; }

  const byBrand = new Map();
  for (const r of rows) byBrand.set(r.brand, (byBrand.get(r.brand) || 0) + 1);
  console.log(`${rows.length} row(s) with base_currency='USD' inside usd_convert_brands (invalid combination):`);
  for (const [b, n] of byBrand) console.log(`  ${b.padEnd(28)} ${n} row(s)`);
  console.log();

  let fixed = 0, deltaFixed = 0;
  for (const r of rows) {
    const newBaseUsd = await toUsd(MBO_ID, r.base_price, "INR");
    let newDelta = r.delta, newState = r.state, newStatus = null;
    if (r.live_price != null && r.currency === "USD" && newBaseUsd != null) {
      newDelta = Math.round((r.live_price - newBaseUsd) * 100) / 100;
      newState = isPriceMatch(newDelta) ? "matched" : "mismatch";
      newStatus = `Price ${newState === "matched" ? "Matched" : "Mismatch!"} (USD)`;
      deltaFixed++;
    }
    console.log(`${r.key}  base=${r.base_price}  base_usd ${r.base_usd} -> ${newBaseUsd}` +
      (newDelta !== r.delta ? `  delta ${r.delta} -> ${newDelta}  state ${r.state} -> ${newState}` : ""));
    if (APPLY) {
      if (newStatus != null) {
        await q(`UPDATE products SET base_currency='INR', base_usd=$1, delta=$2, state=$3, status=$4
                  WHERE mbo_id=$5 AND id=$6`,
          [newBaseUsd, newDelta, newState, newStatus, MBO_ID, r.id]);
      } else {
        await q(`UPDATE products SET base_currency='INR', base_usd=$1 WHERE mbo_id=$2 AND id=$3`,
          [newBaseUsd, MBO_ID, r.id]);
      }
      fixed++;
    }
  }

  console.log(`\n${APPLY ? "Applied" : "Would apply"}: base_currency/base_usd fix on ${rows.length} row(s), ` +
    `${deltaFixed} with an immediate delta/state recompute.`);
  if (!APPLY) console.log("Dry run -- no changes written. Re-run with --apply to write.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
