// Worker thread — runs a batch of products independently on its own CPU core.
import { workerData, parentPort } from "node:worker_threads";
import { Fetcher, extractRow } from "./engine.js";
import { toInr } from "./fx.js";
import * as store from "./store.js";

const { rows, config, runId } = workerData;
const engTol = store.matchTol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function processOne(fetcher, prod) {
  const url = (prod.url || "").trim();
  const base = prod.base_price;
  const tag = prod.key || url;
  try {
    const [live, currency] = await extractRow(
      fetcher, url,
      (prod.platform || "").trim(),
      prod.custom_regex || null
    );
    if (live == null) throw new Error("price not found");
    const cur = currency || "UNKNOWN";
    if (base == null) {
      await store.saveResult(prod, "Fetch Error", live, cur, "error", runId);
      return { tag, status: "Fetch Error", state: "error" };
    }
    const liveInr = await toInr(live, cur);
    const delta = liveInr - base;
    const state = Math.abs(delta) <= engTol(base, cur) ? "matched" : "mismatch";
    const status = state === "matched"
      ? `Price Matched (${cur})` : `Price Mismatch! (${cur})`;
    await store.saveResult(prod, status, live, cur, state, runId);
    return { tag, brand: prod.brand, url, currency: cur,
      price: liveInr.toFixed(2), status: state === "matched" ? "Price Matched" : "Price Mismatch!", state };
  } catch (e) {
    await store.saveResult(prod, "Fetch Error", null, null, "error", runId);
    return { tag, brand: prod.brand, url, status: "Fetch Error", state: "error", msg: e.message };
  }
}

// Run the batch
const fetcher = new Fetcher({ timeout: config.timeout_ms });
const results = [];
for (const prod of rows) {
  const r = await processOne(fetcher, prod);
  results.push(r);
  parentPort.postMessage({ type: "progress", result: r }); // stream progress back
}
parentPort.postMessage({ type: "done", results });