// Worker thread — fetches live prices for a chunk of products on its own core.
// Fetch-only by design: no DB pool or FX cache in workers; the main thread
// finalizes (compare + save + log) so per-brand rules and writes stay in one place.
import { workerData, parentPort } from "node:worker_threads";
import pLimit from "p-limit";
import { Fetcher, extractRow } from "./engine.js";

const { rows, fetch: fopts, usdFetch, rangeHigh } = workerData;

const normBrand = (b) => String(b || "").toLowerCase().replace(/^www\./, "").trim();
const usdSet = new Set(usdFetch || []);
const rangeSet = new Set(rangeHigh || []);

let aborted = false;
parentPort.on("message", (m) => { if (m && m.type === "abort") aborted = true; });

const fetcher = new Fetcher({
  timeout: fopts.timeout,
  ...(fopts.cooldown ? { cooldown: fopts.cooldown } : {}),
});
const limit = pLimit(Math.max(1, fopts.concurrency || 1));

await Promise.all(rows.map((prod) => limit(async () => {
  if (aborted) return;
  const brand = normBrand(prod.brand);
  const platformKind = (prod.platform || "").trim().toLowerCase();
  // Same INR pin as pipeline.js processOne — keep the two in sync.
  const fetchCur = usdSet.has(brand) ? "USD" : (platformKind !== "shopify" ? "INR" : null);
  const preferHigh = rangeSet.has(brand);
  try {
    const [live, currency] = await extractRow(
      fetcher, (prod.url || "").trim(),
      (prod.platform || "").trim(),
      prod.custom_regex || null,
      (fetchCur || preferHigh)
        ? { fetchCurrency: fetchCur || undefined, preferHighPrice: preferHigh }
        : undefined
    );
    parentPort.postMessage({ type: "result", prod, live, currency });
  } catch (e) {
    parentPort.postMessage({ type: "result", prod, live: null, currency: null, error: e.message });
  }
})));

parentPort.postMessage({ type: "done" });
process.exit(0);
