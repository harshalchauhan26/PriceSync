import pLimit from "p-limit";
import { Fetcher, extractRow } from "./engine.js";
import { toInr } from "./fx.js";
import { config } from "./config.js";
import * as store from "./store.js";
import { sendPipelineReport } from "./mailer.js";

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";

const engTol = store.matchTol;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOG_MAX = 5000;

const DEFAULTS = { data_source: 'database' };
export function setDefault(key, val) { DEFAULTS[key] = val; }

function newConfig() {
  return {
    concurrency: 16, timeout_ms: 12000, batch_size: 500, rest_between: 2,
    threads: 4, cooldown_min: 0.4, cooldown_max: 1.2,
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

// Compare a fetched price against the baseline, persist and log it.
// Shared by the inline path and the worker-thread path (workers only fetch).
async function finalizeOne(eng, prod, live, currency, errMsg, runId) {
  const url = (prod.url || "").trim();
  const base = prod.base_price, brand = prod.brand;
  const tag = prod.key || url;
  const fetchCur = eng.usdFetchBrands && eng.usdFetchBrands.has(normBrand(brand)) ? "USD" : null;
  const nativeCur = eng.nativeCurrency && eng.nativeCurrency[normBrand(brand)];
  // Force the label for native-currency brands regardless of what extraction
  // detected — geo-dependent stores (Shopify Markets etc.) can mislabel the
  // same untouched number under a different currency depending on the
  // fetcher's IP, and base_price for these brands is already stored in
  // nativeCur, not INR.
  if (nativeCur && live != null) currency = nativeCur;
  if (errMsg != null || live == null) {
    const detail = String(errMsg || "price not found").slice(0, 80);
    log(eng, { row: tag, domain: brand, url, currency: "-", price: "-", status: "Fetch Error", msg: detail });
    // Keep the "Fetch Error" prefix — stateOf() keys off it — but persist the
    // cause so the dashboard can distinguish a block/timeout from a regex miss.
    await store.saveResult(prod, `Fetch Error (${detail})`, null, null, "error", runId);
    return "error";
  }
  const cur = currency || "UNKNOWN";
  if (base == null) {
    log(eng, { row: tag, domain: brand, url, currency: cur, price: String(live), status: "Fetch Error", msg: "baseline unreadable" });
    await store.saveResult(prod, "Fetch Error (baseline unreadable)", live, cur, "error", runId);
    return "error";
  }
  if (fetchCur === "USD" && cur === "USD") {
    const baseUsd = prod.base_usd;
    let state, status, msg;
    if (baseUsd == null) {
      state = "matched"; status = "Price Matched (USD)"; msg = `USD baseline set @ ${live}`;
    } else {
      const delta = live - baseUsd;
      if (Math.abs(delta) <= engTol(baseUsd, "USD")) { state = "matched"; status = "Price Matched (USD)"; }
      else { state = "mismatch"; status = "Price Mismatch! (USD)"; }
      msg = `USD ${live} vs baseline ${baseUsd}`;
    }
    log(eng, { row: tag, domain: brand, url, currency: "USD", price: String(live),
      status: state === "matched" ? "Price Matched" : "Price Mismatch!", msg });
    await store.saveResult(prod, status, live, cur, state, runId, { usdBaseline: true });
    return state;
  }
  if (nativeCur && cur === nativeCur) {
    const delta = live - base;
    let state, status;
    if (Math.abs(delta) <= engTol(base, nativeCur)) { state = "matched"; status = `Price Matched (${nativeCur})`; }
    else { state = "mismatch"; status = `Price Mismatch! (${nativeCur})`; }
    log(eng, { row: tag, domain: brand, url, currency: nativeCur, price: String(live),
      status: state === "matched" ? "Price Matched" : "Price Mismatch!", msg: `${nativeCur} ${live} vs baseline ${base}` });
    await store.saveResult(prod, status, live, cur, state, runId);
    return state;
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

async function processOne(eng, fetcher, prod, runId) {
  const cfg = eng.config;
  const url = (prod.url || "").trim();
  const base = prod.base_price, brand = prod.brand;
  const tag = prod.key || url;
  const platformKind = (prod.platform || "").trim().toLowerCase();
  const isNativeCur = !!(eng.nativeCurrency && eng.nativeCurrency[normBrand(brand)]);
  // Pin non-USD wordpress/custom fetches to INR so geo-detecting currency
  // plugins (wmc) can't serve foreign prices when the server runs abroad.
  // Native-currency brands are exempt — their own currency IS the baseline.
  const fetchCur = isNativeCur ? undefined
    : eng.usdFetchBrands && eng.usdFetchBrands.has(normBrand(brand)) ? "USD"
    : (platformKind !== "shopify" ? "INR" : null);
  const preferHigh = eng.rangeHighBrands ? eng.rangeHighBrands.has(normBrand(brand)) : false;
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
  let errMsg = null;
  live = null; currency = null;
  const nb = normBrand(brand);
  const viaRelay = !!(eng.relay && eng.localOnlyBrands && eng.localOnlyBrands.has(nb));
  const f = viaRelay
    ? fetcher.relayed(eng.relay.url, eng.relay.secret)
    : (eng.proxyBrands && eng.proxyBrands.has(nb))
      ? fetcher.proxied(config.fetchProxyUrl)
      : fetcher;
  try {
    [live, currency] = await extractRow(f, url, (prod.platform || "").trim(),
      prod.custom_regex || null, {
        fetchCurrency: fetchCur || undefined,
        preferHighPrice: preferHigh || undefined,
        // appendParams (e.g. anitadongre's switch=true geo-redirect suppressor)
        // applies on every fetch path, not just via the relay -- a direct/local
        // fetch can hit the same geo-redirect a foreign relay IP does.
        appendParams: (eng.relayParams && eng.relayParams[nb]) || undefined,
        ...(viaRelay ? { wooApi: (eng.wooApiBrands && eng.wooApiBrands.has(nb)) || undefined } : {}),
      });
  } catch (e) { errMsg = e.message; }
  return finalizeOne(eng, prod, live, currency, errMsg, runId);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, "./worker.js");

// Deal rows round-robin across N chunks so products from one hot domain are
// spread over every worker — each worker paces domains independently, so a
// single-store run gets N× the per-domain throughput of contiguous chunks.
// EXCEPT gentle brands (bot-protected, e.g. Akamai): all their rows stay on
// ONE worker so the per-domain cooldown is truthful process-wide — the N×
// rate is exactly what gets the server's IP rate-banned on those domains.
function chunkArray(arr, n, gentleSet = null) {
  const chunks = Array.from({ length: n }, () => []);
  const gentleChunk = new Map();
  let i = 0;
  for (const item of arr) {
    const b = normBrand(item.brand);
    if (gentleSet && gentleSet.has(b)) {
      if (!gentleChunk.has(b)) gentleChunk.set(b, gentleChunk.size % n);
      chunks[gentleChunk.get(b)].push(item);
    } else {
      chunks[i++ % n].push(item);
    }
  }
  return chunks.filter((c) => c.length);
}

// Run one chunk in a worker thread. The worker only fetches; each result is
// finalized (compared/saved/logged) here on the main thread as it streams in.
function runWorker(eng, rows, fetchOpts, runId, onDone) {
  const st = eng.state;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        rows, fetch: fetchOpts,
        usdFetch: [...(eng.usdFetchBrands || [])],
        rangeHigh: [...(eng.rangeHighBrands || [])],
        proxyBrands: [...(eng.proxyBrands || [])],
        proxyUrl: config.fetchProxyUrl || null,
        localOnly: [...(eng.localOnlyBrands || [])],
        relay: eng.relay || null,
        wooApi: [...(eng.wooApiBrands || [])],
        relayParams: eng.relayParams || {},
        nativeCurrency: eng.nativeCurrency || {},
      },
    });
    let chain = Promise.resolve();
    let chainError = null;
    let abortSent = false;
    const abortWatch = setInterval(() => {
      if (st.abort && !abortSent) {
        abortSent = true;
        try { worker.postMessage({ type: "abort" }); } catch {}
      }
    }, 300);
    worker.on("message", (msg) => {
      if (!msg || msg.type !== "result") return;
      chain = chain.then(async () => {
        const state = await finalizeOne(eng, msg.prod, msg.live, msg.currency, msg.error ?? null, runId);
        onDone(state);
      }).catch((e) => { chainError = chainError || e; });
    });
    worker.on("error", (e) => { chainError = chainError || e; });
    worker.on("exit", (code) => {
      clearInterval(abortWatch);
      chain.then(() => {
        if (chainError) return reject(chainError);
        if (code !== 0 && !st.abort) return reject(new Error(`worker exited with code ${code}`));
        resolve();
      });
    });
  });
}


