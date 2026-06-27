// One-off region migration: copy ALL app data from the OLD Supabase project
// (Sydney) to a NEW one (us-east-1, next to Render). Pure Node + `pg` — no
// pg_dump / psql / Supabase CLI needed.
//
// Usage (from web/server):
//   OLD_DB_URL="postgresql://...sydney pooler..." \
//   NEW_DB_URL="postgresql://...us-east-1 pooler..." \
//   node migrate-region.mjs
//
// OLD_DB_URL defaults to SUPABASE_DB_URL from the repo .env if not given.
// Safe to re-run: every copy uses ON CONFLICT DO NOTHING, so existing rows in
// the new DB are left alone. The Express session table is intentionally skipped
// (sessions regenerate; users just log in again).

import pg from "pg";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const OLD = process.env.OLD_DB_URL || process.env.SUPABASE_DB_URL;
const NEW = process.env.NEW_DB_URL;
if (!OLD) { console.error("Set OLD_DB_URL (or SUPABASE_DB_URL in .env)."); process.exit(1); }
if (!NEW) { console.error("Set NEW_DB_URL to the new us-east-1 project's Session pooler URI."); process.exit(1); }
if (OLD === NEW) { console.error("OLD_DB_URL and NEW_DB_URL are identical — aborting."); process.exit(1); }

// Schema for the NEW project — must match security.js (users) + store.js (SCHEMA).
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer', created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY, key TEXT UNIQUE, mbo_url TEXT, url TEXT,
    platform TEXT, custom_regex TEXT, brand TEXT, base_price DOUBLE PRECISION,
    live_price DOUBLE PRECISION, currency TEXT, status TEXT DEFAULT '',
    state TEXT DEFAULT 'pending', delta DOUBLE PRECISION,
    decision TEXT DEFAULT 'pending', markup_pct DOUBLE PRECISION,
    custom_price DOUBLE PRECISION, ref TEXT DEFAULT 'live',
    final_price DOUBLE PRECISION, note TEXT, decided_at TEXT,
    shopify_status TEXT, shopify_at TEXT, rerun_status TEXT,
    rerun_at TEXT, updated_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_products_state ON products(state)`,
  `CREATE INDEX IF NOT EXISTS ix_products_brand ON products(brand)`,
  `CREATE TABLE IF NOT EXISTS import_catalog (
    key TEXT PRIMARY KEY, mbo_url TEXT, url TEXT, platform TEXT,
    custom_regex TEXT, brand TEXT, base_price DOUBLE PRECISION, imported_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_import_catalog_brand ON import_catalog(brand)`,
  `CREATE TABLE IF NOT EXISTS price_history (
    id BIGSERIAL PRIMARY KEY, key TEXT, url TEXT, brand TEXT,
    base_price DOUBLE PRECISION, live_price DOUBLE PRECISION,
    delta DOUBLE PRECISION, state TEXT, status TEXT, run_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS ix_price_history_key ON price_history(key, created_at)`,
  `CREATE TABLE IF NOT EXISTS review_history (
    id BIGSERIAL PRIMARY KEY, key TEXT, mbo_url TEXT, url TEXT,
    platform TEXT, brand TEXT, base_price DOUBLE PRECISION,
    live_price DOUBLE PRECISION, currency TEXT, delta DOUBLE PRECISION,
    status TEXT, markup_pct DOUBLE PRECISION, ref TEXT,
    final_price DOUBLE PRECISION, note TEXT, approved_by TEXT,
    approved_at TIMESTAMPTZ DEFAULT now(), shopify_status TEXT, shopify_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_review_history_brand ON review_history(brand)`,
  `CREATE TABLE IF NOT EXISTS integrations (
    brand TEXT PRIMARY KEY, shop_domain TEXT, access_token TEXT,
    api_version TEXT DEFAULT '2024-10', dry_run INTEGER DEFAULT 0, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
];

// Copy order respects nothing FK-wise (the app has no FKs) but we copy users +
// catalog first for tidiness. `conflict` is the unique column for idempotency.
const TABLES = [
  { name: "users", conflict: "email", seq: "id" },
  { name: "meta", conflict: "k" },
  { name: "integrations", conflict: "brand" },
  { name: "import_catalog", conflict: "key" },
  { name: "products", conflict: "key", seq: "id" },
  { name: "price_history", conflict: null, seq: "id" },
  { name: "review_history", conflict: null, seq: "id" },
];

const oldPool = new pg.Pool({ connectionString: OLD, max: 4 });
const newPool = new pg.Pool({ connectionString: NEW, max: 4 });

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function copyTable(t) {
  const src = await oldPool.query(`SELECT * FROM ${t.name}`);
  if (!src.rowCount) { console.log(`  ${t.name}: 0 rows`); return 0; }
  const cols = src.fields.map((f) => f.name);
  const colList = cols.map((c) => `"${c}"`).join(",");
  // Keep each multi-row INSERT well under Postgres' 65535-param limit.
  const perChunk = Math.max(1, Math.min(500, Math.floor(60000 / cols.length)));
  let inserted = 0;
  for (const rows of chunk(src.rows, perChunk)) {
    const params = []; const tuples = [];
    rows.forEach((r) => {
      const ph = cols.map((c) => { params.push(r[c]); return `$${params.length}`; });
      tuples.push(`(${ph.join(",")})`);
    });
    const conflict = t.conflict ? `ON CONFLICT(${t.conflict}) DO NOTHING` : "ON CONFLICT DO NOTHING";
    const res = await newPool.query(
      `INSERT INTO ${t.name}(${colList}) VALUES ${tuples.join(",")} ${conflict}`, params);
    inserted += res.rowCount;
  }
  console.log(`  ${t.name}: ${src.rowCount} read → ${inserted} inserted`);
  return inserted;
}

async function main() {
  console.log("Creating schema on NEW project…");
  for (const sql of DDL) await newPool.query(sql);

  console.log("Copying data OLD → NEW…");
  for (const t of TABLES) await copyTable(t);

  console.log("Resetting id sequences on NEW…");
  for (const t of TABLES.filter((t) => t.seq)) {
    await newPool.query(
      `SELECT setval(pg_get_serial_sequence('${t.name}','${t.seq}'),
        COALESCE((SELECT MAX(${t.seq}) FROM ${t.name}), 1),
        (SELECT COUNT(*) > 0 FROM ${t.name}))`);
  }

  console.log("\nDone. Now point Render's SUPABASE_DB_URL at the new project and redeploy.");
  await oldPool.end(); await newPool.end();
}

main().catch((e) => { console.error("Migration failed:", e); process.exit(1); });
