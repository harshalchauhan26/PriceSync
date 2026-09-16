// EXPERIMENT / TEST ONLY -- not wired into the real pipeline (engine.js,
// pipeline.js), never will be from this file. Broad sweep answering: across
// every brand's catalog, how many products have a CLIENT-SIDE currency
// widget (like papadontpreach.com's "Bucks Currency Converter") whose price
// actually changes when we toggle it, vs brands where nothing changes at
// all (no widget, or one that needs something this shotgun approach doesn't
// guess).
//
//   node web/server/tools/test-headless-currency-scrape-all.mjs --minutes 60 --concurrency 5
//
// Round-robins across every brand (not brand-by-brand in order) so a 1-hour
// budget gets breadth across brands, not just exhausting the first one
// alphabetically. Stops dispatching new pages once the time budget is hit,
// writes whatever it collected so far. Writes NOTHING to the database.
import puppeteer from "puppeteer";
import pLimit from "p-limit";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const MINUTES = Number(argOf("--minutes") || 60);
const CONCURRENCY = Number(argOf("--concurrency") || 5);
const MBO_ID = Number(argOf("--mbo") || 1);
const PER_BRAND_CAP = Number(argOf("--per-brand-cap") || 0); // 0 = no cap
const deadline = Date.now() + MINUTES * 60 * 1000;

// Shotgun list -- every localStorage key name we've seen or would plausibly
// guess a currency-converter Shopify app to use, PLUS whatever key(s) we
// find already sitting in localStorage on first load (auto-discovers a
// brand's real key the same way we found papadontpreach.com's
// "selected_currency" by inspection).
const COMMON_KEYS = ["selected_currency", "currency", "preferred_currency", "shopify_currency",
  "geo_currency", "chosen_currency", "user_currency", "cc_currency", "current_currency", "storeCurrency"];

const MONEY_SEL = '[class*="price" i] .money, [class*="price" i], [class*="money" i]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readMoney(page) {
  try {
    return await page.$$eval(MONEY_SEL, (els) => els.map((e) => e.textContent.trim()).filter(Boolean).slice(0, 5));
  } catch { return []; }
}

// Appended to immediately after every single result -- a session/process
// kill mid-run (this file lost 50 tested rows to exactly that once already)
// leaves this file with everything tested up to the kill, not nothing.
let checkpointPath = null;
function checkpoint(r) {
  if (!checkpointPath) return;
  fs.appendFileSync(checkpointPath, JSON.stringify(r) + "\n");
}

async function testOne(browser, row, results) {
  if (Date.now() > deadline) return;
  const page = await browser.newPage();
  try {
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
    await page.goto(row.url, { waitUntil: "networkidle2", timeout: 20000 });
    const nativeText = await readMoney(page);
    const foundKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => /curr/i.test(k)));
    await page.evaluate((keys, common) => {
      [...new Set([...keys, ...common])].forEach((k) => { try { localStorage.setItem(k, "USD"); } catch {} });
    }, foundKeys, COMMON_KEYS);
    await page.reload({ waitUntil: "networkidle2", timeout: 20000 });
    await sleep(1200);
    const toggledText = await readMoney(page);
    const changed = nativeText.length && JSON.stringify(nativeText) !== JSON.stringify(toggledText);
    const r = {
      brand: row.brand, url: row.url, platform: row.platform || "",
      native: nativeText.join(" | "), toggled: toggledText.join(" | "),
      changed: changed ? "YES" : "no", found_keys: foundKeys.join(","), error: "",
    };
    results.push(r); checkpoint(r);
  } catch (e) {
    const r = { brand: row.brand, url: row.url, platform: row.platform || "",
      native: "", toggled: "", changed: "no", found_keys: "", error: e.message.slice(0, 120) };
    results.push(r); checkpoint(r);
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const rows = await q(
    `SELECT brand, url, platform FROM products WHERE mbo_id=$1 AND url IS NOT NULL AND url<>'' ORDER BY brand, url`,
    [MBO_ID]);
  const byBrand = new Map();
  rows.forEach((r) => { if (!byBrand.has(r.brand)) byBrand.set(r.brand, []); byBrand.get(r.brand).push(r); });
  const brands = [...byBrand.keys()];

  // Round-robin: take index 0 from every brand, then index 1 from every
  // brand, etc. -- guarantees breadth across all 40 brands early, instead of
  // finishing brand #1's 900 rows before ever touching brand #2.
  const queue = [];
  for (let idx = 0; ; idx++) {
    let added = false;
    for (const b of brands) {
      const arr = byBrand.get(b);
      if (PER_BRAND_CAP && idx >= PER_BRAND_CAP) continue;
      if (arr.length > idx) { queue.push(arr[idx]); added = true; }
    }
    if (!added) break;
  }
  console.log(`\n${queue.length} products queued across ${brands.length} brands (round-robin), budget ${MINUTES}min, concurrency ${CONCURRENCY}\n`);

  const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  checkpointPath = path.join(outDir, `CurrencyToggleTest_${stamp}.checkpoint.jsonl`);
  console.log(`Checkpoint file (safe against an interrupted run): ${checkpointPath}\n`);

  const browser = await puppeteer.launch({ headless: "new" });
  const limit = pLimit(CONCURRENCY);
  const results = [];
  let done = 0;
  const t0 = Date.now();

  await Promise.all(queue.map((row) => limit(async () => {
    if (Date.now() > deadline) return;
    await testOne(browser, row, results);
    done++;
    if (done % 25 === 0) {
      const leftSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`  ${done}/${queue.length} tested, ${results.filter((r) => r.changed === "YES").length} changed so far, ${leftSec}s left`);
    }
  })));

  await browser.close();

  const changedBrands = [...new Set(results.filter((r) => r.changed === "YES").map((r) => r.brand))];
  console.log(`\nDone (or time budget hit). Tested ${results.length}/${queue.length} in ${Math.round((Date.now() - t0) / 1000)}s.`);
  console.log(`Brands where toggling changed the price: ${changedBrands.length ? changedBrands.join(", ") : "(none)"}\n`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Currency Toggle Test");
  const C = ["brand", "url", "platform", "native_price_text", "toggled_price_text", "changed", "found_localStorage_keys", "error"];
  ws.addRow(C); ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: C.length } };
  results.forEach((r) => ws.addRow([r.brand, r.url, r.platform, r.native, r.toggled, r.changed, r.found_keys, r.error]));
  ws.columns.forEach((c, i) => { c.width = [22, 58, 12, 40, 40, 9, 24, 30][i] || 16; });
  const file = `CurrencyToggleTest_${stamp}.xlsx`;
  await wb.xlsx.writeFile(path.join(outDir, file));
  console.log(`Wrote ${file}. No database was touched.\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
