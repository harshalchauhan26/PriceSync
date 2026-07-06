// One-off local pipeline run for anitadongre.com — the deployed (Render)
// server is being refused by this site, so refresh its 172 rows from here.
// Uses the exact production pipeline (same statuses, history, safe-retry).
import * as pipe from "./src/pipeline.js";
import { initStore } from "./src/store.js";

await initStore();
const eng = pipe.getEngine("local-anita-fix");
Object.assign(eng.config, {
  vendors: ["anitadongre.com"],
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
// dump error rows from the in-memory log for diagnosis
for (const e of eng.log) {
  if (e.status === "Fetch Error") console.log("ERR:", e.row, e.msg, e.url);
}
process.exit(0);