async function runPass(eng, rows, workers, fetcher, runId, onDone) {
  const cfg = eng.config, st = eng.state;
  const safe = st.phase === "safe_retry";
  const batchSize = Math.max(1, Number(safe ? cfg.safe_batch_size : cfg.batch_size) || rows.length || 1);
  const restSeconds = Math.max(0, Number(safe ? cfg.safe_rest_between : cfg.rest_between) || 0);

  // Use worker threads if more than 1 thread configured (new behaviour).
  // Safe-retry stays on the inline path so its gentle pacing is preserved.
  const numThreads = Math.min(4, Math.max(1, cfg.threads || 1)); // max 4 threads
  const useThreads = numThreads > 1 && !cfg.simulation && !safe;

  for (let start = 0; start < rows.length && !st.abort; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);

    if (useThreads) {
      // Split batch across worker threads; each worker gets its share of the
      // concurrency budget and the current fetcher's timeout/cooldown profile.
      const chunks = chunkArray(batch, numThreads, eng.gentleBrands);
      const fetchOpts = {
        timeout: fetcher.timeout, cooldown: fetcher.cooldown,
        concurrency: Math.max(1, Math.ceil(workers / chunks.length)),
      };
      await Promise.all(chunks.map((chunk) => runWorker(eng, chunk, fetchOpts, runId, onDone)));
    } else {
      // Original pLimit path (single-threaded async, unchanged)
      const limit = pLimit(Math.max(1, workers));
      await Promise.all(batch.map((p) => limit(async () => {
        if (st.abort) return;
        const r = await processOne(eng, fetcher, p, runId);
        onDone(r);
      })));
    }

    if (!st.abort && start + batchSize < rows.length && restSeconds > 0) {
      const label = safe ? "Safe-retry" : "Main pass";
      st.message = label + " - resting " + restSeconds + "s...";
      const until = Date.now() + restSeconds * 1000;
      while (!st.abort && Date.now() < until) {
        await sleep(Math.min(500, Math.max(0, until - Date.now())));
      }
      st.message = label;
    }
  }
}

