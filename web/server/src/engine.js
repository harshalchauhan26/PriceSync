import axios from "axios";
import http from "node:http";
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

export const COOLDOWN_MS = [1200, 2800];
export const SHOPIFY_CENTS_THRESHOLD = 1_000_000;
export const MATCH_TOLERANCE = 1.0;
const CURRENCIES = ["USD", "CAD", "INR"];
// Per-brand params appended at FETCH TIME ONLY — never persisted (canonicalUrl
// in store.js strips every name in FETCH_ONLY_PARAMS; a fetch param that once
// leaked into products.url corrupted a whole brand's rows).
//
// These pin the SITE's geo-pricing to India, so a cloud run reads the same
// price an India visitor sees. Both levers were verified to work FROM A FOREIGN
// IP, which is what makes them a real fix rather than a local-only workaround
// — the value each store serves is a function of the requested country, not of
// where the request came from:
//   mymoledro.com      Shopify Markets. ?country=US returns 339622.61 for a
//                      ₹275,000 product — the exact figure the Virginia-hosted
//                      runs had been storing as a "mismatch" — and ?country=IN
//                      returns 275000 from any IP. Replaces an earlier
//                      `mlveda_country=in`, which was a no-op: MLveda is
//                      client-side JS and cannot affect a server-side fetch
//                      that never executes JS.
//   labelanushree.com  WooCommerce "Price Based on Country" (WCPBC) — NOT
//                      WOOCS, and NOT the WMC param the engine was sending.
//                      ?wcpbc-manual-country=US serves $375 for the ₹34,000
//                      Jade Lehenga (again the exact stored value), =IN pins
//                      ₹34,000.
const DEFAULT_APPEND_PARAMS = {
  "mymoledro.com": { country: "IN" },
  "labelanushree.com": { "wcpbc-manual-country": "IN" },
};

// Every param the fetcher may append itself. Stripped before a URL is stored.
export const FETCH_ONLY_PARAMS = ["wmc-currency", "currency", "country", "wcpbc-manual-country"];

// BUG-019: appendParams (per-brand, DB-stored via relayParams) is user/admin
// input reaching a fetch URL — a whitelist plus a plain-token value charset
// stops both a stray key and an unescaped value from being injected. Every
// key actually used in practice (including FETCH_ONLY_PARAMS entries like
// wcpbc-manual-country, legitimately used as an appendParam — see
// DEFAULT_APPEND_PARAMS above) is on this list; nothing outside it passes.
const APPEND_PARAM_ALLOWED_KEYS = new Set(["country", "wmc-currency", "currency", "switch", "wcpbc-manual-country"]);
const APPEND_PARAM_VALUE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Per-brand host swap applied at FETCH TIME ONLY — the stored product URL keeps
// its original host (saveResult persists prod.url, which this never touches).
// For a brand whose baseline we track in USD, the US storefront is the correct
// SOURCE, not the Indian one: anitadongre prices its US catalog independently
// rather than converting, so the two hosts are different prices for the same
// garment and no exchange rate relates them. Measured on 8 products, INR/USD
// came out at 71.97, 71.96, 56.87, 65.63, 72.00, 72.00, 59.79 and 56.93 — a
// conversion would have produced one constant.
// Requires the brand to be in fetch_usd_brands: that routes it to the
// base_usd comparison path in finalizeOne, so the US price is compared against
// a US baseline instead of being FX-converted onto the ₹ one.
const DEFAULT_FETCH_HOSTS = {
  "anitadongre.com": "us.anitadongre.com",
};

