import * as pipe from "./pipeline.js";
import * as store from "./store.js";

// Weekly auto-run: every product in the tenant, Monday + Thursday at 10:00 IST,
// report mailed to SCHEDULE_MAIL_TO (the completion mail carries the sheets).
// Off unless SCHEDULE_MAIL_TO is set. Needs a server that stays up (a sleeping
// free Render instance misses the 10:00 tick and loses a run midway).
const MBO_ID = 1;
const DAYS = new Set(["Mon", "Thu"]);
const HOUR_IST = 10;
// One-off extra run (owner request 2026-10-13). Fires once at/after this time, within
// 3h, if no run has started since. ponytail: hardcoded date, delete after it has run.
const ONCE_AT = new Date("2026-10-13T11:10:00+05:30").getTime();

const istDate = (d) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const ist = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata",
    weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: p.weekday, hour: Number(p.hour) % 24 };
};

async function tick(to) {
  const { day, hour } = ist();
  const now = Date.now();
  const once = now >= ONCE_AT && now < ONCE_AT + 3 * 3600_000;
  if (!once && (!DAYS.has(day) || hour < HOUR_IST)) return;
  if (pipe.anyRunning(MBO_ID)) return;
  // Once per IST day, judged from the DB so redeploys can't repeat it. Only
  // scheduled runs (started_by null) count — a long run (4.5h+) must not be
  // re-fired later the same day just because a fixed gap since its start elapsed.
  const today = istDate(new Date());
  const runs = await store.recentPipelineRuns(MBO_ID, 10);
  if (once ? runs.some((r) => new Date(r.started_at).getTime() >= ONCE_AT)
    : runs.some((r) => r.started_by == null && istDate(new Date(r.started_at)) === today)) return;

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
