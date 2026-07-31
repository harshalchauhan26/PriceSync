// Unit tests for the base-price sheet parser. Pure function, no network, no DB.
//   node --test web/server/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseBaseSheet } from "../src/store.js";

const toBuf = (rows) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "s");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

test("parseBaseSheet accepts the header spellings a human actually types", () => {
  for (const [u, p] of [["URL", "Base Price"], ["Product URL", "New Base Price"],
    ["Designer Product URL", "Studio East Price"], ["Link", "Price"],
    ["  url  ", "base_price"], ["Product Link", "New Base"]]) {
    const { urlCol, priceCol, rows } = parseBaseSheet(toBuf([{ [u]: "https://x.com/products/a", [p]: 1200 }]));
    assert.equal(urlCol, u, `url header ${u}`);
    assert.equal(priceCol, p, `price header ${p}`);
    assert.equal(rows[0].base_price, 1200);
  }
});

test("parseBaseSheet: the price column never resolves to the URL column", () => {
  // "Product" matches BOTH header lists by containment. The URL match must
  // consume it first, or the sheet silently reads URLs as prices.
  const { urlCol, priceCol } = parseBaseSheet(toBuf([{ Product: "https://x.com/products/a", Price: 999 }]));
  assert.equal(urlCol, "Product");
  assert.equal(priceCol, "Price");
});

test("parseBaseSheet reads formatted prices and separates skip from error", () => {
  const { rows } = parseBaseSheet(toBuf([
    { URL: "https://x.com/products/a", "Base Price": "₹ 12,345" }, // formatted -> parsed
    { URL: "https://x.com/products/b", "Base Price": "" },              // blank -> skipped, NOT an error
    { URL: "https://x.com/products/c", "Base Price": "n/a" },           // junk -> error
    { URL: "", "Base Price": 500 },                                     // no URL -> error
  ]));
  assert.equal(rows[0].base_price, 12345);
  assert.equal(rows[0]._error, null);
  // A blank cell means "leave this baseline alone" — a full export with a few
  // cells filled in is the normal shape of this sheet, not a broken file.
  assert.match(rows[1]._error, /blank price/);
  assert.match(rows[2]._error, /not a valid price/);
  assert.match(rows[3]._error, /no URL/);
  // Row numbers are 1-based WITH the header, so they line up with what the
  // user sees in Excel when a row is reported as unmatched.
  assert.deepEqual(rows.map((r) => r.row), [2, 3, 4, 5]);
});

test("parseBaseSheet refuses a sheet it cannot understand rather than guessing", () => {
  assert.throws(() => parseBaseSheet(toBuf([{ Foo: "bar", Baz: 1 }])), /needs a URL column and a base price column/);
  assert.throws(() => parseBaseSheet(toBuf([{ URL: "https://x.com/a" }])), /needs a URL column and a base price column/);
});
