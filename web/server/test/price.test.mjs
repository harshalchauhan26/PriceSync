// Unit tests for the pure price/currency functions. No network, no DB.
//   node --test web/server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizePrice, descaleIfCents, detectCurrency, extractPriceDetail,
  redirectedOffProduct, withCurrencyParam, wooApiUrl, extractRow,
  pickWooProduct, FETCH_ONLY_PARAMS, isUnsafeCustomRegex,
} from "../src/engine.js";
import {
  roundFinal, computeFinal, matchTol, stateOf, brandOf, canonicalUrl,
  normBrand, isPermanentError, liveBaseValue, productIdentity,
} from "../src/store.js";
import { toInr, setOverrides } from "../src/fx.js";

test("sanitizePrice strips currency symbols, commas, words", () => {
  assert.equal(sanitizePrice("₹1,20,250"), 120250);
  assert.equal(sanitizePrice("$1,234.56"), 1234.56);
  assert.equal(sanitizePrice("Rs. 4,500"), 4500);
  assert.equal(sanitizePrice("C$99.00"), 99);
  assert.equal(sanitizePrice(1200), 1200);
  assert.equal(sanitizePrice(null), null);
});

test("descaleIfCents only divides above the 1M threshold", () => {
  assert.equal(descaleIfCents(999999), 999999);
  assert.equal(descaleIfCents(1500000), 15000);
  assert.equal(descaleIfCents(120250000), 1202500);
});

test("INCIDENT: a genuine 1.2M itemprop price must NOT be descaled", () => {
  // og/itemprop markup carries the DISPLAY amount; source must not be 'json'
  // so the caller (extractShopify) never cents-descales it.
  const html = '<span itemprop="price" content="1202500"></span>';
  const det = extractPriceDetail(html);
  assert.equal(det.source, "itemprop");
  assert.equal(det.price, 1202500);
});

test("INCIDENT: embedded JSON cents ARE flagged json so the caller descales", () => {
  const html = '"price":"120250000"';
  const det = extractPriceDetail(html);
  assert.equal(det.source, "json");
  assert.equal(descaleIfCents(det.price), 1202500);
});

test("INCIDENT: sub-threshold Shopify cents (twentynine.co, houseofmasaba.com) landed 100x high", () => {
  // Same page carries both the theme's cents JSON and a JSON-LD decimal price
  // under the same "price" key; the regex takes the first (cents) match. A
  // bare integer here is always cents regardless of size — "990000" sitting
  // under the old 1M magnitude threshold is exactly how ₹9,900 rendered as
  // ₹990,000 in Review.
  const html = '"price":990000,"price_min":990000,"available":true "price":"9900.00"';
  const det = extractPriceDetail(html);
  assert.equal(det.source, "json");
  assert.equal(det.isDecimal, false);
  assert.equal(det.price / 100, 9900);
});

test("BUG-010: isUnsafeCustomRegex rejects catastrophic-backtracking shapes", () => {
  assert.equal(isUnsafeCustomRegex("(a+)+b"), true);
  assert.equal(isUnsafeCustomRegex("(a|a)+b"), true);
  assert.equal(isUnsafeCustomRegex("(.*?)+"), true);
  assert.equal(isUnsafeCustomRegex("a".repeat(501)), true);
  assert.equal(isUnsafeCustomRegex(""), true);
  // Ordinary brand price regexes must keep working.
  assert.equal(isUnsafeCustomRegex('"price"\\s*:\\s*"?([0-9.,]+)"?'), false);
  assert.equal(isUnsafeCustomRegex("Rs\\.?\\s*([0-9,]+)"), false);
});

test("BUG-010: extractPriceDetail refuses to run an unsafe custom_regex", () => {
  const det = extractPriceDetail('"price":"1200"', "(a+)+b");
  assert.equal(det.price, null);
  assert.equal(det.source, null);
});

test("a decimal-formatted json price is a display amount, never divided", () => {
  const det = extractPriceDetail('"lowPrice":"14000.00"');
  assert.equal(det.isDecimal, true);
  assert.equal(det.price, 14000);
});