export function withHost(url, host) {
  if (!host) return url;
  try { const u = new URL(url); u.host = host; return u.toString(); }
  catch { return url; }
}

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
  text = text.replace(/\u20B9|\u00e2\u201a\u00b9/g, "").replace(/C\$/g, "").replace(/\$/g, "");
  text = text.replace(/[,  ' ]/g, "");
  const m = text.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

export function descaleIfCents(v) {
  return v != null && v > SHOPIFY_CENTS_THRESHOLD ? v / 100 : v;
}

export function detectCurrency(text) {
  if (!text) return null;
  // Shopify.currency.active is a live, per-request JS global Shopify itself
  // sets for the visitor's resolved Market \u2014 it must outrank every static
  // meta/JSON-LD tag below, which are baked in at publish time for SEO and do
  // NOT update per Market. sapanaamin.com's own og:price:currency says "USD"
  // (frozen), while a Markets-localized visit genuinely returns
  // Shopify.currency={"active":"INR","rate":"97.04"} with the price already
  // converted to INR by Shopify itself \u2014 checking the static tag first read
  // that INR-denominated number as USD, a ~97x currency mislabel.
  let m = text.match(/Shopify\.currency\s*=\s*\{[^}]*?["']active["']\s*:\s*["']([A-Z]{3})["']/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  m = text.match(/(?:og|product):price:currency["'][^>]*content=["']([A-Z]{3})["']|content=["']([A-Z]{3})["'][^>]*(?:og|product):price:currency/);
  if (m) { const c = (m[1] || m[2]).toUpperCase(); if (CURRENCIES.includes(c)) return c; }
  // A rupee symbol counts as evidence only when it actually labels a NUMBER.
  // us.anitadongre.com carries "India \u20B9" in its country-switcher dropdown while
  // the price itself is "$6,190" with priceCurrency=USD \u2014 a bare-symbol test
  // read that label as the page currency and returned INR for a USD page, which
  // the currency guard then rejected as "asked USD, page served INR".
  // Tags are stripped first so a symbol wrapped away from its digits
  // (<span>\u20B9</span>1,200) still counts, while a symbol sitting alone in a menu
  // label does not. The Rs branch has always required a digit this way.
  const flat = String(text).replace(/<[^>]*>/g, " ");
  if (/\u20B9\s*\d|\u00e2\u201a\u00b9\s*\d/.test(flat) || /\bRs\.?\s*\d/i.test(flat)) return "INR";
  m = text.match(/"(?:priceCurrency|price_currency|currency)"\s*:\s*"([A-Z]{3})"/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  m = text.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Z]{3})["']/);
  if (m && CURRENCIES.includes(m[1].toUpperCase())) return m[1].toUpperCase();
  if (/\bC\$|\bCAD\b/.test(text)) return "CAD";
  if (/\bUSD\b/.test(text) || text.includes("$")) return "USD";
  return null;
}

const CUSTOM_REGEX_MAX_LEN = 500;
// Rejects the two catastrophic-backtracking shapes that actually hang V8's
// regex engine: a quantified group containing another quantifier (`(a+)+`,
// `(a*)+`), and a quantified alternation where a branch is a prefix of
// another (`(a|a)+`, `(a|ab)+`). Not exhaustive ReDoS detection — see the
// ponytail note at the call site.
export function isUnsafeCustomRegex(pattern) {
  const p = String(pattern || "");
  if (!p || p.length > CUSTOM_REGEX_MAX_LEN) return true;
  if (/\([^()]*[+*][^()]*\)[+*]/.test(p)) return true;
  if (/\([^()]*\|[^()]*\)[+*]/.test(p)) return true;
  return false;
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
    if (h) {
      const high = sanitizePrice(h[1]);
      const l = html.match(/"lowPrice"\s*:\s*"?([0-9][0-9,.]*)"?/);
      const low = l ? sanitizePrice(l[1]) : null;
      // A highPrice with no matching lowPrice on the page, or one more than 5x
      // it, is very likely a cross-selling/upsell widget's own JSON-LD block
      // for a DIFFERENT product rather than this product's price range — that
      // silently returns as a legitimate-looking price with no error raised,
      // so reject it here and fall through to the other extraction methods.
      if (high != null && low != null && high <= 5 * low) return { price: high, source: "jsonld" };
    }
  }
  if (customRegex) {
    // No generic fallback on regex miss: removed/redirected product pages must
    // surface as "price not found", never as a random price from the page.
    // BUG-010: a catastrophically backtracking custom_regex (nested quantifiers,
    // quantified alternation) can hang this worker thread for minutes against
    // 100KB+ page HTML. Guarded here — the one place every custom_regex actually
    // executes — rather than at each of the several save paths that write it.
    // ponytail: heuristic pattern-shape check, not a real ReDoS proof; swap for
    // the re2 package (linear-time engine, see Research.md) if a pattern still
    // slips through.
    if (isUnsafeCustomRegex(customRegex)) return { price: null, source: null };
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
  // A bare integer here is Shopify's own theme JSON (cents, e.g. "price":990000).
  // A decimal-formatted match is a JSON-LD/schema display price living under the
  // same key on the same page (e.g. "price":"9900.00") — the two can both be
  // present, and this regex takes whichever comes first in the HTML.
  if (m) return { price: sanitizePrice(m[1]), source: "json", isDecimal: m[1].includes(".") };
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
// Apex domain (last two labels) — "us.anitadongre.com" and "www.anitadongre.com"
// both reduce to "anitadongre.com" so a regional-subdomain redirect is still
// recognized as the same site, not exempted from the off-product check below.
const apexDomain = (h) => { const p = String(h || "").split("."); return p.length > 2 ? p.slice(-2).join(".") : p.join("."); };

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
    if (!relayFinal && fin.host !== req.host && apexDomain(fin.host) !== apexDomain(req.host)) return false;
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
  // Within the "json" bucket, a decimal match (JSON-LD sharing the same key)
  // is already a display price; a bare integer is cents regardless of size —
  // the old magnitude-only threshold left genuine sub-₹10,000 cents values
  // (e.g. "price":990000) undivided because they sat under it.
  const det = extractPriceDetail(html, null, preferHigh);
  let price = det.source === "json" ? (det.isDecimal ? det.price : det.price / 100) : det.price;
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

// Some Shopify stores have REAL multi-currency (Shopify Markets) enabled —
// manijassal.com quotes CAD 350 natively but genuinely charges USD 270.47 to
// a US buyer, which is NOT the same as 350 * a generic FX rate (Shopify adds
// its own markup/rounding on top of the raw rate: 270.47/350 = 0.773, vs the
// live market rate of ~0.719 fx.js would use — a ~7.5% gap). ?country=US on
// the plain .js endpoint returns that exact authoritative number with zero
// extra auth. Cached per-domain (not per-row) so a domain WITHOUT Markets
// (the common case) only pays this extra request once, not on every product.
// Shared by brand-live-prices.mjs (offline sheets) and pipeline.js/worker.js
// (the live USD-convert path, Decision-006) — one implementation of "is this
// domain's international pricing real or just a same-currency markup."
const MARKETS_USD_CACHE = new Map();
export async function shopifyMarketsUsd(fetcher, domain, url, nativePrice, preferHigh) {
  if (MARKETS_USD_CACHE.get(domain) === false) return null;
  const usUrl = withCurrencyParam(url, "country", "US");
  let usPrice = null, usCur = null;
  try {
    [usPrice] = await extractShopify(fetcher, usUrl, preferHigh);
    // BUG-025: extractShopify's own returned currency is unreliable here —
    // its DOMAIN_CURRENCY cache is keyed by hostname only, so once the
    // NATIVE-price fetch for this domain caches a currency (e.g. CAD), this
    // ?country=US fetch inherits that stale label instead of detecting its
    // own, even for a genuine Markets store. Detected fresh, off this
    // request's own HTML, ignoring that cache — the only way to tell a real
    // Markets conversion (manijassal.com: price differs, currency genuinely
    // USD) apart from a same-currency international markup (houseofarmuse.com:
    // price differs 1.25x, currency still INR).
    usCur = detectCurrency((await fetcher.get(usUrl)).data);
  } catch { /* fall through */ }
  const real = usPrice != null && usCur === "USD" && Math.abs(usPrice - nativePrice) > 0.01;
  if (MARKETS_USD_CACHE.get(domain) === undefined) MARKETS_USD_CACHE.set(domain, real);
  return real ? usPrice : null;
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
// The incoming url may already carry a currency selection (extractRow appends
// it via withCurrencyParam). CARRY IT OVER: the Store API is NOT immune to the
// multi-currency plugin — /wp-json/wc/store honours ?wmc-currency= and, when
// it's absent, falls back to geo-IP. Rebuilding this URL from scratch dropped
// the param, so cloud runs silently got the egress country's currency:
// saakshakinni.com returned GBP 298 for a ₹34,000 product, which then failed
// against the INR baseline. Only the currency param is carried, not the whole
// query string — the API takes its own params and slug must not be shadowed.
export function urlSlug(url) {
  try {
    const segs = new URL(url).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    return decodeURIComponent(segs[segs.length - 1] || "").toLowerCase();
  } catch { return ""; }
}

// `?slug=` can return MORE than the product asked for. Woo indexes every
// VARIATION under its own slug, and a sibling product's variation matches the
// same slug string: /product/rosetta-blouse-dracy-skirt/ returns the size-M
// variation of "…-dracy-skirt-2" FIRST (₹15,500) and the real variable parent
// second (range ₹11,000–₹26,500). Reading arr[0] therefore stored a mid-range
// variation price and preferHigh never saw a price_range at all — variations
// carry price_range: null. Take the top-level product (parent 0, not a
// variation) whose permalink actually ends in the requested slug.
export function pickWooProduct(arr, slug) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const parents = arr.filter((p) => p && !p.parent && p.type !== "variation");
  const pool = parents.length ? parents : arr;
  const want = String(slug || "").toLowerCase();
  const exact = want && pool.find((p) => urlSlug(p.permalink) === want);
  return exact || pool[0];
}

export function wooApiUrl(url, currencyParam = "wmc-currency") {
  const u = new URL(url);
  const slug = urlSlug(url);
  let out = `${u.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(slug)}`;
  const cur = currencyParam ? u.searchParams.get(currencyParam) : null;
  if (cur) out += `&${encodeURIComponent(currencyParam)}=${encodeURIComponent(cur)}`;
  return out;
}

export async function extractWooApi(fetcher, url, preferHigh = false, currencyParam = "wmc-currency") {
  const resp = await fetcher.get(wooApiUrl(url, currencyParam));
  let arr;
  try { arr = JSON.parse(resp.data); } catch { return [null, null]; }
  const p = pickWooProduct(arr, urlSlug(url))?.prices || null;
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

// The currency a fetch will REQUEST for a row — the single source of truth for
// that decision. It lived in three places (pipeline.js processOne, worker.js,
// and finalizeOne) and the finalizeOne copy was missing the INR pin, so the
// comparison stage believed nothing had been requested for wordpress brands and
// silently accepted whatever currency came back. That is how saakshakinni.com
// compared GBP 560 against a ₹64,000 baseline across 159 rows.
//   native-currency brand -> null (no param; the label is forced to nativeCur later)
//   USD-flagged brand     -> "USD"
//   any non-shopify brand -> "INR" (pins geo-detecting currency plugins)
//   shopify               -> null (not currency-parameterised)
export function requestedCurrency({ isNativeCurrency, isUsdBrand, platform } = {}) {
  if (isNativeCurrency) return null;
  if (isUsdBrand) return "USD";
  return String(platform || "").trim().toLowerCase() !== "shopify" ? "INR" : null;
}

export function withCurrencyParam(url, param, currency) {
  if (!currency || !param) return url;
  try { const u = new URL(url); u.searchParams.set(param, currency); return u.toString(); }
  catch { return url; }
}

export async function extractRow(fetcher, url, platform, customRegex, opts = {}) {
  const p = (platform || "").trim().toLowerCase();
  const domain = (() => { try { return new URL(url).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } })();
  const appendParams = { ...(DEFAULT_APPEND_PARAMS[domain] || {}), ...(opts.appendParams || {}) };
  // Host swap first, so the currency/geo params below land on the host we will
  // actually request — and so redirectedOffProduct compares the slug against
  // the URL that was really fetched.
  const target = withHost(url, opts.fetchHost || DEFAULT_FETCH_HOSTS[domain]);
  let u = opts.fetchCurrency
    ? withCurrencyParam(target, opts.currencyParam || "wmc-currency", opts.fetchCurrency)
    : target;
  // Per-brand extra query params (e.g. anitadongre's switch=true suppresses
  // its geo-redirect when fetching from a foreign/relay IP). BUG-019: these
  // come from a DB-stored per-brand config (relayParams), so a compromised
  // row or fat-fingered admin edit could otherwise inject an arbitrary key
  // into every fetch for that brand — whitelist + charset-validate here,
  // the one place appendParams actually reaches a request URL, regardless
  // of hardcoded (DEFAULT_APPEND_PARAMS) or DB-sourced origin.
  for (const [k, v] of Object.entries(appendParams)) {
    if (!APPEND_PARAM_ALLOWED_KEYS.has(k) || !APPEND_PARAM_VALUE_RE.test(String(v))) continue;
    u = withCurrencyParam(u, k, v);
  }
  const hi = opts.preferHighPrice === true;
  let res;
  if (p === "shopify") res = await extractShopify(fetcher, u, hi);
  // JSON API instead of bot-blocked /product/ HTML. `u` already carries the
  // currency param, and wooApiUrl carries it onto the API URL — without that the
  // API geo-falls-back and returns the egress country's currency.
  else if (opts.wooApi) res = await extractWooApi(fetcher, u, hi, opts.currencyParam || "wmc-currency");
  else if (customRegex) res = await extractCustom(fetcher, u, customRegex, hi); // regex wins for wordpress/custom/unknown
  // BUG-024: an explicitly-labeled wordpress row with no custom_regex/wooApi
  // used to fall into the catch-all below, which cents-descales any bare
  // integer JSON price it finds — correct for real Shopify theme JSON, wrong
  // for WooCommerce's JSON-LD (already a display amount, e.g. "price":"36000"
  // meaning ₹36,000, not paise). That silently read labelanushree.com's
  // ₹36,000 as ₹360. extractWordpress() already does this right (no
  // descaling) but was never wired in.
  else if (p === "wordpress") res = await extractWordpress(fetcher, u, hi);
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
