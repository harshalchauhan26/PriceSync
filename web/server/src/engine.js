import axios from "axios";
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

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

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 24 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 24 });

export class HttpError extends Error {
  constructor(status, url) { super(`HTTP ${status}`); this.status = status; this.url = url; }
}

export class Fetcher {
  constructor({ timeout = 12000, cooldown = COOLDOWN_MS, maxRetries = 3, proxyUrl = null,
    relayUrl = null, relaySecret = null } = {}) {
    this.timeout = timeout;
    this.cooldown = cooldown;
    this.maxRetries = maxRetries;
    this.firstCall = true;
    this.proxyUrl = proxyUrl || null;
    // One tunnel agent per Fetcher; axios `proxy: false` stops env-var proxy
    // detection from double-proxying the request.
    this.proxyAgent = this.proxyUrl ? new HttpsProxyAgent(this.proxyUrl) : null;
    // Relay = HTTPS fetch-relay endpoint (web/relay/worker.js contract:
    // GET <relayUrl>?url=<target>, Bearer auth, origin body/status passthrough).
    this.relayUrl = relayUrl || null;
    this.relaySecret = relaySecret || null;
  }

  // Twin that sends requests through the fetch relay. Pacing/backoff stay
  // keyed on the TARGET domain (shared static _domainNext), so relayed and
  // direct fetchers honor one per-domain schedule.
  relayed(relayUrl, relaySecret) {
    if (!relayUrl) return this;
    if (!this._relayedTwin || this._relayedTwin.relayUrl !== relayUrl) {
      this._relayedTwin = new Fetcher({
        timeout: this.timeout, cooldown: this.cooldown,
        maxRetries: this.maxRetries, relayUrl, relaySecret,
      });
    }
    return this._relayedTwin;
  }

  // Same timeout/cooldown profile but egressing via proxyUrl; domain pacing
  // (_domainNext) is static so direct + proxied fetchers share one schedule.
  proxied(proxyUrl) {
    if (!proxyUrl) return this;
    if (!this._proxiedTwin || this._proxiedTwin.proxyUrl !== proxyUrl) {
      this._proxiedTwin = new Fetcher({
        timeout: this.timeout, cooldown: this.cooldown,
        maxRetries: this.maxRetries, proxyUrl,
      });
    }
    return this._proxiedTwin;
  }

  static _domainNext = new Map();

