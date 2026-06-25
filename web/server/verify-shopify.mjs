// READ-ONLY: confirm the Shopify connection works and that the MBO product IDs on
// mismatch rows actually exist in the connected store. Does NOT change any price.
import axios from "axios";
import { getStoreIntegration } from "./src/store.js";
import { decrypt } from "./src/crypto.js";
import { verifyStore } from "./src/shopify.js";
import { q, pool } from "./src/db.js";

console.log("verifyStore():", await verifyStore());

const c = await getStoreIntegration();
const token = decrypt(c.access_token);
const ver = c.api_version || "2024-10";
const base = `https://${c.shop_domain}/admin/api/${ver}`;
const headers = { "X-Shopify-Access-Token": token };

const rows = await q("SELECT id, mbo_url FROM products WHERE state='mismatch' ORDER BY id LIMIT 4");
for (const r of rows) {
  let ref = "";
  try {
    const u = new URL(r.mbo_url);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const pi = parts.lastIndexOf("products");
    ref = pi >= 0 ? parts[pi + 1] : parts.at(-1);
  } catch { console.log(`row ${r.id}: bad mbo_url ${r.mbo_url}`); continue; }
  try {
    const url = /^\d+$/.test(ref)
      ? `${base}/products/${ref}.json`
      : `${base}/products.json?handle=${encodeURIComponent(ref)}`;
    const resp = await axios.get(url, { params: { fields: "id,title,variants" }, headers, timeout: 20000, validateStatus: () => true });
    if (resp.status === 200) {
      const p = resp.data.product || (resp.data.products || [])[0];
      if (p) console.log(`row ${r.id} ref ${ref}: FOUND "${p.title}" · ${p.variants.length} variant(s) · current price ${p.variants[0]?.price}`);
      else console.log(`row ${r.id} ref ${ref}: HTTP 200 but product NOT FOUND in store`);
    } else {
      console.log(`row ${r.id} ref ${ref}: HTTP ${resp.status}`);
    }
  } catch (e) { console.log(`row ${r.id} ref ${ref}: ERROR ${e.message}`); }
}
await pool.end();
process.exit(0);