test("INCIDENT: sale + struck-through original both tagged price -> take highest", () => {
  const html = '<span itemprop="price" content="4000"></span>' +
               '<span itemprop="price" content="8000"></span>';
  const det = extractPriceDetail(html);
  assert.equal(det.price, 8000);
  assert.equal(det.source, "itemprop");
});

test("custom regex: match wins, miss returns null (no generic fallback)", () => {
  const html = 'data-amount="7350" and price 999';
  assert.equal(extractPriceDetail(html, 'data-amount="(\\d+)"').price, 7350);
  assert.equal(extractPriceDetail("no price here", 'data-amount="(\\d+)"').price, null);
});

test("BUG-004: preferHigh trusts a highPrice within 5x of the page's lowPrice", () => {
  const html = '"lowPrice":"5000","highPrice":"12000"';
  const det = extractPriceDetail(html, null, true);
  assert.equal(det.source, "jsonld");
  assert.equal(det.price, 12000);
});

test("BUG-004: preferHigh rejects a highPrice >5x lowPrice as widget contamination", () => {
  // A cross-selling widget's own JSON-LD (e.g. a ₹2M styling package) sitting
  // on the same page as this product's real ₹5,000-12,000 range must not be
  // silently returned as this product's price.
  const html = '"lowPrice":"5000","highPrice":"2000000"';
  const det = extractPriceDetail(html, null, true);
  assert.notEqual(det.source, "jsonld");
});

test("BUG-004: preferHigh rejects a highPrice with no lowPrice to verify against", () => {
  const html = '"highPrice":"2000000"';
  const det = extractPriceDetail(html, null, true);
  assert.notEqual(det.source, "jsonld");
});

test("detectCurrency reads meta, symbols and JSON", () => {
  assert.equal(detectCurrency("₹1200"), "INR");
  assert.equal(detectCurrency("Rs 999"), "INR");
  assert.equal(detectCurrency("C$45"), "CAD");
  assert.equal(detectCurrency("$45"), "USD");
  assert.equal(detectCurrency('"priceCurrency":"USD"'), "USD");
  assert.equal(detectCurrency('<meta property="product:price:currency" content="CAD">'), "CAD");
  assert.equal(detectCurrency(""), null);
});

// us.anitadongre.com prices in USD but keeps "India ₹" in its country-switcher.
// A bare-symbol rupee test labelled that page INR, and the currency guard then
// rejected every row as "asked USD, page served INR".
test("a rupee symbol in a switcher LABEL is not the page currency", () => {
  const usPage = '<a href="/home?switch=true&amp;currencyCode=INR"><span>India ₹</span></a>' +
    '<span class="value" itemprop="price" content="6190.00"> $6,190 <p class="siteCurrency">USD</p></span>' +
    '"priceCurrency":"USD"';
  assert.equal(detectCurrency(usPage), "USD");
  // A symbol wrapped away from its digits IS still a price (common Woo markup).
  assert.equal(detectCurrency('<span class="sym">₹</span>1,200'), "INR");
  // And the plain adjacent case keeps working.
  assert.equal(detectCurrency("₹4,45,500"), "INR");
});

test("real rupee symbol outranks stray US dollar copy", () => {
  assert.equal(sanitizePrice("\u20B933,000.00"), 33000);
  assert.equal(detectCurrency("\u20B933,000 Free Shipping above US$ 500"), "INR");
  assert.equal(detectCurrency('"priceCurrency":"USD" visible \u20B933,000'), "INR");
});