  _headers() {
    // No X-Forwarded-For: browsers never send it, so bot filters (Akamai)
    // read a forged one as a scraper signal — and it never influenced geo
    // pricing anyway (foreign-IP runs still got USD with it set).
    return {
      "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-IN,en;q=0.9",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
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
      const reqUrl = this.relayUrl
        ? `${this.relayUrl}/?url=${encodeURIComponent(url)}`
        : url;
      const headers = this._headers();
      if (this.relayUrl && this.relaySecret) headers.Authorization = `Bearer ${this.relaySecret}`;
      try {
        resp = await axios.get(reqUrl, {
          timeout: this.timeout, headers, maxRedirects: 5,
          responseType: "text", transformResponse: (x) => x,
          validateStatus: () => true,
          ...(this.proxyAgent
            ? { httpAgent: this.proxyAgent, httpsAgent: this.proxyAgent, proxy: false }
            : { httpAgent, httpsAgent }),
        });
      } catch (err) {
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
  text = text.replace(/[,  ' ]/g, "");
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
  m = text.match(/Shopify\.currency\s*=\s*\{[^}]*?["']active["']\s*:\s*["']([A-Z]{3})["']/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  if (text.includes("₹") || /\bRs\.?\s*\d/i.test(text)) return "INR";
  if (/\bC\$|\bCAD\b/.test(text)) return "CAD";
  if (/\bUSD\b/.test(text) || text.includes("$")) return "USD";
  return null;
}

// Returns { price, source }. The source matters because only prices read out
// of embedded Shopify-style JSON ("price": 120250000) can be integer cents —
// og:meta/itemprop/Woo markup always carries the display (decimal) amount, so
// the caller must never cents-descale those (a genuine ₹1.2M couture price
// crossed the 1M threshold and got halved to ₹12,025 — seen live 2026-07-17).
export function extractPriceDetail(html, customRegex = null, preferHigh = false) {
  // Range-high preference outranks a custom regex: brands flagged range-high
  // must capture the top of a variable-product price range.
  if (preferHigh) {
    const h = html.match(/"highPrice"\s*:\s*"?([0-9][0-9,.]*)"?/);
    if (h) return { price: sanitizePrice(h[1]), source: "jsonld" };
  }
  if (customRegex) {
    // No generic fallback on regex miss: removed/redirected product pages must
    // surface as "price not found", never as a random price from the page.
    try {
      const m = html.match(new RegExp(customRegex, "s"));
      if (m) {
        const g = m.slice(1).find((x) => x !== undefined); // first group that matched (supports alternation)
        return { price: sanitizePrice(g !== undefined ? g : m[0]), source: "custom" };
      }
    } catch {}
    return { price: null, source: null };
  }
  let m = html.match(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*property=["']product:price:amount["']/);
  if (m) return { price: sanitizePrice(m[1] || m[2]), source: "og" };
  // A page showing both a sale price and a struck-through original/MRP price
  // (e.g. anitadongre.com) often tags BOTH with itemprop="price" -- plain
  // .match() only ever returns the first (usually the sale price, since it's
  // rendered first). Take the highest value across every itemprop="price"
  // occurrence instead, same "prefer the pre-sale price" rule already used
  // for Shopify's compare_at_price.
  const itempropPrices = [...html.matchAll(/itemprop=["']price["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*itemprop=["']price["']/g)]
    .map((mm) => sanitizePrice(mm[1] || mm[2]))
    .filter((v) => v != null);
  if (itempropPrices.length) return { price: Math.max(...itempropPrices), source: "itemprop" };
  m = html.match(/itemprop=["']price["'][^>]*>([^<]+)</);
  if (m) return { price: sanitizePrice(m[1]), source: "itemprop" };
  m = html.match(/"(?:price|lowPrice)"\s*:\s*"?([0-9][0-9,.]*)"?/);
  if (m) return { price: sanitizePrice(m[1]), source: "json" };
  m = html.match(/woocommerce-Price-amount[^>]*>(?:<bdi>)?\s*(?:<span[^>]*>[^<]*<\/span>)?\s*([0-9][0-9,.]*)/);
  if (m) return { price: sanitizePrice(m[1]), source: "woo" };
  return { price: null, source: null };
}

export function extractPriceFromHtml(html, customRegex = null, preferHigh = false) {
  return extractPriceDetail(html, customRegex, preferHigh).price;
}

// Removed products on some stores (anitadongre's SFCC especially) don't 404 —
// they 302 the product URL to a category page or the homepage. Extracting
// there records some OTHER product's price (seen live: 13 removed products
// all storing the same 6,520 USD category-tile price). If the response landed
// on a URL that no longer carries the requested product's slug, refuse to
// extract — the row must surface as "product unavailable", never as a price.
export function redirectedOffProduct(requestedUrl, resp) {
  try {
    const req = new URL(requestedUrl);
    const slug = decodeURIComponent(req.pathname.replace(/\/+$/, "").split("/").pop() || "").toLowerCase();
    if (!slug) return false;
    // Relayed fetches: the axios final URL is the relay's own — only the
    // x-relay-final-url debug header knows where the ORIGIN ended up.
    const relayFinal = resp.headers?.["x-relay-final-url"];
    const finalUrl = relayFinal || resp.request?.res?.responseUrl;
    if (!finalUrl) return false;
    const fin = new URL(finalUrl);
    const bare = req.host.replace(/^www\./, "");
    if (!relayFinal && fin.host !== req.host && !fin.host.endsWith(bare)) return false;
    return !decodeURIComponent(fin.pathname + fin.search).toLowerCase().includes(slug);
  } catch { return false; }
}

function shopifyJsUrl(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, "");
  if (!p.endsWith(".js")) p += ".js";
  return `${u.origin}${p}${u.search}`;
}

const DOMAIN_CURRENCY = new Map();

// ---- platform extractors ----
function shopifyNum(raw) {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw / 100;
  return descaleIfCents(sanitizePrice(raw));
}

export async function extractShopify(fetcher, url, preferHigh = false) {
  const domain = new URL(url).host;
  try {
    const resp = await fetcher.get(shopifyJsUrl(url));
    const data = JSON.parse(resp.data);
    const variants = data.variants || [];
    const v0 = variants[0];
    // Main (pre-sale) price = max(compare_at, price) on the first variant:
    // on-sale stores put the original in compare_at (price holds the sale),
    // and some stores carry junk compare_at BELOW price, which max() ignores.
    // Range-high brands track the top variant (e.g. "with pants" sets), so
    // include the product-level maxima for them.
    const src = v0 || data;
    const cands = [src.compare_at_price, src.price];
    if (preferHigh) cands.push(data.compare_at_price_max, data.price_max);
    const price = Math.max(...cands.map((x) => shopifyNum(x) || 0)) || null;
    let currency = DOMAIN_CURRENCY.get(domain) || null;
    if (price != null && !currency) {
      try { currency = detectCurrency((await fetcher.get(url)).data); } catch {}
    }
    if (price != null) {
      if (currency) DOMAIN_CURRENCY.set(domain, currency);
      return [price, currency];
    }
  } catch {}
  let html;
  try {
    const resp = await fetcher.get(url);
    if (redirectedOffProduct(url, resp)) throw new Error("product unavailable (redirected off product page)");
    html = resp.data;
  }
  catch (e) {
    if (e.message.startsWith("product unavailable")) throw e;
    const code = e instanceof HttpError ? e.status : "?";
    if (code === 404) throw new Error("product unavailable (removed / 404)");
    throw new Error(`store returned HTTP ${code}`);
  }
  // Only descale prices scraped from embedded JSON — Shopify theme JSON is
  // integer cents, but og:meta/itemprop/Woo markup is the display amount and
  // a real price above the threshold (INR couture) must not be divided.
  const det = extractPriceDetail(html, null, preferHigh);
  let price = det.source === "json" ? descaleIfCents(det.price) : det.price;
  // HTML meta/JSON-LD advertise the SALE price; the theme's embedded product
  // JSON carries the original. First occurrence belongs to the main product.
  const cm = html.match(/"compare_at_price"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
  if (cm && price != null) {
    const cmp = descaleIfCents(parseFloat(cm[1]));
    if (cmp > price && cmp < price * 5) price = cmp;
  }
  const currency = detectCurrency(html) || DOMAIN_CURRENCY.get(domain) || null;
  if (price != null && currency) DOMAIN_CURRENCY.set(domain, currency);
  return [price, currency];
}

export async function extractWordpress(fetcher, url, preferHigh = false) {
  const resp = await fetcher.get(url);
  if (redirectedOffProduct(url, resp)) throw new Error("product unavailable (redirected off product page)");
  const html = resp.data;
  return [extractPriceFromHtml(html, null, preferHigh), detectCurrency(html)];
}

// WooCommerce Store API (public, no auth). Used for woo_api_brands when
// fetching via the relay: bot rules that redirect /product/ pages off
// datacenter IPs typically leave /wp-json/ alone, and the JSON carries
// explicit currency + minor-unit scaling.
export function wooApiUrl(url) {
  const u = new URL(url);
  const segs = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const slug = segs[segs.length - 1] || "";
  return `${u.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`;
}

export async function extractWooApi(fetcher, url, preferHigh = false) {
  const resp = await fetcher.get(wooApiUrl(url));
  let arr;
  try { arr = JSON.parse(resp.data); } catch { return [null, null]; }
  const p = Array.isArray(arr) ? arr[0]?.prices : null;
  if (!p) return [null, null];
  const scale = 10 ** (Number(p.currency_minor_unit) || 0);
  // Main (pre-sale) price = max(regular, current); range-high brands also
  // consider the top of the variant price range — mirrors the Shopify rule.
  const cands = [p.regular_price, p.price];
  if (preferHigh && p.price_range) cands.push(p.price_range.max_amount);
  const raw = Math.max(...cands.map((x) => (x == null ? 0 : parseFloat(x))).filter(Number.isFinite), 0);
  return raw > 0 ? [raw / scale, p.currency_code || null] : [null, p.currency_code || null];
}

export async function extractCustom(fetcher, url, customRegex, preferHigh = false) {
  const resp = await fetcher.get(url);
  if (redirectedOffProduct(url, resp)) throw new Error("product unavailable (redirected off product page)");
  const html = resp.data;
  return [extractPriceFromHtml(html, customRegex, preferHigh), detectCurrency(html)];
}

export function withCurrencyParam(url, param, currency) {
  if (!currency || !param) return url;
  try { const u = new URL(url); u.searchParams.set(param, currency); return u.toString(); }
  catch { return url; }
}

export async function extractRow(fetcher, url, platform, customRegex, opts = {}) {
  const p = (platform || "").trim().toLowerCase();
  let u = opts.fetchCurrency
    ? withCurrencyParam(url, opts.currencyParam || "wmc-currency", opts.fetchCurrency)
    : url;
  // Per-brand extra query params (e.g. anitadongre's switch=true suppresses
  // its geo-redirect when fetching from a foreign/relay IP).
  if (opts.appendParams) {
    for (const [k, v] of Object.entries(opts.appendParams)) u = withCurrencyParam(u, k, v);
  }
  const hi = opts.preferHighPrice === true;
  let res;
  if (p === "shopify") res = await extractShopify(fetcher, u, hi);
  else if (opts.wooApi) res = await extractWooApi(fetcher, u, hi); // relay path: JSON API instead of bot-blocked /product/ HTML
  else if (customRegex) res = await extractCustom(fetcher, u, customRegex, hi); // regex wins for wordpress/custom/unknown
  // Unknown/blank platform (e.g. a row imported from an external sheet with
  // no Platform Type column) — route through extractShopify anyway: it
  // probes the .js JSON endpoint first (harmless 404 on non-Shopify hosts,
  // caught internally) and its HTML fallback is cents-descaled, unlike
  // extractWordpress. Without this, a mislabeled Shopify store reads its
  // embedded cents price straight through and comes back exactly 100x high.
  else res = await extractShopify(fetcher, u, hi);
  if (opts.fetchCurrency && res && res[1] == null) res = [res[0], opts.fetchCurrency];
  return res;
}
