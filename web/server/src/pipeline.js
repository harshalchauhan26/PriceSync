// Pipeline runner (port of saas.py _pipeline): concurrency, safe-retry, live log.
// Per-user engines: each logged-in admin gets their OWN { config, state, log,
// logmeta } context so multiple admins can run the scraper at the same time and
// see only their own progress + console. All results still write to the SHARED
// products / price_history tables via store.saveResult — the database is shared,
// only the run is private.
import pLimit from "p-limit";
import { Fetcher, extractRow } from "./engine.js";
import { toInr } from "./fx.js";
import * as store from "./store.js";
import { sendPipelineReport } from "./mailer.js";
const engTol = store.matchTol;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_MAX = 5000;

// Defaults new engines start from. data_source is seeded at boot from meta.
const DEFAULTS = { data_source: 'database' };
export function setDefault(key, val) { DEFAULTS[key] = val; }

function newConfig() {
  return {
    concurrency: 8, timeout_ms: 12000, batch_size: 500, rest_between: 2,
    simulation: false, fresh_start: true, retry_errors: false,
    safe_retry: true, safe_concurrency: 1, safe_cooldown_min: 4,
    safe_cooldown_max: 8, safe_rest_between: 30, safe_batch_size: 25,
    data_source: DEFAULTS.data_source, vendors: [],
  };
}
function newState() {
  return {
    running: false, abort: false, phase: "idle", total_rows: 0, pre_done: 0,
    completed: 0, matched: 0, mismatch: 0, errors: 0, retry_total: 0,
    retry_completed: 0, retry_recovered: 0, started_at: null,
    message: "Idle. Configure and run.",
  };
}
function newEngine() {
  return { config: newConfig(), state: newState(), log: [], logmeta: { offset: 0 } };
}

// uid -> engine context. Bounded by the (small) number of admin accounts.
const ENGINES = new Map();
export function getEngine(uid) {
  const k = String(uid);
  let e = ENGINES.get(k);
  if (!e) { e = newEngine(); ENGINES.set(k, e); }
  return e;
}
export function runningCount() {
  let n = 0;
  for (const e of ENGINES.values()) if (e.state.running) n++;
  return n;
}

function log(eng, e) {
  eng.log.push({ t: new Date().toISOString().slice(11, 19), ...e });
  if (eng.log.length > LOG_MAX) {
    const d = eng.log.length - LOG_MAX; eng.log.splice(0, d); eng.logmeta.offset += d;
  }
}

const normBrand = (b) => String(b || "").toLowerCase().replace(/^www\./, "").trim();

async function processOne(eng, fetcher, prod, runId) {
  const cfg = eng.config;
  const url = (prod.url || "").trim();
  const base = prod.base_price, brand = prod.brand;
  const tag = prod.key || url;
  // Brands configured for USD fetch (meta 'fetch_usd_brands') are scraped through
  // the store's currency switcher so we record the designer's USD price.
  const fetchCur = eng.usdFetchBrands && eng.usdFetchBrands.has(normBrand(brand)) ? "USD" : null;
  let live, currency;
  if (cfg.simulation) {
    await sleep(30 + Math.random() * 90);
    const roll = Math.random();
    if (roll < 0.05 || base == null) {
      log(eng, { row: tag, domain: brand, url, currency: '-', price: '-',
        status: 'Fetch Error', msg: 'simulated failure' });
      await store.saveResult(prod, 'Fetch Error', null, null, 'error', runId);
      return 'error';
    }
    live = roll > 0.12 ? base :
      Math.round(base * (Math.random() > 0.5 ? 1.1 : 0.9) * 100) / 100;
    currency = brand?.endsWith('.in') ? 'INR' : 'USD';
    const liveInr = await toInr(live, currency);
    const state = Math.abs(liveInr - base) <= engTol(base, currency) ? 'matched' : 'mismatch';
    const status = state === 'matched' ? 'Price Matched (simulation)' : 'Price Mismatch! (simulation)';
    log(eng, { row: tag, domain: brand, url, currency, price: liveInr.toFixed(2),
      status: state === 'matched' ? 'Price Matched' : 'Price Mismatch!', msg: 'simulation' });
    await store.saveResult(prod, status, live, currency, state, runId);
    return state;
  }
  try {
    [live, currency] = await extractRow(fetcher, url, (prod.platform || "").trim(),
      prod.custom_regex || null, fetchCur ? { fetchCurrency: fetchCur } : undefined);
    if (live == null) throw new Error("price not found");
  } catch (e) {
    log(eng, { row: tag, domain: brand, url, currency: "-", price: "-", status: "Fetch Error", msg: e.message });
    await store.saveResult(prod, "Fetch Error", null, null, "error", runId);
    return "error";
  }
  const cur = currency || "UNKNOWN";
  if (base == null) {
    log(eng, { row: tag, domain: brand, url, currency: cur, price: String(live), status: "Fetch Error", msg: "baseline unreadable" });
    await store.saveResult(prod, "Fetch Error", live, cur, "error", runId);
    return "error";
  }
  const liveInr = await toInr(live, cur);
  const delta = liveInr - base;
  const disp = ["INR", "UNKNOWN"].includes(cur) ? cur : `${cur}->INR`;
  let state, status;
  if (Math.abs(delta) <= engTol(base, cur)) { state = "matched"; status = `Price Matched (${cur})`; }
  else { state = "mismatch"; status = `Price Mismatch! (${cur})`; }
  log(eng, { row: tag, domain: brand, url, currency: disp, price: liveInr.toFixed(2),
    status: state === "matched" ? "Price Matched" : "Price Mismatch!",
    msg: cur === "INR" ? "" : `${cur} ${live} -> INR` });
  await store.saveResult(prod, status, live, cur, state, runId);
  return state;
}

