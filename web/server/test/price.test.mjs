// Unit tests for the pure price/currency functions. No network, no DB.
//   node --test web/server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizePrice, descaleIfCents, detectCurrency, extractPriceDetail,
  redirectedOffProduct, withCurrencyParam, wooApiUrl, extractRow,
} from "../src/engine.js";
import {
  roundFinal, computeFinal, matchTol, stateOf, brandOf, canonicalUrl,
  normBrand, isPermanentError, liveBaseValue,
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

test("detectCurrency reads meta, symbols and JSON", () => {
  assert.equal(detectCurrency("₹1200"), "INR");
  assert.equal(detectCurrency("Rs 999"), "INR");
  assert.equal(detectCurrency("C$45"), "CAD");
  assert.equal(detectCurrency("$45"), "USD");
  assert.equal(detectCurrency('"priceCurrency":"USD"'), "USD");
  assert.equal(detectCurrency('<meta property="product:price:currency" content="CAD">'), "CAD");
  assert.equal(detectCurrency(""), null);
});

test("real rupee symbol outranks stray US dollar copy", () => {
  assert.equal(sanitizePrice("\u20B933,000.00"), 33000);
  assert.equal(detectCurrency("\u20B933,000 Free Shipping above US$ 500"), "INR");
  assert.equal(detectCurrency('"priceCurrency":"USD" visible \u20B933,000'), "INR");
});

test("Moledro Shopify fetch is pinned to India catalog prices", async () => {
  const seen = [];
  const fetcher = { async get(url) {
    seen.push(url);
    if (url.endsWith(".js?mlveda_country=in")) {
      return { data: JSON.stringify({ variants: [{ price: 26500000 }] }) };
    }
    return { data: "\u20B9265,000" };
  } };
  const [price, currency] = await extractRow(fetcher, "https://www.mymoledro.com/products/azura-lehenga-set", "shopify", null);
  assert.equal(price, 265000);
  assert.equal(currency, "INR");
  assert.equal(seen[0], "https://www.mymoledro.com/products/azura-lehenga-set.js?mlveda_country=in");
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

test("matchTol: INR fixed 1.0, foreign scales with base", () => {
  assert.equal(matchTol(10000, "INR"), 1.0);
  assert.equal(matchTol(10000, null), 1.0);
  assert.equal(matchTol(10000, "USD"), 50);
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

test("pushed baseline uses fetched live price before markup", async () => {
  setOverrides({ USD: 80 });
  const next = await liveBaseValue({ brand: "labelanushree.com", live_price: 440, currency: "USD" });
  assert.equal(next.baseNew, 35200);
  assert.equal(next.baseUsd, 440);
  assert.equal(next.statusLabel, "Price Matched (INR)");
});

test("toInr: INR passthrough, foreign uses override rate (deterministic)", async () => {
  setOverrides({ USD: 80, CAD: 60 });
  assert.equal(await toInr(100, "INR"), 100);
  assert.equal(await toInr(null, "USD"), null);
  assert.equal(await toInr(10, "USD"), 800);
  assert.equal(await toInr(10, "CAD"), 600);
});