// Shopify Markets prices by REQUESTED country, so ?country=IN pins the India
// catalog from any egress IP. The old param here was `mlveda_country=in`, which
// never did anything: MLveda is client-side JS and cannot alter a server fetch.
// Virginia-hosted runs were therefore served the US market price (\u20B9275,000 came
// back as 339622.61) and stored it as a mismatch.
test("Moledro Shopify fetch is pinned to the India market", async () => {
  const seen = [];
  const fetcher = { async get(url) {
    seen.push(url);
    if (url.endsWith(".js?country=IN")) {
      return { data: JSON.stringify({ variants: [{ price: 26500000 }] }) };
    }
    return { data: "\u20B9265,000" };
  } };
  const [price, currency] = await extractRow(fetcher, "https://www.mymoledro.com/products/azura-lehenga-set", "shopify", null);
  assert.equal(price, 265000);
  assert.equal(currency, "INR");
  assert.equal(seen[0], "https://www.mymoledro.com/products/azura-lehenga-set.js?country=IN");
});

// labelanushree runs WooCommerce "Price Based on Country" (WCPBC) \u2014 not WOOCS,
// and not the WMC param the engine used to send. ?wcpbc-manual-country=US
// serves $375 for the \u20B934,000 Jade Lehenga, so =IN is what holds the baseline.
test("labelanushree fetch pins the WCPBC country to India", async () => {
  const seen = [];
  const woo = '<span class="woocommerce-Price-amount amount"><bdi>' +
    '<span class="woocommerce-Price-currencySymbol">\u20B9</span>34,000</bdi></span>';
  const fetcher = { async get(url) {
    seen.push(url);
    return { data: woo };
  } };
  const [price, currency] = await extractRow(fetcher, "https://labelanushree.com/product/jade-lehenga/", "wordpress", null);
  assert.equal(price, 34000);
  assert.equal(currency, "INR");
  assert.ok(seen.every((u) => u.includes("wcpbc-manual-country=IN")),
    `every request must carry the India pin, got ${JSON.stringify(seen)}`);
});

// A fetch-time param that reaches the stored URL corrupts the row permanently,
// so canonicalUrl strips this list \u2014 keep the two in sync.
test("FETCH_ONLY_PARAMS covers every param the fetcher appends", () => {
  for (const p of ["wmc-currency", "currency", "country", "wcpbc-manual-country"]) {
    assert.ok(FETCH_ONLY_PARAMS.includes(p), `${p} must be stripped before storing`);
  }
  assert.equal(canonicalUrl("https://mymoledro.com/products/sakura?country=IN"),
    "https://mymoledro.com/products/sakura");
  assert.equal(canonicalUrl("https://labelanushree.com/product/jade/?wcpbc-manual-country=IN"),
    "https://labelanushree.com/product/jade/");
  // A param that is part of the product identity must survive.
  assert.equal(canonicalUrl("https://ekaya.in/products/keep?variant=42"),
    "https://ekaya.in/products/keep?variant=42");
});

test("redirectedOffProduct catches removed products that 302 off the slug", () => {
  const requested = "https://brand.com/products/my-kurta";
  const offProduct = { headers: {}, request: { res: { responseUrl: "https://brand.com/collections/all" } } };
  const onProduct = { headers: {}, request: { res: { responseUrl: "https://brand.com/products/my-kurta" } } };
  assert.equal(redirectedOffProduct(requested, offProduct), true);
  assert.equal(redirectedOffProduct(requested, onProduct), false);
});

test("INCIDENT: a regional-subdomain redirect (us.brand.com -> www.brand.com) is still same-site, so an off-product bounce is caught", () => {
  // anitadongre.com 2026-07-23: us.anitadongre.com/<slug>.html 302s to the bare
  // www.anitadongre.com homepage on removed products. bare-domain comparison
  // used to only strip a literal "www." prefix, so "us.anitadongre.com" never
  // matched "www.anitadongre.com" and the guard silently let it extract the
  // homepage's price instead of flagging "redirected off product page".
  const requested = "https://us.brand.com/products/my-kurta";
  const offProduct = { headers: {}, request: { res: { responseUrl: "https://www.brand.com/" } } };
  const onProduct = { headers: {}, request: { res: { responseUrl: "https://us.brand.com/category/my-kurta" } } };
  assert.equal(redirectedOffProduct(requested, offProduct), true);
  assert.equal(redirectedOffProduct(requested, onProduct), false);
});

