// Admin-provisioned tenant onboarding (per the multi-tenant design: no
// public self-serve signup — a platform super-admin runs this to create a
// new MBO + its first owner login). Safe to re-run: the mbo slug is unique,
// and creating a user is idempotent (createUser no-ops on a conflicting
// email) — just fails loudly if the slug or owner email is already taken.
//
// Usage:
//   node scripts/create-tenant.mjs --slug=acme --name="Acme Boutique" \
//     --owner-email=owner@acme.com --owner-password="a-strong-password"
import { initStore } from "../src/store.js";
import { createUser, getUser } from "../src/security.js";
import { pool } from "../src/db.js";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const slug = String(args.slug || "").trim().toLowerCase();
const name = String(args.name || "").trim();
const ownerEmail = String(args["owner-email"] || "").trim().toLowerCase();
const ownerPassword = String(args["owner-password"] || "");

if (!slug || !name || !ownerEmail || !ownerPassword) {
  console.error(
    "Usage: node scripts/create-tenant.mjs --slug=<unique-slug> --name=\"<MBO name>\" " +
    "--owner-email=<email> --owner-password=<password>"
  );
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error("--slug must be lowercase letters/digits/hyphens only (e.g. 'acme-boutique')");
  process.exit(1);
}
if (ownerPassword.length < 8) {
  console.error("--owner-password must be at least 8 characters");
  process.exit(1);
}

await initStore();

if (await getUser(ownerEmail)) {
  console.error(`A user with email ${ownerEmail} already exists — pick a different owner email or use the existing account.`);
  process.exit(1);
}

const existing = await pool.query("SELECT id FROM mbo WHERE slug=$1", [slug]);
if (existing.rows.length) {
  console.error(`A tenant with slug '${slug}' already exists (id=${existing.rows[0].id}).`);
  process.exit(1);
}

const inserted = await pool.query(
  "INSERT INTO mbo (slug, name) VALUES ($1,$2) RETURNING id, slug, name, created_at",
  [slug, name]
);
const mbo = inserted.rows[0];
const owner = await createUser(ownerEmail, ownerPassword, "owner", mbo.id);

console.log("Tenant created:");
console.log(`  id=${mbo.id} slug=${mbo.slug} name="${mbo.name}"`);
console.log(`  owner: ${owner.email} (role=owner, mbo_id=${mbo.id})`);
console.log("\nNext steps for this tenant's owner:");
console.log("  1. Log in and set up the Shopify integration (Integrations page).");
console.log("  2. Import their product sheet (Pipeline page).");
console.log("  3. Configure any brand-specific quirks (Brand Rules panel) as needed.");

await pool.end();
