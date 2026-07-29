// Who receives a pipeline report. Pure — no DB, no network, no send.
// config.js requires a DB URL at import time; nothing here queries it.
process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@localhost:5432/db";
// ALERT_TO is the FALLBACK recipient in every case below.
process.env.ALERT_TO = "owner@example.com";

import { test } from "node:test";
import assert from "node:assert/strict";
const { recipients } = await import("../src/mailer.js");

test("a report goes to the run's initiator ONLY — ALERT_TO is not cc'd", () => {
  const r = recipients("operator@gmail.com");
  assert.deepEqual(r.list, ["operator@gmail.com"]);
  assert.equal(r.usedFallback, false);
  // The whole point: a per-day send quota is not spent on a second copy.
  assert.equal(r.list.includes("owner@example.com"), false);
});

test("an undeliverable initiator falls back to ALERT_TO instead of losing the mail", () => {
  // .local answers 250 OK on Gmail's SMTP and then blackholes the message, so
  // it must never be treated as a real recipient.
  const r = recipients("admin@pricesync.local");
  assert.deepEqual(r.list, ["owner@example.com"]);
  assert.equal(r.usedFallback, true);
  // The dropped initiator is still reported, so the run log can show it.
  assert.deepEqual(r.dropped, ["admin@pricesync.local"]);
});

test("no initiator at all (engine built outside the API) falls back to ALERT_TO", () => {
  for (const empty of [undefined, "", "   "]) {
    const r = recipients(empty);
    assert.deepEqual(r.list, ["owner@example.com"]);
    assert.equal(r.usedFallback, true);
  }
});

test("multiple initiator addresses are deduped and case-normalised, still no ALERT_TO", () => {
  const r = recipients("A@Gmail.com, a@gmail.com; b@gmail.com");
  assert.deepEqual(r.list, ["a@gmail.com", "b@gmail.com"]);
  assert.equal(r.usedFallback, false);
});

test("a deliverable initiator alongside a junk one keeps the good address and drops the junk", () => {
  const r = recipients("real@gmail.com, admin@pricesync.local, not-an-email");
  assert.deepEqual(r.list, ["real@gmail.com"]);
  assert.equal(r.usedFallback, false);
  assert.deepEqual(r.dropped, ["admin@pricesync.local", "not-an-email"]);
});
