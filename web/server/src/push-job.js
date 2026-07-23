import { withTenant } from "./db.js";
import { pushRowPrice } from "./price-update.js";
import { clearBuckets, promoteLiveToBase } from "./store.js";

// Batched Shopify push with live progress. One job at a time PER TENANT
// (jobs carry mbo_id so one tenant's bulk push can never block or leak
// progress into another tenant's). Batches of 10 run in order, items inside
// a batch run concurrently. Pushes go over the GraphQL Admin API (2 calls
// per product, cost-aware throttle retry in shopify.js's gql()).
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 5;
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

// Tenant-scoped: a job belonging to a different mbo_id is invisible here —
// one tenant can never poll or observe another tenant's push progress/URLs.
export function getPushJob(mboId, id) {
  if (id) {
    const j = jobs.get(id);
    return j && j.mbo_id === mboId ? publicJob(j) : null;
  }
  let latest = null;
  for (const j of jobs.values()) if (j.mbo_id === mboId) latest = j;
  return publicJob(latest);
}

export function runningPushJob(mboId) {
  for (const j of jobs.values()) if (j.mbo_id === mboId && j.state === "running") return publicJob(j);
  return null;
}

// rows: review_history rows (id, key, brand, url, mbo_url, final_price).
export function startPushJob(mboId, rows, label) {
  const running = runningPushJob(mboId);
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
    id: `push-${Date.now().toString(36)}-${++seq}`, label, mbo_id: mboId,
    state: rows.length ? "running" : "done", error: null,
    total: rows.length, done: 0, ok: 0, fail: 0,
    started_at: new Date().toISOString(),
    finished_at: rows.length ? null : new Date().toISOString(),
    batches,
  };
  jobs.set(job.id, job);
  pruneOldJobs(mboId, job.id);
  if (rows.length) runJob(mboId, job).catch((e) => {
    job.error = e.message; job.state = "done"; job.finished_at = new Date().toISOString();
    console.error("[MBO] push job", job.id, "crashed:", e);
  });
  return { ok: true, job: publicJob(job) };
}

// Keeps at most KEEP_JOBS per tenant (not globally) — otherwise one very
// active tenant could evict another tenant's recent job history.
function pruneOldJobs(mboId, keepId) {
  const tenantJobIds = [...jobs.entries()].filter(([, j]) => j.mbo_id === mboId).map(([id]) => id);
  while (tenantJobIds.length > KEEP_JOBS) {
    const oldest = tenantJobIds.shift();
    if (oldest === keepId) continue;
    jobs.delete(oldest);
  }
}

async function pushOne(mboId, job, batch, item) {
  item.status = "pushing";
  let result;
  try {
    result = await pushRowPrice(mboId, item._row, item.price, { queued: false });
  } catch (e) {
    result = { ok: false, status: "push error: " + e.message };
  }
  item.status = result.ok ? "ok" : "failed";
  item.message = result.status || "";
  if (result.ok) { job.ok++; batch.ok++; } else { job.fail++; batch.fail++; }
  job.done++;
  const at = new Date().toISOString();
  try {
    await withTenant(mboId, async (db) => {
      await Promise.all([
        db.client.query("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE mbo_id=$3 AND id=$4",
          [result.status, at, mboId, item.id]),
        item.key ? db.client.query("UPDATE products SET shopify_status=$1,shopify_at=$2 WHERE mbo_id=$3 AND key=$4",
          [result.status, at, mboId, item.key]) : null,
      ]);
      if (result.ok && item.key) {
        const run = (sql, params) => db.client.query(sql, params).then((r) => r.rows);
        await promoteLiveToBase(mboId, run, item._row);
        await clearBuckets(mboId, run, item.key);
      }
    });
  } catch (e) { console.error("[MBO] push job status write:", e.message); }
}

async function runJob(mboId, job) {
  for (const batch of job.batches) {
    batch.status = "running";
    const queue = [...batch.items];
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) },
      async () => { for (let item = queue.shift(); item; item = queue.shift()) await pushOne(mboId, job, batch, item); }));
    batch.status = "done";
  }
  job.state = "done";
  job.finished_at = new Date().toISOString();
}

// Review page's combined "Push and update price": rows are raw `products`
// rows (not yet archived). archiveFn(row) does the archive-to-History step
// (approveOne, in its own transaction) and returns {final, archived} — then
// this pushes the freshly-archived row, same batching/progress shape as
// startPushJob so the client can reuse the exact same progress panel.
export function startReviewPushJob(mboId, rows, archiveFn, label) {
  const running = runningPushJob(mboId);
  if (running) return { ok: false, error: "a Shopify push is already running", job: running };
  const batches = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push({
      n: batches.length + 1, status: "waiting", ok: 0, fail: 0,
      items: rows.slice(i, i + BATCH_SIZE).map((r) => ({
        _row: r, id: r.id, key: r.key, brand: r.brand,
        url: r.mbo_url || r.url, price: null,
        status: "waiting", message: "",
      })),
    });
  }
  const job = {
    id: `rpush-${Date.now().toString(36)}-${++seq}`, label, mbo_id: mboId,
    state: rows.length ? "running" : "done", error: null,
    total: rows.length, done: 0, ok: 0, fail: 0,
    started_at: new Date().toISOString(),
    finished_at: rows.length ? null : new Date().toISOString(),
    batches,
  };
  jobs.set(job.id, job);
  pruneOldJobs(mboId, job.id);
  if (rows.length) runReviewJob(mboId, job, archiveFn).catch((e) => {
    job.error = e.message; job.state = "done"; job.finished_at = new Date().toISOString();
    console.error("[MBO] review-push job", job.id, "crashed:", e);
  });
  return { ok: true, job: publicJob(job) };
}

async function pushWithArchive(mboId, job, batch, item, archiveFn) {
  item.status = "pushing";
  let result, archived;
  try {
    const arch = await archiveFn(item._row);
    archived = arch.archived;
    item.price = arch.final;
    result = await pushRowPrice(mboId, archived, arch.final);
  } catch (e) {
    result = { ok: false, status: "error: " + e.message };
  }
  item.status = result.ok ? "ok" : "failed";
  item.message = result.status || "";
  if (result.ok) { job.ok++; batch.ok++; } else { job.fail++; batch.fail++; }
  job.done++;
  const at = new Date().toISOString();
  try {
    await withTenant(mboId, async (db) => {
      await Promise.all([
        archived ? db.client.query("UPDATE review_history SET shopify_status=$1,shopify_at=$2 WHERE mbo_id=$3 AND id=$4",
          [result.status, at, mboId, archived.id]) : null,
        item.key ? db.client.query("UPDATE products SET shopify_status=$1,shopify_at=$2 WHERE mbo_id=$3 AND key=$4",
          [result.status, at, mboId, item.key]) : null,
      ]);
      if (result.ok && item.key) {
        const run = (sql, params) => db.client.query(sql, params).then((r) => r.rows);
        await promoteLiveToBase(mboId, run, item._row);
        await clearBuckets(mboId, run, item.key);
      }
    });
  } catch (e) { console.error("[MBO] review push job status write:", e.message); }
}

async function runReviewJob(mboId, job, archiveFn) {
  for (const batch of job.batches) {
    batch.status = "running";
    const queue = [...batch.items];
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) },
      async () => { for (let item = queue.shift(); item; item = queue.shift()) await pushWithArchive(mboId, job, batch, item, archiveFn); }));
    batch.status = "done";
  }
  job.state = "done";
  job.finished_at = new Date().toISOString();
}
