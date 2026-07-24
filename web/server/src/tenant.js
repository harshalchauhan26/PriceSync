import { one } from "./db.js";

// Cache MBO status briefly so a suspend takes effect on the next request
// within seconds, without hitting the DB on every single API call — same
// tradeoff/TTL as security.js's liveIdentity cache.
const STATUS_CACHE = new Map();
const STATUS_TTL = 10_000;
async function liveStatus(mboId) {
  const c = STATUS_CACHE.get(mboId);
  if (c && c.exp > Date.now()) return c.status;
  const row = await one("SELECT status FROM mbo WHERE id=$1", [mboId]);
  const status = row ? row.status : null;
  STATUS_CACHE.set(mboId, { status, exp: Date.now() + STATUS_TTL });
  return status;
}
export const clearStatusCache = () => STATUS_CACHE.clear();

// Resolves the tenant context for a request, right after sec.guard()
// establishes WHO the caller is. Ordinary tenant users (viewer/admin/owner)
// get req.mboId set from their session; a platform super_admin has no
// tenant (mbo_id is NULL by construction) and is deliberately kept OUT of
// the ordinary tenant routes — they use the separate /api/superadmin/*
// routes (gated by sec.superAdminOnly) instead, which resolve their own
// :mboId per request without ever writing it back into the session.
// Express 4 doesn't await middleware or catch a rejected promise from one —
// an uncaught error here would hang the request instead of 500ing it, so
// (unlike the route handlers, which go through the wrap() helper) this
// middleware catches its own DB error.
export async function resolveTenant(req, res, next) {
  if (req.session.role === "super_admin") {
    return res.status(403).json({ error: "super_admin has no tenant — use /api/superadmin/*" });
  }
  if (req.session.mboId == null) {
    return res.status(401).json({ error: "no tenant assigned to this account" });
  }
  try {
    // Defense-in-depth: a session issued before a super-admin suspends this
    // MBO must lose access on its very next request, not just at the next login.
    if ((await liveStatus(req.session.mboId)) !== "active") {
      return res.status(403).json({ error: "this MBO has been suspended" });
    }
  } catch (e) {
    return res.status(500).json({ error: "tenant status check failed" });
  }
  req.mboId = req.session.mboId;
  next();
}
