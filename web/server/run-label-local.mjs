// Local refresh for labelanushree.com — the store 400s / geo-serves USD to the
// cloud server + relay IPs, but returns correct INR to an India IP. So refresh
// its rows from this machine using the exact production pipeline (same statuses,
// history, safe-retry). Run manually or via Task Scheduler:  node run-label-local.mjs
import * as pipe from "./src/pipeline.js";
import { initStore } from "./src/store.js";

await initStore();
const eng = pipe.getEngine("local-label-fix");
if (eng.state.running) { console.log("previous run still going — exiting."); process.exit(1); }
Object.assign(eng.config, {
  vendors: ["labelanushree.com"],
  data_source: "database",
  fresh_start: true,
  simulation: false,
  threads: 1,
  concurrency: 6,        // site answers India IPs fast; no bot wall seen
  cooldown_min: 0.6,
  cooldown_max: 1.5,
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
}, 5000);

await pipe.startPipeline(eng, runId);
clearInterval(ticker);
const s = eng.state;
console.log(`\nDONE: completed=${s.completed} matched=${s.matched} mismatch=${s.mismatch} errors=${s.errors} recovered=${s.retry_recovered}`);
for (const e of eng.log) if (e.status === "Fetch Error") console.log("ERR:", e.row, e.msg, e.url);
process.exit(0);
