// One-time migration paired with the rowToProduct key-generation fix
// (store.js): re-imports before that fix keyed products as `${rowIndex}|url`,
// so the same product landed under a different key every time its row moved
// in the sheet -- ON CONFLICT never matched, leaving a duplicate row behind
// instead of updating in place. Found live: 1,181 duplicate URLs.
//
//   node web/server/tools/dedupe-and-rekey-products.mjs --dry-run   # preview
//   node web/server/tools/dedupe-and-rekey-products.mjs             # apply
//
// Two steps, in order:
//   1. For every URL with more than one row, keep the most-recently-updated
//      one (verified against a random sample: either the rows are identical,
//      or the newer one reflects a real fix that landed since -- never the
//      other way around) and delete the rest.
//   2. Re-key every surviving row to match the new format (key = canonical
//      url), so the NEXT re-import actually updates in place instead of
//      creating fresh duplicates for the ~8,700 rows that were never
//      duplicated but still carry the old `idx|url` key.
//
// No FK constraints reference products(id) (checked live), so deleting a
// stale duplicate cannot orphan anything.
import { q, pool, ping } from "../src/db.js";

const MBO_ID = Number((process.argv.includes("--mbo") && process.argv[process.argv.indexOf("--mbo") + 1]) || 1);
const DRY = process.argv.includes("--dry-run");

async function main() {
  const p = await ping();
  if (!p.ok) { console.error("DB not reachable:", p.msg); process.exit(1); }

  const dupGroups = await q(
    `SELECT url, count(*)::int n, array_agg(id ORDER BY updated_at DESC, id DESC) ids
       FROM products WHERE mbo_id=$1 GROUP BY url HAVING count(*) > 1`, [MBO_ID]);
  const idsToDelete = dupGroups.flatMap((g) => g.ids.slice(1)); // keep ids[0] (newest), drop the rest

  console.log(`\n${dupGroups.length} duplicate URLs, ${idsToDelete.length} stale rows to delete.\n`);
  if (dupGroups.length) {
    console.log("Sample (first 5 groups):");
    dupGroups.slice(0, 5).forEach((g) => console.log(`  ${g.url}  (${g.n} rows, keeping id=${g.ids[0]}, deleting ${g.ids.slice(1).join(",")})`));
    console.log();
  }

  const rekeyCount = (await q(
    `SELECT count(*)::int c FROM products
      WHERE mbo_id=$1 AND key IS DISTINCT FROM COALESCE(NULLIF(url,''), mbo_url)`, [MBO_ID]))[0].c;
  console.log(`${rekeyCount} total rows will have their key normalized to the canonical URL (includes rows being deleted).\n`);

  if (DRY) { console.log("--dry-run: no changes written.\n"); await pool.end(); return; }

  if (idsToDelete.length) {
    const CH = 1000;
    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += CH) {
      const chunk = idsToDelete.slice(i, i + CH);
      const r = await q(`DELETE FROM products WHERE mbo_id=$1 AND id = ANY($2::bigint[])`, [MBO_ID, chunk]);
      deleted += chunk.length;
    }
    console.log(`Deleted ${deleted} stale duplicate rows.`);
  }

  const rekeyed = await q(
    `UPDATE products SET key = LEFT(COALESCE(NULLIF(url,''), mbo_url), 280)
      WHERE mbo_id=$1 AND key IS DISTINCT FROM LEFT(COALESCE(NULLIF(url,''), mbo_url), 280)
      RETURNING id`, [MBO_ID]);
  console.log(`Re-keyed ${rekeyed.length} rows to the canonical-URL key format.\n`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