test("withCurrencyParam / wooApiUrl build URLs correctly", () => {
  assert.equal(withCurrencyParam("https://x.com/p", "wmc-currency", "USD"), "https://x.com/p?wmc-currency=USD");
  assert.equal(withCurrencyParam("https://x.com/p", "wmc-currency", null), "https://x.com/p");
  assert.equal(wooApiUrl("https://x.com/product/my-saree/"), "https://x.com/wp-json/wc/store/v1/products?slug=my-saree");
});

test("INCIDENT: wooApiUrl carries the currency param onto the Store API URL", () => {
  // /wp-json/wc/store is NOT geo-immune — it honours ?wmc-currency= and falls
  // back to the egress country's currency without it. Rebuilding the API URL
  // from scratch dropped the param, so cloud runs read saakshakinni.com as
  // GBP 298 for a ₹34,000 product and every row failed against its INR baseline.
  assert.equal(
    wooApiUrl("https://x.com/product/my-saree/?wmc-currency=INR"),
    "https://x.com/wp-json/wc/store/v1/products?slug=my-saree&wmc-currency=INR");
  // No currency selected -> unchanged, so non-multi-currency brands are untouched.
  assert.equal(
    wooApiUrl("https://x.com/product/my-saree/"),
    "https://x.com/wp-json/wc/store/v1/products?slug=my-saree");
  // A non-currency query param must NOT be forwarded — the API has its own
  // params and `slug` must never be shadowed.
  assert.equal(
    wooApiUrl("https://x.com/product/my-saree/?slug=evil&switch=true"),
    "https://x.com/wp-json/wc/store/v1/products?slug=my-saree");
});

test("INCIDENT: ?slug= returns a sibling's VARIATION first — take the variable parent", () => {
  // Live saakshakinni.com response for /product/rosetta-blouse-dracy-skirt/:
  // Woo indexes variations under their own slug, so the size-M variation of
  // "…-dracy-skirt-2" is returned AHEAD of the real parent. arr[0] read its
  // ₹15,500 and preferHigh saw price_range: null, so the ₹26,500 range-high
  // never landed (base 26,500 vs live 15,500 = a -11,000 phantom mismatch).
  const variation = { id: 29755, slug: "rosetta-blouse-dracy-skirt", parent: 29751, type: "variation",
    permalink: "https://saakshakinni.com/product/rosetta-blouse-dracy-skirt-2/?attribute_pa_size=m",
    prices: { price: "9300", regular_price: "15500", price_range: null } };
  const parent = { id: 24785, slug: "rosetta-blouse-dracy-skirt", parent: 0, type: "variable",
    permalink: "https://saakshakinni.com/product/rosetta-blouse-dracy-skirt/",
    prices: { price: "11000", regular_price: "11000", price_range: { min_amount: "11000", max_amount: "26500" } } };
  assert.equal(pickWooProduct([variation, parent], "rosetta-blouse-dracy-skirt").id, 24785);
  // Exact permalink match wins even between two top-level products.
  const other = { id: 1, parent: 0, type: "simple", permalink: "https://saakshakinni.com/product/other-thing/" };
  assert.equal(pickWooProduct([other, parent], "rosetta-blouse-dracy-skirt").id, 24785);
  // Degenerate payloads must not throw or return undefined-shaped junk.
  assert.equal(pickWooProduct([variation], "rosetta-blouse-dracy-skirt").id, 29755);
  assert.equal(pickWooProduct([], "x"), null);
  assert.equal(pickWooProduct(null, "x"), null);
});

test("productIdentity: one product, however the URL is spelled", () => {
  // Add-products dedupe hangs off this. A trailing slash, a capitalised host
  // or a leftover fetch param must not make the same product look new — that
  // is how 1,112 URLs ended up duplicated in the catalog.
  const want = productIdentity("https://saakshakinni.com/product/rosetta-blouse-dracy-skirt");
  for (const v of [
    "https://saakshakinni.com/product/rosetta-blouse-dracy-skirt/",
    "https://saakshakinni.com/product/rosetta-blouse-dracy-skirt?wmc-currency=INR",
    "https://SAAKSHAKINNI.com/product/rosetta-blouse-dracy-skirt/",
    "  https://saakshakinni.com/product/rosetta-blouse-dracy-skirt  ",
  ]) assert.equal(productIdentity(v), want, v);
  // Genuinely different products stay different — including the sibling slug
  // that caused the Woo Store API mix-up.
  assert.notEqual(productIdentity("https://saakshakinni.com/product/rosetta-blouse-dracy-skirt-2"), want);
  assert.equal(productIdentity(""), "");
});

