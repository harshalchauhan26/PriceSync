// Shopify price push (port of push_price_to_shopify / verify_shopify).
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
async function cfg() {
  const c = await getStoreIntegration();
  if (!c) return null;
  return { ...c, access_token: decrypt(c.access_token) };
}

export async function pushPrice(url, price) {
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
    const product = ref.productId
      ? (await axios.get(`${base}/products/${ref.productId}.json`, { params: { fields: "id,variants" }, headers, timeout: 20000 })).data.product
      : ((await axios.get(`${base}/products.json`, { params: { handle: ref.handle, fields: "id,variants" }, headers, timeout: 20000 })).data.products || [])[0];
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
    const oldPrices = variants.map((v) => ({ variant_id: String(v.id), old_price: v.price }));
    const variantLabel = ref.variantId ? `variant ${variants[0].id}` : `all ${variants.length} variant(s)`;
    if (c.dry_run) {
      const msg = `DRY RUN: would set ${label} ${variantLabel} -> ${price}`;
      return { ok: true, product_url: url, product_id: product.id,
        variant_id: String(variants[0].id), variant_ids: variants.map((v) => String(v.id)),
        old_price: variants[0].price, old_prices: oldPrices, new_price: price,
        update_status: msg, status: msg };
    }
    const updated = [];
    const failed = [];
    for (const variant of variants) {
      try {
        const pr = await axios.put(`${base}/variants/${variant.id}.json`,
          { variant: { id: variant.id, price: String(price) } }, { headers, timeout: 20000 });
        if ([200, 201].includes(pr.status)) updated.push(String(variant.id));
        else failed.push({ variant_id: String(variant.id), error: `HTTP ${pr.status}` });
      } catch (error) {
        failed.push({ variant_id: String(variant.id), error: String(error.response?.status || error.message) });
      }
    }
    const verified = [];
    const verifyFailed = [];
    for (const id of updated) {
      const check = await axios.get(`${base}/variants/${id}.json`, { headers, timeout: 20000 });
      const verifiedPrice = check.data.variant?.price;
      if (Number(verifiedPrice) === Number(price)) verified.push({ variant_id: id, price: verifiedPrice });
      else verifyFailed.push({ variant_id: id, expected: price, found: verifiedPrice });
    }
    const ok = failed.length === 0 && verifyFailed.length === 0 && verified.length === variants.length;
    const msg = ok
      ? `updated all ${verified.length} variant(s) -> ${Number(price).toFixed(2)}`
      : `PARTIAL/FAILED: updated ${verified.length}/${variants.length}, failed ${failed.length + verifyFailed.length}`;
    return { ok, product_url: url, product_id: product.id,
      variant_id: String(variants[0].id), variant_ids: variants.map((v) => String(v.id)),
      updated_variants: verified, failed_variants: failed, verification_errors: verifyFailed,
      old_price: variants[0].price, old_prices: oldPrices, new_price: price,
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