async function runPass(eng, rows, workers, fetcher, runId, onDone) {
  const cfg = eng.config, st = eng.state;
  const safe = st.phase === 'safe_retry';
  const batchSize = Math.max(1, Number(safe ? cfg.safe_batch_size : cfg.batch_size) || rows.length || 1);
  const restSeconds = Math.max(0, Number(safe ? cfg.safe_rest_between : cfg.rest_between) || 0);
  for (let start = 0; start < rows.length && !st.abort; start += batchSize) {
    const limit = pLimit(Math.max(1, workers));
    const batch = rows.slice(start, start + batchSize);
    await Promise.all(batch.map((p) => limit(async () => {
      if (st.abort) return;
      const r = await processOne(eng, fetcher, p, runId);
      onDone(r);
    })));
    if (!st.abort && start + batchSize < rows.length && restSeconds > 0) {
      const label = safe ? 'Safe-retry' : 'Main pass';
      st.message = label + ' - resting ' + restSeconds + 's...';
      const until = Date.now() + restSeconds * 1000;
      while (!st.abort && Date.now() < until) {
        await sleep(Math.min(500, Math.max(0, until - Date.now())));
      }
      st.message = label;
    }
  }
}

export async function startPipeline(eng, runId) {
  const cfg = eng.config, st = eng.state;
  const mode = cfg.fresh_start ? "fresh" : "update";
  const vendors = (cfg.vendors && cfg.vendors.length) ? cfg.vendors : null;
  try {
    // Snapshot the USD-fetch brand set once per run (cheap, cached in store).
    eng.usdFetchBrands = await store.usdFetchBrandSet();
    const source = cfg.data_source === 'imported' ? 'imported' : 'database';
    const rows = await store.workRows(mode, vendors, source);
    const total = source === 'imported'
      ? await store.countImported(vendors)
      : await store.countProducts(vendors);
    Object.assign(st, { total_rows: total, pre_done: Math.max(0, total - rows.length),
      phase: "main", message: `Main pass — ${rows.length} product(s) from ${source}` });
    const fetcher = new Fetcher({ timeout: cfg.timeout_ms });
    await runPass(eng, rows, Math.min(25, Math.max(1, cfg.concurrency)), fetcher, runId, (r) => {
      st.completed++; st[r === "matched" ? "matched" : r === "mismatch" ? "mismatch" : "errors"]++;
    });
    if (!st.abort && cfg.safe_retry) {
      const errKeys = new Set((await store.dbProducts("update", vendors))
        .filter((r) => r.state === "error" && r.base_price != null).map((r) => r.key));
      const err = rows.filter((p) => errKeys.has(p.key));
      st.phase = "safe_retry"; st.retry_total = err.length; st.retry_completed = 0; st.retry_recovered = 0;
      st.message = `Safe-retry — ${err.length} errors, gently`;
      const slow = new Fetcher({ timeout: 15000, cooldown: [
        Number(cfg.safe_cooldown_min) * 1000,
        Number(cfg.safe_cooldown_max) * 1000,
      ] });
      await runPass(eng, err, cfg.safe_concurrency, slow, runId, (r) => {
        st.retry_completed++;
        if (r !== "error") { st.retry_recovered++; st.errors = Math.max(0, st.errors - 1);
          if (r === "matched") st.matched++; else if (r === "mismatch") st.mismatch++; }
      });
    }
    st.phase = "done";
    st.message = (st.abort ? "Aborted" : "Completed") +
      (st.retry_recovered ? ` (${st.retry_recovered} recovered)` : "") + ". Saved to database.";
  } catch (e) {
    st.phase = "done"; st.message = "Error: " + e.message;
  } finally {
    st.running = false;
  }
  // Pipeline has terminated — email a per-brand report if anything needs review
  // (pending mismatches and/or price alerts). Fire-and-forget: the mailer decides
  // whether there's anything to send and never throws. Skipped on a user abort.
  if (!st.abort) {
    sendPipelineReport()
      .then((r) => {
        if (r?.skipped) log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: "nothing to report — no email sent" });
        else if (r?.ok) log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: `report sent to ${r.to} (${r.count} mismatch, ${r.alerts} alert)` });
        else log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: `not sent: ${r?.error || "unknown"}` });
      })
      .catch((e) => log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: "send failed: " + e.message }));
  }
}