test("roundFinal rounds to the nearest 0/5/10 bucket", () => {
  assert.equal(roundFinal(1002), 1000);
  assert.equal(roundFinal(1003), 1005);
  assert.equal(roundFinal(1005), 1005);
  assert.equal(roundFinal(1006), 1010);
  assert.equal(roundFinal(1000), 1000);
});

test("computeFinal honours custom, ref and conversion", () => {
  assert.equal(computeFinal(5000, 8300, "live", 0, 9999, true, 83), 9999); // custom wins
  assert.equal(computeFinal(5000, 8300, "live", 0, null, true, 83), 100);  // 8300/83
  assert.equal(computeFinal(5000, 8300, "base", 0, null, false, 83), 5000);
});

test("matchTol: flat 1.00 tolerance 2026-08-19, same for every currency/base size", () => {
  assert.equal(matchTol(10000, "INR"), 1.0);
  assert.equal(matchTol(10000, null), 1.0);
  assert.equal(matchTol(10000, "USD"), 1.0);
  assert.equal(matchTol(50, "USD"), 1.0);
});

test("stateOf maps status prefixes", () => {
  assert.equal(stateOf("Price Matched (USD)"), "matched");
  assert.equal(stateOf("Price Mismatch! (INR)"), "mismatch");
  assert.equal(stateOf("Fetch Error (removed / 404)"), "error");
  assert.equal(stateOf("whatever"), "pending");
});

test("brandOf / canonicalUrl / normBrand", () => {
  assert.equal(brandOf("https://www.brand.com/products/x"), "brand.com");
  assert.equal(brandOf("not a url"), "");
  assert.equal(canonicalUrl("https://x.com/p?wmc-currency=USD&a=1"), "https://x.com/p?a=1");
  assert.equal(normBrand("WWW.Brand.COM"), "brand.com");
});

test("isPermanentError separates dead links from transient blocks", () => {
  assert.equal(isPermanentError("Fetch Error (product unavailable (removed / 404))"), true);
  assert.equal(isPermanentError("Fetch Error (price not found)"), true);
  assert.equal(isPermanentError("Fetch Error (timeout of 12000ms exceeded)"), false);
  assert.equal(isPermanentError("Fetch Error (store returned HTTP 403)"), false);
  assert.equal(isPermanentError("Price Matched (INR)"), false);
});

// Tenant #1 — the pre-existing single-tenant production data; FX overrides
// and native-currency lookups are scoped per-tenant, so tests need a real
// mboId to key against (native_currency_brands doesn't include
// labelanushree.com, so this exercises the non-native INR-conversion path).
const TEST_MBO = 1;

test("pushed baseline uses fetched live price before markup", async () => {
  setOverrides(TEST_MBO, { USD: 80 });
  const next = await liveBaseValue(TEST_MBO, { brand: "labelanushree.com", live_price: 440, currency: "USD" });
  assert.equal(next.baseNew, 35200);
  assert.equal(next.baseUsd, 440);
  assert.equal(next.statusLabel, "Price Matched (INR)");
});

test("toInr: INR passthrough, foreign uses override rate (deterministic)", async () => {
  setOverrides(TEST_MBO, { USD: 80, CAD: 60 });
  assert.equal(await toInr(TEST_MBO, 100, "INR"), 100);
  assert.equal(await toInr(TEST_MBO, null, "USD"), null);
  assert.equal(await toInr(TEST_MBO, 10, "USD"), 800);
  assert.equal(await toInr(TEST_MBO, 10, "CAD"), 600);
});
