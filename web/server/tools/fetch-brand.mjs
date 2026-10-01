// Run the real production pipeline (live fetch from the designer's own site,
// compared against base_price) scoped to one or more brands, from the CLI --
// same engine, statuses and safe-retry as a normal run, just filtered.
//
//   node web/server/tools/fetch-brand.mjs international.itrh.co
//   node web/server/tools/fetch-brand.mjs brand1.com brand2.com
import * as pipe from "../src/pipeline.js";
import { initStore } from "../src/store.js";

const brands = process.argv.slice(2);
if (!brands.length) {
  console.error("usage: node tools/fetch-brand.mjs <brand> [brand2 ...]");
  process.exit(1);
}

await initStore();
console.log("fetching live prices for:", brands.join(", "));

const eng = pipe.getEngine(1, "cli-fetch-brand");
if (eng.state.running) { console.log("a run is already in progress for this engine slot — exiting."); process.exit(1); }
Object.assign(eng.config, { vendors: brands, data_source: "database", fresh_start: true });
Object.assign(eng.state, {
  running: true, abort: false, phase: "main", completed: 0, matched: 0,
  mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0,
  retry_recovered: 0, started_at: Date.now(),
});
const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-cli";

const ticker = setInterval(() => {
  const s = eng.state;
  console.log(`[${s.phase}] ${s.completed}/${s.total_rows} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} | ${s.message}`);
  if (s.phase === "done") clearInterval(ticker);
}, 5000);

await pipe.startPipeline(eng, runId);
clearInterval(ticker);
const s = eng.state;
console.log(`\nDONE: completed=${s.completed} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} recovered=${s.retry_recovered}`);
console.log(s.message);
for (const e of eng.log) {
  if (e.status === "Fetch Error") console.log("ERR:", e.row, e.msg, e.url);
}
process.exit(0);
