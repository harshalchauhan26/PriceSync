// Pipeline runner (port of saas.py _pipeline): concurrency, safe-retry, live log.
import pLimit from "p-limit";
import { Fetcher, extractRow } from "./engine.js";
import { toInr } from "./fx.js";
import * as store from "./store.js";
const engTol = store.matchTol;

export const CONFIG = {
  concurrency: 8, timeout_ms: 12000, batch_size: 500, rest_between: 2,
  simulation: false, fresh_start: true, retry_errors: false,
  safe_retry: true, safe_concurrency: 1, vendors: [],
};
export const STATE = {
  running: false, abort: false, phase: "idle", total_rows: 0, pre_done: 0,
  completed: 0, matched: 0, mismatch: 0, errors: 0, retry_total: 0,
  retry_completed: 0, retry_recovered: 0, started_at: null,
  message: "Idle. Configure and run.",
};
export const LOG = [];
const LOG_MAX = 5000;
export const LOGMETA = { offset: 0 };

function log(e) {
  LOG.push({ t: new Date().toISOString().slice(11, 19), ...e });
  if (LOG.length > LOG_MAX) { const d = LOG.length - LOG_MAX; LOG.splice(0, d); LOGMETA.offset += d; }
}

async function processOne(fetcher, prod, runId) {
  const url = (prod.url || "").trim();
  const base = prod.base_price, brand = prod.brand;
  const tag = prod.key || url;
  let live, currency;
  try {
    [live, currency] = await extractRow(fetcher, url, (prod.platform || "").trim(), prod.custom_regex || null);
    if (live == null) throw new Error("price not found");
  } catch (e) {
    log({ row: tag, domain: brand, url, currency: "-", price: "-", status: "Fetch Error", msg: e.message });
    await store.saveResult(prod, "Fetch Error", null, null, "error", runId);
    return "error";
  }
  const cur = currency || "UNKNOWN";
  if (base == null) {
    log({ row: tag, domain: brand, url, currency: cur, price: String(live), status: "Fetch Error", msg: "baseline unreadable" });
    await store.saveResult(prod, "Fetch Error", live, cur, "error", runId);
    return "error";
  }
  const liveInr = await toInr(live, cur);
  const delta = liveInr - base;
  const disp = ["INR", "UNKNOWN"].includes(cur) ? cur : `${cur}->INR`;
  let state, status;
  if (Math.abs(delta) <= engTol(base, cur)) { state = "matched"; status = `Price Matched (${cur})`; }
  else { state = "mismatch"; status = `Price Mismatch! (${cur})`; }
  log({ row: tag, domain: brand, url, currency: disp, price: liveInr.toFixed(2),
    status: state === "matched" ? "Price Matched" : "Price Mismatch!",
    msg: cur === "INR" ? "" : `${cur} ${live} -> INR` });
  await store.saveResult(prod, status, live, cur, state, runId);
  return state;
}

async function runPass(rows, workers, fetcher, runId, onDone) {
  const limit = pLimit(Math.max(1, workers));
  await Promise.all(rows.map((p) => limit(async () => {
    if (STATE.abort) return;
    const st = await processOne(fetcher, p, runId);
    onDone(st);
  })));
}

export async function startPipeline() {
  const runId = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 13);
  const mode = CONFIG.fresh_start ? "fresh" : "update";
  const vendors = (CONFIG.vendors && CONFIG.vendors.length) ? CONFIG.vendors : null;
  try {
    const rows = await store.workRows(mode, vendors);
    const total = await store.countProducts(vendors);
    Object.assign(STATE, { total_rows: total, pre_done: Math.max(0, total - rows.length),
      phase: "main", message: `Main pass — ${rows.length} product(s)` });
    const fetcher = new Fetcher({ timeout: CONFIG.timeout_ms });
    await runPass(rows, Math.min(25, Math.max(1, CONFIG.concurrency)), fetcher, runId, (st) => {
      STATE.completed++; STATE[st === "matched" ? "matched" : st === "mismatch" ? "mismatch" : "errors"]++;
    });
    if (!STATE.abort && CONFIG.safe_retry) {
      const errKeys = new Set((await store.dbProducts("update", vendors))
        .filter((r) => r.state === "error" && r.base_price != null).map((r) => r.key));
      const err = rows.filter((p) => errKeys.has(p.key));
      STATE.phase = "safe_retry"; STATE.retry_total = err.length; STATE.retry_completed = 0; STATE.retry_recovered = 0;
      STATE.message = `Safe-retry — ${err.length} errors, gently`;
      const slow = new Fetcher({ timeout: 15000, cooldown: [4000, 8000] });
      await runPass(err, CONFIG.safe_concurrency, slow, runId, (st) => {
        STATE.retry_completed++;
        if (st !== "error") { STATE.retry_recovered++; STATE.errors = Math.max(0, STATE.errors - 1);
          if (st === "matched") STATE.matched++; else if (st === "mismatch") STATE.mismatch++; }
      });
    }
    STATE.phase = "done";
    STATE.message = (STATE.abort ? "Aborted" : "Completed") +
      (STATE.retry_recovered ? ` (${STATE.retry_recovered} recovered)` : "") + ". Saved to database.";
  } catch (e) {
    STATE.phase = "done"; STATE.message = "Error: " + e.message;
  } finally {
    STATE.running = false;
  }
}
