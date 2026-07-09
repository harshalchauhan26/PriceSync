import { q } from "./db.js";
import { pushRowPrice } from "./price-update.js";

// Batched Shopify push with live progress. One job at a time; batches of 10
// run in order, items inside a batch run with small concurrency (safe under
// Shopify's 2 req/s + burst-40 REST limit given shopReq's 429 backoff).
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 3;
const KEEP_JOBS = 5;

const jobs = new Map(); // insertion-ordered: oldest first
let seq = 0;

const publicItem = (it) => ({
  id: it.id, brand: it.brand, url: it.url, price: it.price,
  status: it.status, message: it.message,
});
function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id, label: job.label, state: job.state, error: job.error,
    total: job.total, done: job.done, ok: job.ok, fail: job.fail,
    batch_size: BATCH_SIZE, started_at: job.started_at, finished_at: job.finished_at,
    batches: job.batches.map((b) => ({
      n: b.n, status: b.status, ok: b.ok, fail: b.fail, items: b.items.map(publicItem),
    })),
  };
}

export function getPushJob(id) {
  if (id) return publicJob(jobs.get(id));
  let latest = null;
  for (const j of jobs.values()) latest = j;
  return publicJob(latest);
}

export function runningPushJob() {
  for (const j of jobs.values()) if (j.state === "running") return publicJob(j);
  return null;
}

// rows: review_history rows (id, key, brand, url, mbo_url, final_price).
export function startPushJob(rows, label) {
  const running = runningPushJob();
  if (running) return { ok: false, error: "a Shopify push is already running", job: running };
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push({
      n: batches.length + 1, status: "waiting", ok: 0, fail: 0,
      items: rows.slice(i, i + BATCH_SIZE).map((r) => ({
        _row: r, id: r.id, key: r.key, brand: r.brand,
        url: r.mbo_url || r.url, price: r.final_price,
        status: "waiting", message: "",
      })),
    });
  }
  const job = {
    id: `push-${Date.now().toString(36)}-${++seq}`, label,
    state: rows.length ? "running" : "done", error: null,
    total: rows.length, done: 0, ok: 0, fail: 0,
    started_at: new Date().toISOString(),
    finished_at: rows.length ? null : new Date().toISOString(),
    batches,
  };
  jobs.set(job.id, job);
  for (const key of jobs.keys()) {
    if (jobs.size <= KEEP_JOBS || key === job.id) break;
    jobs.delete(key);
  }
  if (rows.length) runJob(job).catch((e) => {
    job.error = e.message; job.state = "done"; job.finished_at = new Date().toISOString();
    console.error("[MBO] push job", job.id, "crashed:", e);
  });
  return { ok: true, job: publicJob(job) };
}

async function pushOne(job, batch, item) {
  item.status = "pushing";
  let result;
  try {
    result = await pushRowPrice(item._row, item.price, { queued: false });
  } catch (e) {
    result = { ok: false, status: "push error: " + e.message };
  }
  item.status = result.ok ? "ok" : "failed";
  item.message = result.status || "";
  if (result.ok) { job.ok++; batch.ok++; } else { job.fail++; batch.fail++; }
  job.done++;
  const at = new Date().toISOString();
  try {
    await q("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE id=$3",
      [result.status, at, item.id]);
    if (item.key) await q("UPDATE products SET shopify_status=$1,shopify_at=$2 WHERE key=$3",
      [result.status, at, item.key]);
  } catch (e) { console.error("[MBO] push job status write:", e.message); }
}

async function runJob(job) {
  for (const batch of job.batches) {
    batch.status = "running";
    const queue = [...batch.items];
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) },
      async () => { for (let item = queue.shift(); item; item = queue.shift()) await pushOne(job, batch, item); }));
    batch.status = "done";
  }
  job.state = "done";
  job.finished_at = new Date().toISOString();
}
