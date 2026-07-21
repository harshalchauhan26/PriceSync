// Read-only price-correctness reconciliation.
//   node web/server/tools/verify-prices.mjs
// Runs SELECT-only queries against Supabase and writes PriceVerify_<date>.xlsx
// plus a console summary. Changes NOTHING in the database. Run it after a full
// pipeline pass to answer "is the fetched price actually correct?".
import ExcelJS from "exceljs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, ping } from "../src/db.js";
import { toInr } from "../src/fx.js";
import { nativeCurrencyBrands, usdFetchBrandSet, normBrand, isPermanentError } from "../src/store.js";

const RATIO_FLAGS = [
  { name: "~100x high (cents not descaled)", lo: 97, hi: 103 },
  { name: "~100x low", lo: 1 / 103, hi: 1 / 97 },
  { name: "~2x (sale/compare_at picked wrong)", lo: 1.94, hi: 2.06 },
  { name: "~0.5x", lo: 0.485, hi: 0.515 },
];

function ratioFlag(r) {
  for (const f of RATIO_FLAGS) if (r >= f.lo && r <= f.hi) return f.name;
  return null;
}

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const native = await nativeCurrencyBrands();
  const usdFetch = await usdFetchBrandSet();

  const rows = await q(`SELECT key, brand, platform, url, base_price, live_price, currency,
    state, status, updated_at, verified_dead_at, dead_fail_count FROM products ORDER BY brand, key`);

  const priceAnomalies = [];
  const currencyAnomalies = [];
  const brandStats = new Map();

  for (const r of rows) {
    const nb = normBrand(r.brand);
    const bs = brandStats.get(nb) || { brand: r.brand, total: 0, error: 0, permanent: 0, transient: 0 };
    bs.total++;
    if (r.state === "error") {
      bs.error++;
      if (isPermanentError(r.status)) bs.permanent++; else bs.transient++;
    }
    brandStats.set(nb, bs);

    // Price ratio check — only where we have both numbers and it matched/mismatched.
    if (r.live_price != null && r.base_price != null && r.base_price > 0 && r.state !== "error") {
      const liveInr = await toInr(r.live_price, r.currency);
      const ratio = liveInr / r.base_price;
      const flag = ratioFlag(ratio);
      if (flag) priceAnomalies.push({
        brand: r.brand, url: r.url, base_price: r.base_price, live_price: r.live_price,
        currency: r.currency, live_inr: Math.round(liveInr * 100) / 100,
        ratio: Math.round(ratio * 1000) / 1000, flag,
      });
    }

    // Currency anomaly check.
    const cur = String(r.currency || "").toUpperCase();
    if (r.state !== "error" && r.live_price != null) {
      const expectedNative = native[nb];
      let issue = null;
      if (!cur || cur === "UNKNOWN") issue = "no currency detected";
      else if (expectedNative && cur !== expectedNative) issue = `expected native ${expectedNative}, got ${cur}`;
      else if (usdFetch.has(nb) && cur !== "USD") issue = `USD-fetch brand returned ${cur}`;
      else if (nb.endsWith(".in") && cur !== "INR") issue = `.in domain returned ${cur}`;
      if (issue) currencyAnomalies.push({
        brand: r.brand, url: r.url, currency: cur, live_price: r.live_price, issue,
      });
    }
  }

  const highErrorBrands = [...brandStats.values()]
    .filter((b) => b.total >= 5 && b.error / b.total > 0.4)
    .map((b) => ({ ...b, error_pct: Math.round((b.error / b.total) * 100) }))
    .sort((a, b) => b.error_pct - a.error_pct);

  const deadCandidates = rows.filter((r) => r.state === "error" && isPermanentError(r.status));
  const verifiedDead = rows.filter((r) => r.verified_dead_at);

  // ---- console summary ----
  const trustable = rows.filter((r) => r.state !== "error").length - priceAnomalies.length - currencyAnomalies.length;
  console.log("\n=== Price verification ===");
  console.log(`Products:            ${rows.length}`);
  console.log(`Errors:              ${rows.filter((r) => r.state === "error").length}`);
  console.log(`Price-ratio flags:   ${priceAnomalies.length}`);
  console.log(`Currency flags:      ${currencyAnomalies.length}`);
  console.log(`High-error brands:   ${highErrorBrands.length} (>40% error rate)`);
  console.log(`Permanent-error rows:${deadCandidates.length}  |  already verified-dead: ${verifiedDead.length}`);
  console.log(`Looks trustworthy:   ~${Math.max(0, trustable)}`);

  // ---- xlsx ----
  const wb = new ExcelJS.Workbook();
  const add = (name, data, cols) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(cols);
    ws.getRow(1).font = { bold: true };
    data.forEach((d) => ws.addRow(cols.map((c) => d[c])));
    ws.columns.forEach((c) => { c.width = 26; });
  };
  add("price_ratio_flags", priceAnomalies, ["brand", "url", "base_price", "live_price", "currency", "live_inr", "ratio", "flag"]);
  add("currency_flags", currencyAnomalies, ["brand", "url", "currency", "live_price", "issue"]);
  add("high_error_brands", highErrorBrands, ["brand", "total", "error", "error_pct", "permanent", "transient"]);
  add("permanent_error_rows", deadCandidates.map((r) => ({ brand: r.brand, url: r.url, status: r.status, dead_fail_count: r.dead_fail_count })), ["brand", "url", "status", "dead_fail_count"]);

  const out = path.resolve(fileURLToPath(new URL(".", import.meta.url)), `../../../PriceVerify_${new Date().toISOString().slice(0, 10)}.xlsx`);
  await wb.xlsx.writeFile(out);
  console.log(`\nWrote ${out}\n`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
