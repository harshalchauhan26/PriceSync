// One-off: run the pipeline directly (no HTTP/auth) so live prices + mismatch
// states get written into Supabase. Configurable via env:
//   SCRAPE_SOURCE = database | imported   (default database)
//   SCRAPE_VENDORS = comma,separated,brands (optional scope)
import * as pipe from "./src/pipeline.js";
import * as store from "./src/store.js";
import { pool } from "./src/db.js";

const source = process.env.SCRAPE_SOURCE === "imported" ? "imported" : "database";
const vendors = (process.env.SCRAPE_VENDORS || "").split(",").map((s) => s.trim()).filter(Boolean);

console.log("[scrape] source:", source, "vendors:", vendors.length ? vendors.join(", ") : "(all)");

// The pipeline is driven through a per-user "engine" context (config + state).
const eng = pipe.getEngine("scrape-once");
Object.assign(eng.config, {
  data_source: source, fresh_start: true, retry_errors: false,
  concurrency: 6, timeout_ms: 12000, batch_size: 250, rest_between: 2,
  safe_retry: true, simulation: false, vendors,
});
eng.state.running = true;

console.log("[scrape] starting…");
const runId = "scrape-once-" + Date.now();
await pipe.startPipeline(eng, runId);
console.log("[scrape] finished:", {
  matched: eng.state.matched, mismatch: eng.state.mismatch, errors: eng.state.errors,
  message: eng.state.message,
});
console.log("[scrape] DB counts now:", await store.counts());
await pool.end();
process.exit(0);
