// One-off: re-fetch every usd_convert_brands product so live_price/delta/state
// catch up to the corrected FX rate (base_usd was already fixed directly via
// refreshUsdBaselines; this is the live-price half of that same fix -- see
// tools/fix-usd-convert-currency-mislabel.mjs and store.js's refreshUsdBaselines
// for the rest of the story). Same production pipeline as the "Run Pipeline"
// button, just scoped to these ~35 brands instead of the whole catalog.
//
//   node web/server/tools/refresh-usd-convert-brands.mjs
import * as pipe from "../src/pipeline.js";
import { initStore, usdConvertBrandSet } from "../src/store.js";

await initStore();
const brands = [...(await usdConvertBrandSet(1))];
if (!brands.length) { console.log("usd_convert_brands is empty — nothing to refresh."); process.exit(0); }
console.log(`refreshing ${brands.length} usd_convert brand(s): ${brands.join(", ")}`);

const eng = pipe.getEngine(1, "usd-convert-refresh");
if (eng.state.running) { console.log("previous run still in progress — exiting."); process.exit(1); }
Object.assign(eng.config, {
  vendors: brands,
  data_source: "database",
  fresh_start: true,
});
Object.assign(eng.state, {
  running: true, abort: false, phase: "main", completed: 0, matched: 0,
  mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0,
  retry_recovered: 0, started_at: Date.now(),
});
const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-usdconv";

const ticker = setInterval(() => {
  const s = eng.state;
  console.log(`[${s.phase}] ${s.completed}/${s.total_rows} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} | ${s.message}`);
  if (s.phase === "done") clearInterval(ticker);
}, 30000);

await pipe.startPipeline(eng, runId);
clearInterval(ticker);
const s = eng.state;
console.log(`\nDONE: completed=${s.completed} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} recovered=${s.retry_recovered}`);
console.log(s.message);
process.exit(0);
