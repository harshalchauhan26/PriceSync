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

// Back off on 429/5xx instead of failing the row.
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

// GraphQL Admin call with cost-aware throttle retry. Throttling arrives as an
// HTTP-200 response carrying a THROTTLED error plus throttleStatus, so it is
// handled here rather than in shopReq (which covers transport-level 429/5xx).
async function gql(endpoint, headers, query, variables) {
  for (let attempt = 0; ; attempt++) {
    const r = await shopReq(() => axios.post(endpoint, { query, variables }, { headers, timeout: 30000 }));
    const errors = r.data?.errors || [];
    const throttled = errors.some((e) => e.extensions?.code === "THROTTLED");
    if (!throttled) {
      if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
      return r.data.data;
    }
    if (attempt >= RETRY_LIMIT) throw new Error("throttled by Shopify");
    const cost = r.data?.extensions?.cost;
    const need = (cost?.requestedQueryCost || 50) - (cost?.throttleStatus?.currentlyAvailable || 0);
    const rate = cost?.throttleStatus?.restoreRate || 50;
    await new Promise((res) => setTimeout(res, Math.min(Math.max(need / rate, 1), 15) * 1000));
  }
}
const gidNum = (gid) => String(gid || "").split("/").pop();

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
  const endpoint = `https://${c.shop_domain}/admin/api/${ver}/graphql.json`;
  const headers = { "X-Shopify-Access-Token": c.access_token, "Content-Type": "application/json" };
  const run = (query, variables) => gql(endpoint, headers, query, variables);
  const fail = (msg, productId = null) => ({
    ok: false, product_url: url, product_id: productId, variant_id: ref.variantId || null,
    variant_ids: [], old_price: null, old_prices: [], new_price: price,
    update_status: msg, status: msg,
  });
  try {
    // 1 lookup + 1 bulk mutation per product, regardless of variant count.
    let productGid, targets;
    if (ref.variantId) {
      const d = await run(
        "query($id: ID!) { productVariant(id: $id) { id price product { id } } }",
        { id: `gid://shopify/ProductVariant/${ref.variantId}` });
      if (!d.productVariant) return fail(`variant ${ref.variantId} not found in store`);
      productGid = d.productVariant.product.id;
      targets = [d.productVariant];
    } else {
      const d = ref.productId
        ? await run("query($id: ID!) { product(id: $id) { id variants(first: 100) { nodes { id price } } } }",
          { id: `gid://shopify/Product/${ref.productId}` })
        : await run("query($handle: String!) { productByHandle(handle: $handle) { id variants(first: 100) { nodes { id price } } } }",
          { handle: ref.handle });
      const p = d.product || d.productByHandle;
      if (!p) return fail(`${label} not found in store`);
      targets = p.variants?.nodes || [];
      if (!targets.length) return fail(`${label} has no variants`, gidNum(p.id));
      productGid = p.id;
    }
    const variantIds = targets.map((v) => gidNum(v.id));
    const oldPrices = targets.map((v) => ({ variant_id: gidNum(v.id), old_price: v.price }));
    const common = {
      product_url: url, product_id: gidNum(productGid),
      variant_id: variantIds[0], variant_ids: variantIds,
      old_price: oldPrices[0].old_price, old_prices: oldPrices, new_price: price,
    };
    if (c.dry_run) {
      const variantLabel = ref.variantId ? `variant ${variantIds[0]}` : `all ${targets.length} variant(s)`;
      const msg = `DRY RUN: would set ${label} ${variantLabel} -> ${price}`;
      return { ok: true, ...common, update_status: msg, status: msg };
    }
    const m = await run(
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price } userErrors { field message } } }`,
      { productId: productGid, variants: targets.map((v) => ({ id: v.id, price: String(price) })) });
    const out = m.productVariantsBulkUpdate || {};
    const failed = (out.userErrors || []).map((e) => ({ variant_id: null, error: e.message }));
    const returned = out.productVariants || [];
    const verified = returned.filter((v) => Number(v.price) === Number(price))
      .map((v) => ({ variant_id: gidNum(v.id), price: v.price }));
    const verifyFailed = returned.filter((v) => Number(v.price) !== Number(price))
      .map((v) => ({ variant_id: gidNum(v.id), expected: price, found: v.price }));
    const ok = !failed.length && !verifyFailed.length && verified.length === variantIds.length;
    const msg = ok
      ? `updated all ${verified.length} variant(s) -> ${Number(price).toFixed(2)}`
      : `PARTIAL/FAILED: updated ${verified.length}/${variantIds.length}${failed.length ? ` — ${failed[0].error}` : ""}`;
    return { ok, ...common,
      updated_variants: verified, failed_variants: failed, verification_errors: verifyFailed,
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
