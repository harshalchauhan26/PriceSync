import axios from "axios";
import { decrypt } from "./crypto.js";
import { getStoreIntegration } from "./store.js";

function productRefOf(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const productIndex = parts.lastIndexOf("products");
    const productPart = productIndex >= 0 ? parts[productIndex + 1] : parts.at(-1);
    const variantId = (u.searchParams.get("variant") || "").trim();
    if (!productPart) return { handle: "", productId: "", variantId: "" };
    if (/^\d+$/.test(productPart)) return {
      handle: "", productId: productPart,
      variantId: /^\d+$/.test(variantId) ? variantId : "",
    };
    return {
      handle: decodeURIComponent(productPart), productId: "",
      variantId: /^\d+$/.test(variantId) ? variantId : "",
    };
  } catch { return { handle: "", productId: "", variantId: "" }; }
}
// The integration row rarely changes but was re-read from the DB (a remote
// round-trip) for every single push — cache it and invalidate on save.
let _cfgCache = { at: 0, val: null };
export function invalidateShopifyCfg() { _cfgCache = { at: 0, val: null }; }
async function cfg() {
  if (_cfgCache.val && Date.now() - _cfgCache.at < 30000) return _cfgCache.val;
  const c = await getStoreIntegration();
  const val = c ? { ...c, access_token: decrypt(c.access_token) } : null;
  _cfgCache = { at: Date.now(), val };
  return val;
}

let _pushChain = Promise.resolve();
function enqueuePush(task) {
  const run = _pushChain.then(task, task);
  _pushChain = run.then(() => {}, () => {});
  return run;
}

// Shopify REST leaks 2 req/s (burst 40) — back off on 429/5xx instead of failing the row.
const RETRY_LIMIT = 3;
async function shopReq(fn) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const status = e.response?.status;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt >= RETRY_LIMIT) throw e;
      const after = Number(e.response?.headers?.["retry-after"]);
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 1500 * (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 15000)));
    }
  }
}

export function pushPrice(url, price) {
  return enqueuePush(() => _pushPrice(url, price));
}
// Unqueued variant for the batch push job, which manages its own concurrency.
export function pushPriceNow(url, price) {
  return _pushPrice(url, price);
}
async function _pushPrice(url, price) {
  const c = await cfg();
  if (!c || !c.shop_domain || !c.access_token) return {
    ok: false, product_url: url, old_price: null, new_price: price,
    update_status: "no Shopify store connected (Integrations)", status: "no Shopify store connected (Integrations)",
  };
  if (price == null) return {
    ok: false, product_url: url, old_price: null, new_price: price,
    update_status: "approve a final price first", status: "approve a final price first",
  };
  const ref = productRefOf(url);
  const label = ref.productId ? `product ${ref.productId}` : `'${ref.handle}'`;
  if (!ref.handle && !ref.productId) return {
    ok: false, product_url: url, old_price: null, new_price: price,
    update_status: "product URL cannot be matched to a Shopify product handle or id",
    status: "product URL cannot be matched to a Shopify product handle or id",
  };
  const ver = c.api_version || "2024-10";
  const base = `https://${c.shop_domain}/admin/api/${ver}`;
  const headers = { "X-Shopify-Access-Token": c.access_token, "Content-Type": "application/json" };
  try {
    let productId = ref.productId || null;
    let variantIds = [];
    let oldPrices = [];
    if (ref.variantId && !c.dry_run) {
      // Fast path: a live push to a known variant id needs no product lookup.
      variantIds = [ref.variantId];
    } else {
      const product = ref.productId
        ? (await shopReq(() => axios.get(`${base}/products/${ref.productId}.json`, { params: { fields: "id,variants" }, headers, timeout: 20000 }))).data.product
        : ((await shopReq(() => axios.get(`${base}/products.json`, { params: { handle: ref.handle, fields: "id,variants" }, headers, timeout: 20000 }))).data.products || [])[0];
      if (!product) return {
        ok: false, product_url: url, old_price: null, new_price: price,
        update_status: `${label} not found in store`, status: `${label} not found in store`,
      };
      const variants = ref.variantId
        ? (product.variants || []).filter((v) => String(v.id) === ref.variantId)
        : (product.variants || []);
      if (!variants.length) {
        const msg = ref.variantId ? `variant ${ref.variantId} not found in ${label}` : `${label} has no variants`;
        return { ok: false, product_url: url, product_id: product.id, variant_id: ref.variantId || null,
          variant_ids: [], old_price: null, old_prices: [], new_price: price, update_status: msg, status: msg };
      }
      productId = product.id;
      variantIds = variants.map((v) => String(v.id));
      oldPrices = variants.map((v) => ({ variant_id: String(v.id), old_price: v.price }));
      if (c.dry_run) {
        const variantLabel = ref.variantId ? `variant ${variants[0].id}` : `all ${variants.length} variant(s)`;
        const msg = `DRY RUN: would set ${label} ${variantLabel} -> ${price}`;
        return { ok: true, product_url: url, product_id: product.id,
          variant_id: variantIds[0], variant_ids: variantIds,
          old_price: variants[0].price, old_prices: oldPrices, new_price: price,
          update_status: msg, status: msg };
      }
    }
    // Update variants concurrently; the PUT response echoes the saved price,
    // which doubles as verification — no extra GET round-trip per variant.
    const results = await Promise.all(variantIds.map(async (id) => {
      try {
        const pr = await shopReq(() => axios.put(`${base}/variants/${id}.json`,
          { variant: { id: Number(id), price: String(price) } }, { headers, timeout: 20000 }));
        const saved = pr.data?.variant?.price;
        if (Number(saved) === Number(price)) return { verified: { variant_id: id, price: saved } };
        return { verifyFailed: { variant_id: id, expected: price, found: saved } };
      } catch (error) {
        return { failed: { variant_id: id, error: String(error.response?.status || error.message) } };
      }
    }));
    const verified = results.filter((r) => r.verified).map((r) => r.verified);
    const failed = results.filter((r) => r.failed).map((r) => r.failed);
    const verifyFailed = results.filter((r) => r.verifyFailed).map((r) => r.verifyFailed);
    const ok = failed.length === 0 && verifyFailed.length === 0 && verified.length === variantIds.length;
    const msg = ok
      ? `updated all ${verified.length} variant(s) -> ${Number(price).toFixed(2)}`
      : `PARTIAL/FAILED: updated ${verified.length}/${variantIds.length}, failed ${failed.length + verifyFailed.length}`;
    return { ok, product_url: url, product_id: productId,
      variant_id: variantIds[0], variant_ids: variantIds,
      updated_variants: verified, failed_variants: failed, verification_errors: verifyFailed,
      old_price: oldPrices[0]?.old_price ?? null, old_prices: oldPrices, new_price: price,
      update_status: msg, status: msg };
  } catch (e) {
    const msg = "Shopify API error: " + (e.response?.status || e.message);
    return { ok: false, product_url: url, old_price: null, new_price: price,
      update_status: msg, status: msg };
  }
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
