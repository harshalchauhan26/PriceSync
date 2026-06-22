// Supabase Postgres pool (same tables as the Python app).
import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// query(text, params) -> rows
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