// Ad-hoc single-row rerun for the Review page's "Rerun" button — reuses
// processOne/finalizeOne so a manual rerun applies the exact same per-brand
// rules (native currency, USD-fetch pin, relay/proxy, woo API) as a real
// pipeline run, just for one product outside of a full run.
export async function rerunOne(prod) {
  const eng = { config: { simulation: false }, state: {}, log: [], logmeta: { offset: 0 } };
  eng.usdFetchBrands = await store.usdFetchBrandSet();
  eng.rangeHighBrands = await store.rangeHighBrandSet();
  eng.proxyBrands = await store.proxyBrandSet();
  eng.localOnlyBrands = await store.localOnlyBrandSet();
  eng.relay = (config.isCloud && config.fetchRelayUrl)
    ? { url: config.fetchRelayUrl, secret: config.fetchRelaySecret } : null;
  eng.wooApiBrands = await store.wooApiBrandSet();
  eng.relayParams = await store.relayAppendParams();
  eng.nativeCurrency = await store.nativeCurrencyBrands();
  const fetcher = new Fetcher({ cooldown: [600, 1500] });
  const runId = "rerun-" + Date.now().toString(36);
  await processOne(eng, fetcher, prod, runId);
  return store.productByKey(prod.key);
}

export async function startPipeline(eng, runId) {
  const cfg = eng.config, st = eng.state;
  const mode = cfg.fresh_start ? "fresh" : "update";
  const vendors = (cfg.vendors && cfg.vendors.length) ? cfg.vendors : null;
  try {
    eng.usdFetchBrands = await store.usdFetchBrandSet();
    eng.rangeHighBrands = await store.rangeHighBrandSet();
    eng.gentleBrands = await store.gentleBrandSet();
    eng.proxyBrands = await store.proxyBrandSet();
    if (eng.proxyBrands.size && !config.fetchProxyUrl) {
      log(eng, { row: "—", domain: "proxy", url: "", currency: "-", price: "-", status: "Warning",
        msg: `${eng.proxyBrands.size} brand(s) flagged for proxy but FETCH_PROXY_URL is not set — fetching directly` });
    }
    const source = cfg.data_source === 'imported' ? 'imported' : 'database';
    let rows = await store.workRows(mode, vendors, source);
    let total = source === 'imported'
      ? await store.countImported(vendors)
      : await store.countProducts(vendors);
    // Local-only brands: their sites ban the cloud server's IP. With a fetch
    // relay configured (FETCH_RELAY_URL -> web/relay/worker.js) cloud runs
    // fetch them through it; without one they are skipped entirely (a blocked
    // fetch would only clobber good local data with errors) and must be
    // refreshed from a local run — run-local-only.mjs.
    eng.localOnlyBrands = await store.localOnlyBrandSet();
    eng.relay = (config.isCloud && config.fetchRelayUrl)
      ? { url: config.fetchRelayUrl, secret: config.fetchRelaySecret }
      : null;
    eng.wooApiBrands = await store.wooApiBrandSet();
    eng.relayParams = await store.relayAppendParams();
    eng.nativeCurrency = await store.nativeCurrencyBrands();
    if (config.isCloud && eng.localOnlyBrands.size && !eng.relay) {
      const before = rows.length;
      rows = rows.filter((r) => !eng.localOnlyBrands.has(normBrand(r.brand)));
      const skipped = before - rows.length;
      total -= skipped;
      if (skipped) log(eng, { row: "—", domain: "local-only", url: "", currency: "-", price: "-",
        status: "Skipped", msg: `${skipped} row(s) of ${eng.localOnlyBrands.size} local-only brand(s) — set FETCH_RELAY_URL or refresh from the local machine` });
    }
    Object.assign(st, { total_rows: total, pre_done: Math.max(0, total - rows.length),
      phase: "main", message: `Main pass — ${rows.length} product(s) from ${source}` });
    const sec = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n * 1000 : d; };
    const cdMin = sec(cfg.cooldown_min, 400);
    const cdMax = Math.max(cdMin, sec(cfg.cooldown_max, 1200));
    const fetcher = new Fetcher({ timeout: cfg.timeout_ms, cooldown: [cdMin, cdMax] });
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
  if (!st.abort) {
    const stats = { completed: st.completed, matched: st.matched, mismatch: st.mismatch,
      errors: st.errors, recovered: st.retry_recovered,
      elapsed: st.started_at ? Math.floor((Date.now() - st.started_at) / 1000) : null };
    sendPipelineReport({ stats })
      .then((r) => {
        if (r?.ok) log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: `report sent to ${r.to} (${r.count} mismatch, ${r.errors} error, ${r.alerts} alert)` });
        else log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: `not sent: ${r?.error || "unknown"}` });
      })
      .catch((e) => log(eng, { row: "—", domain: "email", url: "", currency: "-", price: "-", status: "Email", msg: "send failed: " + e.message }));
  }
}
