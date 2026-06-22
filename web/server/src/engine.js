// Price scraping engine — faithful port of price_tracker.py.
// Pure-regex extraction (no DOM lib), per-domain pacing, retries, Shopify .js.
import axios from "axios";
import http from "node:http";
import https from "node:https";

export const COOLDOWN_MS = [1200, 2800];
export const SHOPIFY_CENTS_THRESHOLD = 1_000_000;
export const MATCH_TOLERANCE = 1.0;
const CURRENCIES = ["USD", "CAD", "INR"];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

// keep-alive agents (connection pooling)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 24 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 24 });

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; }
}

export class Fetcher {
  constructor({ timeout = 12000, cooldown = COOLDOWN_MS, maxRetries = 3 } = {}) {
    this.timeout = timeout;
    this.cooldown = cooldown;
    this.maxRetries = maxRetries;
    this.firstCall = true;
  }

  static _domainNext = new Map();

  _headers() {
    return {
      "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "X-Forwarded-For": "103.48.196.1",
    };
  }

  async _awaitDomainSlot(url) {
    const domain = new URL(url).host;
    const now = Date.now();
    const next = Fetcher._domainNext.get(domain) || 0;
    const wait = Math.max(0, next - now);
    Fetcher._domainNext.set(domain, Math.max(now, next) + rand(...this.cooldown));
    if (wait > 0) await sleep(wait);
  }

  async _cooldown() {
    if (this.firstCall) { this.firstCall = false; return; }
    await sleep(rand(...this.cooldown));
  }

  async get(url) {
    await this._cooldown();
    let resp = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this._awaitDomainSlot(url);
      try {
        resp = await axios.get(url, {
          timeout: this.timeout, headers: this._headers(), maxRedirects: 5,
          httpAgent, httpsAgent, responseType: "text", transformResponse: (x) => x,
          validateStatus: () => true,
        });
      } catch (err) {
        // connection/timeout: retry a couple of times then surface
        if (attempt >= this.maxRetries) throw err;
        await sleep((2 ** attempt) * 1000 + rand(300, 1200));
        continue;
      }
      const s = resp.status;
      if (s !== 403 && s !== 429 && !(s >= 500 && s < 600)) break;
      if (attempt >= this.maxRetries) break;
      const ra = parseFloat(resp.headers["retry-after"]);
      let backoff = Number.isFinite(ra) ? ra : (2 ** attempt) * 3 + rand(0.5, 2);
      backoff = Math.min(backoff, 45);
      const domain = new URL(url).host;
      Fetcher._domainNext.set(domain, Date.now() + backoff * 1000);
      await sleep(backoff * 1000);
    }
    if (resp.status >= 400) throw new HttpError(resp.status, url);
    return resp;
  }
}

// ---- sanitization & currency ----
export function sanitizePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return raw;
  let text = String(raw);
  text = text.replace(/\b(USD|CAD|INR|Rs\.?|MRP)\b/gi, "");
  text = text.replace(/₹/g, "").replace(/C\$/g, "").replace(/\$/g, "");
  text = text.replace(/[,  ' ]/g, "");
  const m = text.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

export function descaleIfCents(v) {
  return v != null && v > SHOPIFY_CENTS_THRESHOLD ? v / 100 : v;
}

export function detectCurrency(text) {
  if (!text) return null;
  let m = text.match(/(?:og|product):price:currency["'][^>]*content=["']([A-Z]{3})["']|content=["']([A-Z]{3})["'][^>]*(?:og|product):price:currency/);
  if (m) { const c = (m[1] || m[2]).toUpperCase(); if (CURRENCIES.includes(c)) return c; }
  m = text.match(/"(?:priceCurrency|price_currency|currency)"\s*:\s*"([A-Z]{3})"/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  m = text.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Z]{3})["']/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  if (text.includes("₹") || /\bRs\.?\s*\d/i.test(text)) return "INR";
  if (/\bC\$|\bCAD\b/.test(text)) return "CAD";
  if (/\bUSD\b/.test(text) || text.includes("$")) return "USD";
  return null;
}

export function extractPriceFromHtml(html, customRegex = null) {
  if (customRegex) {
    try {
      const m = html.match(new RegExp(customRegex, "s"));
      if (m) return sanitizePrice(m[1] !== undefined ? m[1] : m[0]);
    } catch { /* bad regex */ }
    return null;
  }
  let m = html.match(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*property=["']product:price:amount["']/);
  if (m) return sanitizePrice(m[1] || m[2]);
  m = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*itemprop=["']price["']/);
  if (m) return sanitizePrice(m[1] || m[2]);
  m = html.match(/itemprop=["']price["'][^>]*>([^<]+)</);
  if (m) return sanitizePrice(m[1]);
  m = html.match(/"(?:price|lowPrice)"\s*:\s*"?([0-9][0-9,.]*)"?/);
  if (m) return sanitizePrice(m[1]);
  m = html.match(/woocommerce-Price-amount[^>]*>(?:<bdi>)?\s*(?:<span[^>]*>[^<]*<\/span>)?\s*([0-9][0-9,.]*)/);
  if (m) return sanitizePrice(m[1]);
  return null;
}

function shopifyJsUrl(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, "");
  if (!p.endsWith(".js")) p += ".js";
  return `${u.origin}${p}${u.search}`;
}

const DOMAIN_CURRENCY = new Map();

export async function extractShopify(fetcher, url) {
  const domain = new URL(url).host;
  try {
    const resp = await fetcher.get(shopifyJsUrl(url));
    const data = JSON.parse(resp.data);
    const variants = data.variants || [];
    let raw = variants.length ? variants[0].price : data.price;
    let price;
    if (typeof raw === "number" && Number.isInteger(raw)) price = raw / 100;
    else price = descaleIfCents(sanitizePrice(raw));
    let currency = detectCurrency(resp.data) || DOMAIN_CURRENCY.get(domain) || null;
    if (price != null && !currency) {
      try { currency = detectCurrency((await fetcher.get(url)).data); } catch { /* ignore */ }
    }
    if (price != null) {
      if (currency) DOMAIN_CURRENCY.set(domain, currency);
      return [price, currency];
    }
  } catch { /* blocked / non-JSON / 404 -> HTML fallback */ }
  let html;
  try { html = (await fetcher.get(url)).data; }
  catch (e) {
    const code = e instanceof HttpError ? e.status : "?";
    if (code === 404) throw new Error("product unavailable (removed / 404)");
    throw new Error(`store returned HTTP ${code}`);
  }
  const price = descaleIfCents(extractPriceFromHtml(html));
  const currency = detectCurrency(html) || DOMAIN_CURRENCY.get(domain) || null;
  if (price != null && currency) DOMAIN_CURRENCY.set(domain, currency);
  return [price, currency];
}

export async function extractWordpress(fetcher, url) {
  const html = (await fetcher.get(url)).data;
  return [extractPriceFromHtml(html), detectCurrency(html)];
}

export async function extractCustom(fetcher, url, customRegex) {
  const html = (await fetcher.get(url)).data;
  return [extractPriceFromHtml(html, customRegex), detectCurrency(html)];
}

export async function extractRow(fetcher, url, platform, customRegex) {
  const p = (platform || "").trim().toLowerCase();
  if (p === "shopify") return extractShopify(fetcher, url);
  if (p === "wordpress" || p === "woocommerce") return extractWordpress(fetcher, url);
  if (p === "custom") return extractCustom(fetcher, url, customRegex);
  return extractWordpress(fetcher, url);
}
