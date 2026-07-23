import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
export async function one(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

export async function ping() {
  try {
    await pool.query("SELECT 1");
    return { ok: true, msg: "connected" };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// Multi-tenant (MBO) query scope. `pool.query()` checks out a random
// connection per call, so a `SET LOCAL app.mbo_id` on one connection and a
// following query on another would silently miss each other — this holds a
// single checked-out client for the whole unit of work so the tenant
// context and every query inside `fn` always share one connection/transaction.
// `mboId == null` is used only by the platform super-admin path below, never
// by ordinary tenant code.
export async function withTenant(mboId, fn) {
  if (mboId == null) throw new Error("withTenant: mboId is required (use withSuperAdmin for cross-tenant access)");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(..., true) is transaction-scoped (like SET LOCAL) and
    // parameterized — safer than string-building the setting name/value.
    await client.query("SELECT set_config($1, $2, true)", ["app.mbo_id", String(mboId)]);
    const db = {
      q: (text, params = []) => client.query(text, params).then((r) => r.rows),
      one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
      client,
    };
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Cross-tenant (platform super-admin) access. Until Phase D creates the
// dedicated BYPASSRLS `mbo_superadmin` Postgres role, this reuses the same
// pool as an interim step — RLS isn't enabled yet, so there is nothing to
// bypass. Callers must still filter explicitly by mbo_id/brand where
// relevant; this only marks "no single tenant's context applies here."
export async function withSuperAdmin(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const db = {
      q: (text, params = []) => client.query(text, params).then((r) => r.rows),
      one: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
      client,
    };
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
