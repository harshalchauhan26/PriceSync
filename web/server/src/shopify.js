// Shopify price push (port of push_price_to_shopify / verify_shopify).
import axios from "axios";
import { decrypt } from "./crypto.js";
import { getStoreIntegration } from "./store.js";

function handleOf(url) {
  try { return new URL(url).pathname.replace(/\/+$/, "").split("/").pop().split("?")[0]; }
  catch { return ""; }
}
async function cfg() {
  const c = await getStoreIntegration();
  if (!c) return null;
  return { ...c, access_token: decrypt(c.access_token) };
}

export async function pushPrice(url, price) {
  const c = await cfg();
  if (!c || !c.shop_domain || !c.access_token) return { ok: false, status: "no Shopify store connected (Integrations)" };
  if (price == null) return { ok: false, status: "approve a final price first" };
  const handle = handleOf(url);
  if (c.dry_run) return { ok: true, status: `DRY RUN: would set '${handle}' -> ${price}` };
  const ver = c.api_version || "2024-10";
  const base = `https://${c.shop_domain}/admin/api/${ver}`;
  const headers = { "X-Shopify-Access-Token": c.access_token, "Content-Type": "application/json" };
  try {
    const r = await axios.get(`${base}/products.json`, { params: { handle, fields: "id,variants" }, headers, timeout: 20000 });
    const products = r.data.products || [];
    if (!products.length) return { ok: false, status: `handle '${handle}' not found in store` };
    let updated = 0;
    for (const v of products[0].variants || []) {
      const pr = await axios.put(`${base}/variants/${v.id}.json`,
        { variant: { id: v.id, price: String(price) } }, { headers, timeout: 20000 }).catch(() => null);
      if (pr && (pr.status === 200 || pr.status === 201)) updated++;
    }
    return { ok: updated > 0, status: `${updated ? "updated" : "FAILED"} ${updated} variant(s) -> ${price}` };
  } catch (e) { return { ok: false, status: "Shopify API error: " + (e.response?.status || e.message) }; }
}

export async function verifyStore() {
  const c = await cfg();
  if (!c || !c.shop_domain || !c.access_token) return { ok: false, status: "no store connected" };
  const ver = c.api_version || "2024-10";
  try {
    const r = await axios.get(`https://${c.shop_domain}/admin/api/${ver}/shop.json`,
      { headers: { "X-Shopify-Access-Token": c.access_token }, timeout: 15000, validateStatus: () => true });
    if (r.status === 200) return { ok: true, status: `connected to ${r.data.shop?.name} (${r.data.shop?.myshopify_domain})${c.dry_run ? " · DRY-RUN" : " · LIVE"}` };
    if (r.status === 401) return { ok: false, status: "401 — invalid/expired token" };
    if (r.status === 404) return { ok: false, status: "404 — shop_domain not found" };
    return { ok: false, status: "HTTP " + r.status };
  } catch (e) { return { ok: false, status: "connection error: " + e.message }; }
}
