// Refresh every brand on the local_only_brands meta list from this machine.
// These sites ban the cloud server's IP, so the deployed pipeline skips them;
// this script (run manually or via Task Scheduler) keeps their data fresh
// using the exact production pipeline (same statuses, history, safe-retry).
import * as pipe from "./src/pipeline.js";
import { initStore, localOnlyBrandSet } from "./src/store.js";

await initStore();
const brands = [...(await localOnlyBrandSet())];
if (!brands.length) {
  console.log("local_only_brands is empty — nothing to refresh.");
  process.exit(0);
}
console.log("refreshing local-only brands:", brands.join(", "));

const eng = pipe.getEngine("local-only-refresh");
if (eng.state.running) { console.log("previous refresh still running — exiting."); process.exit(1); }
Object.assign(eng.config, {
  vendors: brands,
  data_source: "database",
  fresh_start: true,
  simulation: false,
  threads: 1,            // inline path — single, gently-paced fetcher
  concurrency: 3,
  cooldown_min: 1.5,
  cooldown_max: 3,
  batch_size: 500,
  safe_retry: true,
});
Object.assign(eng.state, {
  running: true, abort: false, phase: "main", completed: 0, matched: 0,
  mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0,
  retry_recovered: 0, started_at: Date.now(),
});
const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-local";

const ticker = setInterval(() => {
  const s = eng.state;
  console.log(`[${s.phase}] ${s.completed}/${s.total_rows} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} | ${s.message}`);
  if (s.phase === "done") clearInterval(ticker);
}, 10000);

await pipe.startPipeline(eng, runId);
clearInterval(ticker);
const s = eng.state;
console.log(`\nDONE: completed=${s.completed} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} recovered=${s.retry_recovered}`);
console.log(s.message);
for (const e of eng.log) {
  if (e.status === "Fetch Error") console.log("ERR:", e.row, e.msg, e.url);
}
process.exit(0);
