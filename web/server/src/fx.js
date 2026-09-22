import axios from "axios";

const TTL = 6 * 3600 * 1000;
// Live market rates are genuinely global (not tenant data) — one shared
// cache, refreshed at most every TTL regardless of how many tenants ask.
let cache = { at: 0, rates: {} };
const FALLBACK = { INR: 1, USD: 83, CAD: 61, EUR: 90, GBP: 105, AUD: 55, AED: 22.6 };

// Per-tenant manual FX overrides (fx_override_usd/fx_override_cad in that
// tenant's meta table) — these must never leak across tenants, so they're
// kept in a Map keyed by mboId instead of a single module-level object.
const overrides = new Map();
export function setOverrides(mboId, o = {}) {
  const next = {};
  for (const [k, v] of Object.entries(o)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) next[String(k).toUpperCase()] = n;
  }
  overrides.set(mboId, next);
}
export function getOverrides(mboId) { return { ...(overrides.get(mboId) || {}) }; }

async function fetchRates() {
  const r = await axios.get("https://open.er-api.com/v6/latest/INR", { timeout: 10000 });
  const rates = (r.data && r.data.rates) || {};
  const out = {};
  for (const [c, v] of Object.entries(rates)) if (v) out[c] = 1 / v;
  out.INR = 1;
  if (!out.USD) throw new Error("FX payload missing USD");
  return out;
}

// marketOnly=true skips the tenant's manual Save-Rates override and returns
// the live/fallback market rate only. The override exists for ONE purpose --
// pricing what gets pushed to Shopify (final price = markup over the
// converted baseline) -- and must never leak into mismatch DETECTION.
// Before this flag existed, editing the override rate silently rewrote every
// usd_convert_brand's base_usd on the next pipeline run (via refreshUsdBaselines),
// flipping thousands of rows between matched/mismatch with no real price change
// behind it. Comparison call sites (finalizeOne, refreshUsdBaselines, saveResult's
// own delta recompute) pass true; push/preview call sites (computeFinal, the
// Review page's live preview, promoteLiveToBase/update_base baseline-reset
// actions) omit it and keep using the override, same as before.
export async function rates(mboId, marketOnly = false) {
  if (Date.now() - cache.at > TTL || !Object.keys(cache.rates).length) {
    try { cache = { at: Date.now(), rates: await fetchRates() }; }
    catch { if (!Object.keys(cache.rates).length) cache = { at: Date.now(), rates: { ...FALLBACK } }; }
  }
  return marketOnly ? { ...cache.rates } : { ...cache.rates, ...(overrides.get(mboId) || {}) };
}

export async function rateOf(mboId, cur, marketOnly = false) {
  const c = (cur || "INR").trim().toUpperCase();
  return (await rates(mboId, marketOnly))[c] || FALLBACK[c] || 1;
}

export async function toInr(mboId, amount, cur, marketOnly = false) {
  if (amount == null) return null;
  const c = (cur || "INR").trim().toUpperCase();
  if (["INR", "", "UNKNOWN", "RS", "₹"].includes(c)) return Math.round(amount * 100) / 100;
  return Math.round(amount * (await rateOf(mboId, c, marketOnly)) * 100) / 100;
}

// Pivots any amount+currency through INR to USD — reuses toInr's passthrough
// for INR/unknown-as-INR and rateOf's same cache/fallback/overrides, so this
// stays consistent with every other currency figure the app shows.
export async function toUsd(mboId, amount, cur, marketOnly = false) {
  if (amount == null) return null;
  const inr = await toInr(mboId, amount, cur, marketOnly);
  if (inr == null) return null;
  return Math.round((inr / (await rateOf(mboId, "USD", marketOnly))) * 100) / 100;
}

// Converts at a specific caller-supplied rate instead of any stored one --
// for a brand's own derived rate (brandRate.js: median of 5 sampled products'
// real INR price vs. that brand's own storefront-displayed USD price), so
// the Live/Final $ figures match what the brand's own site shows, not
// whatever a generic INR/USD source happens to quote that day.
export async function toUsdAtRate(mboId, amount, cur, rate) {
  if (amount == null || !rate) return null;
  const inr = await toInr(mboId, amount, cur, true);
  if (inr == null) return null;
  return Math.round((inr / rate) * 100) / 100;
}

// EUR/GBP included because Review's per-row override currency select offers
// them — without a real rate the client previews those amounts at rate 1.
export async function snapshot(mboId, curs = ["USD", "CAD", "EUR", "GBP", "INR"]) {
  const rr = await rates(mboId);
  const out = {};
  for (const c of curs) out[c] = Math.round((rr[c] || FALLBACK[c] || 1) * 10000) / 10000;
  return out;
}
