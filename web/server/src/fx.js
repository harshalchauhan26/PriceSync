import axios from "axios";

const TTL = 6 * 3600 * 1000;
let cache = { at: 0, rates: {} };
const FALLBACK = { INR: 1, USD: 83, CAD: 61, EUR: 90, GBP: 105, AUD: 55, AED: 22.6 };

let overrides = {};
export function setOverrides(o = {}) {
  const next = {};
  for (const [k, v] of Object.entries(o)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) next[String(k).toUpperCase()] = n;
  }
  overrides = next;
}
export function getOverrides() { return { ...overrides }; }

async function fetchRates() {
  const r = await axios.get("https://open.er-api.com/v6/latest/INR", { timeout: 10000 });
  const rates = (r.data && r.data.rates) || {};
  const out = {};
  for (const [c, v] of Object.entries(rates)) if (v) out[c] = 1 / v;
  out.INR = 1;
  if (!out.USD) throw new Error("FX payload missing USD");
  return out;
}

export async function rates() {
  if (Date.now() - cache.at > TTL || !Object.keys(cache.rates).length) {
    try { cache = { at: Date.now(), rates: await fetchRates() }; }
    catch { if (!Object.keys(cache.rates).length) cache = { at: Date.now(), rates: { ...FALLBACK } }; }
  }
  return { ...cache.rates, ...overrides };
}

export async function rateOf(cur) {
  const c = (cur || "INR").trim().toUpperCase();
  return (await rates())[c] || FALLBACK[c] || 1;
}

export async function toInr(amount, cur) {
  if (amount == null) return null;
  const c = (cur || "INR").trim().toUpperCase();
  if (["INR", "", "UNKNOWN", "RS", "₹"].includes(c)) return Math.round(amount * 100) / 100;
  return Math.round(amount * (await rateOf(c)) * 100) / 100;
}

// EUR/GBP included because Review's per-row override currency select offers
// them — without a real rate the client previews those amounts at rate 1.
export async function snapshot(curs = ["USD", "CAD", "EUR", "GBP", "INR"]) {
  const rr = await rates();
  const out = {};
  for (const c of curs) out[c] = Math.round((rr[c] || FALLBACK[c] || 1) * 10000) / 10000;
  return out;
}
