-- Fixes diyarajvvir.in duplicate-row price drift, caused by the app's
-- "commit import" feature re-applying stale import_catalog data over
-- products.base_price that had already been corrected directly.
--
-- 1. For each Studio East listing (mbo_url) that exists as two product rows,
--    copy the known-good USD price onto whichever sibling still shows the
--    stale import_catalog garbage.
-- 2. Sync import_catalog to match the now-correct products values for every
--    currently-staged key, so the next "commit import" click can't revert
--    this again.

WITH dup_urls AS (
  SELECT mbo_url FROM products
  WHERE mbo_id = 1 AND brand = 'diyarajvvir.in' AND mbo_url IS NOT NULL AND mbo_url <> ''
  GROUP BY mbo_url HAVING COUNT(*) > 1
), good AS (
  SELECT mbo_url, base_price AS good_price FROM products
  WHERE mbo_id = 1 AND brand = 'diyarajvvir.in' AND base_currency = 'USD'
    AND mbo_url IN (SELECT mbo_url FROM dup_urls)
)
UPDATE products p
SET base_price = good.good_price, base_currency = 'USD', base_usd = good.good_price
FROM good
WHERE p.mbo_id = 1 AND p.mbo_url = good.mbo_url
  AND (p.base_currency IS DISTINCT FROM 'USD' OR p.base_price IS DISTINCT FROM good.good_price);

-- Sync the staging table so it can't silently overwrite products again.
UPDATE import_catalog c
SET base_price = p.base_price, base_currency = p.base_currency
FROM products p
WHERE p.mbo_id = 1 AND c.mbo_id = 1 AND c.key = p.key
  AND (c.base_price IS DISTINCT FROM p.base_price OR c.base_currency IS DISTINCT FROM p.base_currency);

-- Verify after running:
-- SELECT mbo_url, array_agg(base_price), array_agg(base_currency)
--   FROM products WHERE mbo_id=1 AND brand='diyarajvvir.in' AND mbo_url IS NOT NULL
--   GROUP BY mbo_url HAVING count(*) > 1;
