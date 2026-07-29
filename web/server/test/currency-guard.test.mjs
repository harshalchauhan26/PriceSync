// requestedCurrency() — the single source of truth for "what currency did this
// fetch ask for", shared by pipeline.js processOne, worker.js and the guard in
// finalizeOne. It previously existed as three copies and the finalizeOne one was
// missing the INR pin, which is what let a GBP price be compared to an INR
// baseline for 159 rows.
process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@localhost:5432/db";

import { test } from "node:test";
import assert from "node:assert/strict";
const { requestedCurrency } = await import("../src/engine.js");

test("a USD-flagged brand requests USD", () => {
  assert.equal(requestedCurrency({ isUsdBrand: true, platform: "wordpress" }), "USD");
  assert.equal(requestedCurrency({ isUsdBrand: true, platform: "shopify" }), "USD");
});

test("any non-shopify brand is pinned to INR — this is the saakshakinni case", () => {
  assert.equal(requestedCurrency({ platform: "wordpress" }), "INR");
  assert.equal(requestedCurrency({ platform: "custom" }), "INR");
  assert.equal(requestedCurrency({ platform: "" }), "INR");
});

test("shopify requests nothing — it isn't currency-parameterised", () => {
  assert.equal(requestedCurrency({ platform: "shopify" }), null);
  assert.equal(requestedCurrency({ platform: "Shopify" }), null);
});

test("a native-currency brand requests nothing, outranking the USD flag", () => {
  // Its own currency IS the baseline, and finalizeOne forces the label, so the
  // guard must not fire for these.
  assert.equal(requestedCurrency({ isNativeCurrency: true, platform: "wordpress" }), null);
  assert.equal(requestedCurrency({ isNativeCurrency: true, isUsdBrand: true, platform: "shopify" }), null);
});

// The guard's decision, mirroring finalizeOne's condition. Kept as a pure check
// so the rule is pinned without standing up an engine, DB and live fetch.
const rejects = (wantCur, cur, strict = true) =>
  !!(strict && wantCur && cur !== "UNKNOWN" && cur !== wantCur);

test("the guard rejects exactly the wrong-currency case that went unnoticed", () => {
  // saakshakinni: INR asked for, the site's geo logic served GBP.
  assert.equal(rejects("INR", "GBP"), true);
  assert.equal(rejects("USD", "GBP"), true);
  assert.equal(rejects("INR", "USD"), true);
});

test("the guard passes a matching currency", () => {
  assert.equal(rejects("INR", "INR"), false);
  assert.equal(rejects("USD", "USD"), false);
});

test("UNKNOWN is allowed through — undetectable is not the same as wrong", () => {
  // Rejecting it would strand every page with no currency marker at all.
  assert.equal(rejects("INR", "UNKNOWN"), false);
  assert.equal(rejects("USD", "UNKNOWN"), false);
});

test("no requested currency means no guard — shopify and native brands are exempt", () => {
  assert.equal(rejects(null, "GBP"), false);
  assert.equal(rejects(undefined, "EUR"), false);
});

test("STRICT_FETCH_CURRENCY=0 restores convert-and-compare", () => {
  assert.equal(rejects("INR", "GBP", false), false);
});
