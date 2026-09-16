// EXPERIMENT / TEST ONLY -- not wired into the real pipeline (engine.js,
// pipeline.js) and not intended to be. Answers one question: can a headless
// browser toggle a client-side currency-converter widget (e.g. "Bucks
// Currency Converter" on papadontpreach.com) and read back the converted
// price, since that widget runs entirely in JS after page load and our real
// scraper (axios, no JS engine) can never see it?
//
//   node web/server/tools/test-headless-currency-scrape.mjs <url>
//
// Writes NOTHING to the database. Requires `puppeteer` (installed as a real
// dependency since nothing else in the project can run page JS -- this file
// is the only thing that uses it).
import puppeteer from "puppeteer";

const url = process.argv[2] || "https://papadontpreach.com/products/oliver-ice-blue-jacket-set";

const MONEY_SEL = ".price__container .price-item--regular .money, .price-item--regular .money, span.money";

async function readMoney(page) {
  return page.$$eval(MONEY_SEL, (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
}

async function main() {
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  console.log("Native (as-loaded) price text:", await readMoney(page));

  // Bucks Currency Converter (confirmed via a first run) keys its choice off
  // localStorage.selected_currency -- set it directly and reload, rather
  // than hunting for the right UI element to click.
  await page.evaluate(() => localStorage.setItem("selected_currency", "USD"));
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500)); // let the widget's JS rewrite the DOM after reload

  console.log("After setting selected_currency=USD + reload, price text:", await readMoney(page));

  // Also log localStorage/cookies in case the widget's currency choice is
  // simple to set directly next time (avoids UI-clicking entirely).
  const ls = await page.evaluate(() => ({ ...localStorage }));
  console.log("localStorage keys touching currency:",
    Object.fromEntries(Object.entries(ls).filter(([k]) => /curr/i.test(k))));
  const cookies = (await page.cookies()).filter((c) => /curr/i.test(c.name));
  console.log("cookies touching currency:", JSON.stringify(cookies.map((c) => [c.name, c.value])));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
