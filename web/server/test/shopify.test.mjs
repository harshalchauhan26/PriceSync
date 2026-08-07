// Unit tests for fetchAllVariants — the cursor-pagination helper in shopify.js.
// No network, no DB, no real Shopify credentials required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAllVariants } from "../src/shopify.js";

const makeVariant = (n) => ({ id: `gid://shopify/ProductVariant/${n}`, price: "1000.00" });
const makePage = (offset, count, hasNextPage, cursor) => ({
  nodes: Array.from({ length: count }, (_, i) => makeVariant(offset + i + 1)),
  pageInfo: { hasNextPage, endCursor: hasNextPage ? cursor : null },
});

// --- single-page cases (<=100 variants) ---

test("50 variants — single page, no pagination", async () => {
  const run = async () => ({
    product: { id: "gid://shopify/Product/1", variants: makePage(0, 50, false, null) },
  });
  const result = await fetchAllVariants(run, { productId: "1", handle: "" });
  assert.equal(result.productGid, "gid://shopify/Product/1");
  assert.equal(result.variants.length, 50);
});

test("exactly 100 variants — single page, hasNextPage false", async () => {
  const run = async () => ({
    product: { id: "gid://shopify/Product/2", variants: makePage(0, 100, false, null) },
  });
  const result = await fetchAllVariants(run, { productId: "2", handle: "" });
  assert.equal(result.variants.length, 100);
});

// --- multi-page cases (>100 variants) ---

test("101 variants across two pages — all accumulated", async () => {
  let calls = 0;
  const run = async (query, vars) => {
    calls++;
    if (calls === 1) return { product: { id: "gid://shopify/Product/3", variants: makePage(0, 100, true, "c1") } };
    assert.equal(vars.after, "c1", "second call must pass the cursor from page 1");
    return { product: { id: "gid://shopify/Product/3", variants: makePage(100, 1, false, null) } };
  };
  const result = await fetchAllVariants(run, { productId: "3", handle: "" });
  assert.equal(result.variants.length, 101);
  assert.equal(calls, 2);
});

test("250 variants across three pages — cursors threaded correctly", async () => {
  const cursors = ["c1", "c2"];
  let calls = 0;
  const run = async (query, vars) => {
    calls++;
    if (calls === 1) return { product: { id: "gid://shopify/Product/4", variants: makePage(0, 100, true, "c1") } };
    assert.equal(vars.after, cursors[calls - 2], `page ${calls} must receive cursor from page ${calls - 1}`);
    const last = calls === 3;
    return { product: { id: "gid://shopify/Product/4", variants: makePage((calls - 1) * 100, last ? 50 : 100, !last, last ? null : "c2") } };
  };
  const result = await fetchAllVariants(run, { productId: "4", handle: "" });
  assert.equal(result.variants.length, 250);
  assert.equal(calls, 3);
});

// --- error / edge cases ---

test("product not found by id — returns null", async () => {
  const run = async () => ({ product: null });
  assert.equal(await fetchAllVariants(run, { productId: "999", handle: "" }), null);
});

test("product not found by handle — returns null", async () => {
  const run = async () => ({ productByHandle: null });
  assert.equal(await fetchAllVariants(run, { productId: "", handle: "missing-product" }), null);
});

test("handle-based lookup uses productByHandle query", async () => {
  let usedQuery = "";
  const run = async (query) => {
    usedQuery = query;
    return { productByHandle: { id: "gid://shopify/Product/5", variants: makePage(0, 3, false, null) } };
  };
  const result = await fetchAllVariants(run, { productId: "", handle: "my-lehenga" });
  assert.ok(usedQuery.includes("productByHandle"), "should use productByHandle query for handle lookup");
  assert.equal(result.productGid, "gid://shopify/Product/5");
  assert.equal(result.variants.length, 3);
});

test("id-based lookup uses product(id:) query", async () => {
  let usedQuery = "";
  const run = async (query) => {
    usedQuery = query;
    return { product: { id: "gid://shopify/Product/6", variants: makePage(0, 2, false, null) } };
  };
  await fetchAllVariants(run, { productId: "6", handle: "" });
  assert.ok(usedQuery.includes("product(id: $id)"), "should use product(id:) query for id lookup");
});

test("product with zero variants — returns empty array, not null", async () => {
  const run = async () => ({
    product: { id: "gid://shopify/Product/7", variants: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
  });
  const result = await fetchAllVariants(run, { productId: "7", handle: "" });
  assert.ok(result !== null, "result should not be null — product exists");
  assert.equal(result.variants.length, 0);
});
