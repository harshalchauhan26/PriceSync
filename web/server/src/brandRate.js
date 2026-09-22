// Derives a brand's OWN effective INR->USD rate by sampling a few products:
// fetch our own native (INR) price the same way the pipeline does, then read
// the USD price that brand's own storefront actually displays (via a real
// browser -- the conversion is client-side JS a plain HTTP fetch never sees),
// and take the ratio. Owner request 2026-09-22: closes the gap between our
// generic market/override rate and each brand's own currency-display widget
// (confirmed on aisharao.com: our rate said $1,353.44, their own page said
// $1,332.08 for the identical ₹1,27,900 product -- both "real" numbers, just
// from different rate sources). Used for usd_convert_brands display/mismatch
// math only, never for the push price (that stays on the admin's own rate).
import puppeteer from "puppeteer";
import { extractRow } from "./engine.js";

const MONEY_SELECTORS = ".price__container .price-item--regular .money, .price-item--regular .money, .product__price .money, .price .money, span.money";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseMoney(text) {
  const m = String(text || "").replace(/,/g, "").match(/([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}

// Returns every distinct $ amount on the page, not just the first --
// INCIDENT: mahimamahajan.in's first $-match in DOM order was a cheaper
// unrelated size/variant (MRP ₹16,000), not the product our own native fetch
// priced (₹80,000); "take the first" silently produced a 480 "rate" (should
// be ~96) that would have corrupted base_usd for all 726 of that brand's
// rows. The caller cross-checks every candidate against the known native
// price instead of trusting DOM order.
async function readDollarAmounts(page) {
  const texts = await page.$$eval(MONEY_SELECTORS, (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  const amounts = [];
  for (const t of texts) {
    if (!/\$/.test(t)) continue; // skip amounts still shown in a non-$ currency (INR default, etc.)
    const n = parseMoney(t);
    if (n > 0) amounts.push(n);
  }
  return amounts;
}

// A Shopify store's USD conversion is almost always a client-side currency-
// widget app, and geo-detects by default (an Indian egress IP sees INR even
// though a US visitor would see USD, confirmed on aisharao.com) -- so reading
// the as-loaded price only works for a brand with no geo-gating. Two more
// widget patterns cover the rest, tried in order, cheapest first; whichever
// makes a $ price appear wins:
//   1. "Bucks Currency Converter": a localStorage flag read on page load.
//   2. "BA/Nova Currency Converter" (confirmed working on aisharao.com): a
//      custom dropdown -- the visible trigger has to be opened before its
//      <li> options exist in a clickable state, and the underlying <select>
//      fires no listener on its own 'change' event.
// A brand on neither app (or one that geo-gates a technique we haven't
// hit yet) just yields no reading here and falls back to the market rate --
// see deriveBrandRate's 2-sample minimum below.
async function readDisplayedUsdAmounts(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(1200);

    let amounts = await readDollarAmounts(page);
    if (amounts.length) return amounts;

    await page.evaluate(() => { try { localStorage.setItem("selected_currency", "USD"); } catch {} });
    await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
    await sleep(1200);
    amounts = await readDollarAmounts(page);
    if (amounts.length) return amounts;

    await page.evaluate(() => document.querySelector(".bacurr-choiceDesign")?.click());
    await sleep(500);
    await page.evaluate(() => document.querySelector('li.currMovers[rel="USD"]')?.click());
    await sleep(2000);
    return await readDollarAmounts(page);
  } finally {
    await page.close().catch(() => {});
  }
}

// Loose enough to accept any real-world INR/USD rate for years to come,
// tight enough to reject a mismatched-variant artifact like the 480 above
// (true rate ~96) or a near-zero one (a stray "$0.00" placeholder).
const MIN_PLAUSIBLE_RATE = 50, MAX_PLAUSIBLE_RATE = 150;

// samples: [{ url, platform, custom_regex }]. Returns the median ratio
// (native INR / displayed USD), or null if fewer than 2 samples yielded a
// usable, plausible pair -- a single outlier shouldn't set a brand-wide rate.
export async function deriveBrandRate(fetcher, samples) {
  if (!samples.length) return null;
  let browser;
  const ratios = [];
  try {
    browser = await puppeteer.launch({ headless: "new" });
    for (const s of samples) {
      try {
        const [native, cur] = await extractRow(fetcher, s.url, s.platform, s.custom_regex, {});
        if (native == null || !["INR", "UNKNOWN"].includes((cur || "").toUpperCase())) continue;
        const amounts = await readDisplayedUsdAmounts(browser, s.url);
        // Cross-check every distinct $ amount against the price we already
        // know is right, instead of trusting whichever happened to render
        // first in the DOM (a different, unrelated variant/add-on in
        // mahimamahajan.in's case, 5x off). Multiple OTHER variants on the
        // same page (their own real prices, same real rate) often survive
        // the band together and agree closely -- that's corroboration, not
        // ambiguity, so take their median; only a genuinely scattered set
        // (no shared rate) is worth discarding the whole sample over.
        const candidates = [...new Set(amounts)]
          .map((amt) => native / amt)
          .filter((r) => r >= MIN_PLAUSIBLE_RATE && r <= MAX_PLAUSIBLE_RATE)
          .sort((a, b) => a - b);
        if (!candidates.length) continue;
        const cmid = Math.floor(candidates.length / 2);
        const sampleRate = candidates.length % 2 ? candidates[cmid] : (candidates[cmid - 1] + candidates[cmid]) / 2;
        // Reject if the survivors don't actually agree (spread > 10% of the
        // median) -- that's the "genuinely ambiguous" case, not corroboration.
        if (candidates[candidates.length - 1] - candidates[0] > sampleRate * 0.1) continue;
        ratios.push(sampleRate);
      } catch { /* one bad sample must never sink the whole derivation */ }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  if (ratios.length < 2) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}
