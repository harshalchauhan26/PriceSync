import * as pipe from "./pipeline.js";
import * as store from "./store.js";

// Weekly auto-run: every product in the tenant, Monday + Thursday at 10:00 IST,
// report mailed to SCHEDULE_MAIL_TO (the completion mail carries the sheets).
// Off unless SCHEDULE_MAIL_TO is set. Needs a server that stays up (a sleeping
// free Render instance misses the 10:00 tick and loses a run midway).
const MBO_ID = 1;
const DAYS = new Set(["Mon", "Thu"]);
const HOUR_IST = 10;
const MIN_GAP_MS = 6 * 3600_000; // survives redeploys: no second run if one started recently

const ist = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata",
    weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: p.weekday, hour: Number(p.hour) % 24 };
};

async function tick(to) {
  const { day, hour } = ist();
  if (!DAYS.has(day) || hour < HOUR_IST) return;
  if (pipe.anyRunning(MBO_ID)) return;
  const [last] = await store.recentPipelineRuns(MBO_ID, 1);
  if (last && Date.now() - new Date(last.started_at).getTime() < MIN_GAP_MS) return;

  const eng = pipe.getEngine(MBO_ID, "scheduler");
  Object.assign(eng.config, { vendors: [], data_source: "database", fresh_start: true, simulation: false });
  Object.assign(eng.state, { running: true, abort: false, phase: "main", completed: 0, matched: 0,
    mismatch: 0, errors: 0, retry_total: 0, retry_completed: 0, retry_recovered: 0, started_at: Date.now() });
  eng.log.length = 0; eng.logmeta.offset = 0;
  eng.userEmail = to;
  eng.startedByUid = null;
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13) + "-sched";
  console.log(`[MBO] scheduled run ${runId} starting`);
  pipe.startPipeline(eng, runId);
}

export function startScheduler(to) {
  if (!to) return;
  setInterval(() => { tick(to).catch((e) => console.error("[MBO] scheduler tick failed:", e.message)); },
    60_000).unref();
  console.log(`[MBO] scheduler on: Mon+Thu ${HOUR_IST}:00 IST -> ${to}`);
}
