import crypto from 'node:crypto';
import bcrypt from "bcryptjs";
import { q, one } from "./db.js";
import { config } from "./config.js";

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC = new Set(["/api/login", "/api/register", "/api/health"]);
const ADMIN_ROLES = new Set(["admin", "owner"]);
export const ROLES = new Set(["viewer", "admin", "owner"]);
// Platform-level role, distinct from tenant roles above. A super_admin
// belongs to no tenant (mbo_id NULL) and is never subject to ADMIN_ROLES/
// isAdmin/isOwner tenant write-gating — it goes through superAdminOnly and
// the separate /api/superadmin/* routes instead.
export const PLATFORM_ROLES = new Set(["super_admin"]);

export const SESSIONS = new Map();
const ACTIVE_WINDOW = 300_000;
const FAILS = new Map(); const MAX_FAILS = 5; const LOCK_WINDOW = 600_000;

// Caches BOTH role and tenant assignment together (never just role) — a
// user reassigned off a tenant or demoted must lose access on their very
// next request, not just see a stale role with a stale mbo_id.
const IDENTITY_CACHE = new Map();
const IDENTITY_TTL = 10_000;
export async function liveIdentity(uid) {
  const c = IDENTITY_CACHE.get(uid);
  if (c && c.exp > Date.now()) return c;
  const u = await one("SELECT role, mbo_id FROM users WHERE id=$1", [uid]);
  const entry = { role: u ? u.role : null, mboId: u ? u.mbo_id : null, exp: Date.now() + IDENTITY_TTL };
  IDENTITY_CACHE.set(uid, entry);
  return entry;
}
export const clearRoleCache = () => IDENTITY_CACHE.clear();

// ---- users repo ----
export async function ensureUsers() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer', created_at TIMESTAMPTZ DEFAULT now())`);
  // Multi-tenant (MBO) foundation — Phase A: additive only. Every existing
  // user belongs to Tenant #1 (the pre-existing single-tenant production
  // data); mbo_id stays nullable here — NULL is reserved for the platform
  // super-admin account(s), not used by the backfill below.
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mbo_id BIGINT REFERENCES mbo(id)`);
  await q(`UPDATE users SET mbo_id=1 WHERE mbo_id IS NULL`);
}
// Global-by-email lookup — deliberately NOT tenant-scoped. Used for login,
// where the tenant isn't known yet (that's exactly what this discovers).
// Safe today because RLS isn't enabled until Phase D; once it is, this
// should be replaced with a call to the auth_lookup_user() SECURITY DEFINER
// function instead of punching a hole in the users RLS policy.
export const getUser = (email) => one("SELECT * FROM users WHERE email=$1", [String(email || "").toLowerCase().trim()]);
export async function createUser(email, password, role = "viewer", mboId = null) {
  const hash = await bcrypt.hash(password, 10);
  await q("INSERT INTO users(email,password_hash,role,mbo_id) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING",
    [email.toLowerCase().trim(), hash, role, mboId]);
  return getUser(email);
}
// Tenant-scoped: the caller (a tenant owner) can only ever affect a user
// who already belongs to their own tenant — a cross-tenant email target
// silently matches zero rows instead of acting on another tenant's user.
// Cross-tenant/support actions go through the separate superAdmin* variants.
export const setRole = (mboId, email, role) => q(
  "UPDATE users SET role=$1 WHERE email=$2 AND mbo_id=$3", [role, email.toLowerCase().trim(), mboId]);
export const deleteUser = (mboId, email) => q(
  "DELETE FROM users WHERE email=$1 AND mbo_id=$2", [email.toLowerCase().trim(), mboId]);
export const listUsers = (mboId) => q(
  "SELECT id,email,role,created_at FROM users WHERE mbo_id=$1 ORDER BY id", [mboId]);
export async function countUsers(mboId) {
  return Number((await one("SELECT COUNT(*) c FROM users WHERE mbo_id=$1", [mboId])).c);
}
// Unscoped variants for the platform super-admin cross-tenant support view
// (Phase E routes) — deliberately separate functions rather than an
// optional-mboId branch on the scoped ones above, so a scoped call site can
// never accidentally omit its mboId and fall through to unscoped behavior.
export const superAdminListUsers = () => q("SELECT id,email,role,mbo_id,created_at FROM users ORDER BY id");
export const superAdminSetRole = (email, role) => q(
  "UPDATE users SET role=$1 WHERE email=$2", [role, email.toLowerCase().trim()]);
export const superAdminDeleteUser = (email) => q(
  "DELETE FROM users WHERE email=$1", [email.toLowerCase().trim()]);
export function superAdminActiveSessions() {
  return activeSessionsUnfiltered();
}
export function verifyWerkzeug(password, encoded) {
  const [method, salt, expectedHex] = String(encoded || '').split('$');
  if (!method || !salt || !expectedHex) return false;
  let actual;
  if (method.startsWith('pbkdf2:')) {
    const [, digest = 'sha256', iterations = '260000'] = method.split(':');
    actual = crypto.pbkdf2Sync(String(password || ''), salt,
      Number(iterations), expectedHex.length / 2, digest);
  } else if (method.startsWith('scrypt:')) {
    const [, n = '32768', r = '8', p = '1'] = method.split(':');
    actual = crypto.scryptSync(String(password || ''), salt, expectedHex.length / 2, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024,
    });
  } else {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function verify(email, password) {
  const u = await getUser(email);
  if (!u) return null;
  const hash = String(u.password_hash || '');
  const valid = hash.startsWith('$2')
    ? await bcrypt.compare(password, hash)
    : verifyWerkzeug(password, hash);
  if (valid) return u;
  return null;
}
export async function setPassword(email, password) {
  const hash = await bcrypt.hash(password, 10);
  await q("UPDATE users SET password_hash=$1 WHERE email=$2",
    [hash, email.toLowerCase().trim()]);
}
// Seeds/rotates a TENANT's owner (mbo_id required). Not used for the
// platform bootstrap account anymore — see seedSuperAdmin below.
export async function seedOwner(mboId, email, password) {
  await ensureUsers();
  const u = await getUser(email);
  if (!u) { await createUser(email, password, "owner", mboId); return email + " (created)"; }
  let changed = false;
  if (u.role !== "owner" || u.mbo_id !== mboId) { await setRoleAndTenant(email, "owner", mboId); changed = true; }
  // Deliberate password rotation: seedOwner otherwise never touches an
  // existing owner's password, so a changed ADMIN_PASSWORD had no effect.
  // Guarded by SEED_OWNER_RESET_PASSWORD=1 so a normal reboot can't silently
  // reset the password back to the env value.
  if (config.seedOwnerResetPassword && password) {
    await setPassword(email, password); changed = true;
    return email + " (password reset)";
  }
  return changed ? email + ' (updated)' : null;
}
// Seeds/converts the platform super-admin bootstrap account
// (SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD, or ADMIN_EMAIL/ADMIN_PASSWORD for
// back-compat). If this email already exists as a tenant user (the historical
// case: it used to be Tenant 1's seeded owner), this CONVERTS it in place —
// role='super_admin', mbo_id=NULL — rather than creating a second account.
export async function seedSuperAdmin(email, password) {
  await ensureUsers();
  const u = await getUser(email);
  if (!u) { await createUser(email, password, "super_admin", null); return email + " (created as super_admin)"; }
  let changed = false;
  if (u.role !== "super_admin" || u.mbo_id !== null) {
    await setRoleAndTenant(email, "super_admin", null); changed = true;
  }
  if (config.seedOwnerResetPassword && password) {
    await setPassword(email, password); changed = true;
    return email + " (password reset)";
  }
  return changed ? email + ' (converted to super_admin)' : null;
}
// Internal helper: sets role + mbo_id together, unscoped by design — only
// called from the two seed* bootstrap functions above, never from a
// request-handling route (those use the scoped/superAdmin* exports).
async function setRoleAndTenant(email, role, mboId) {
  await q("UPDATE users SET role=$1, mbo_id=$2 WHERE email=$3", [role, mboId, email.toLowerCase().trim()]);
}

// ---- rate limit ----
// Use req.ip, which Express resolves correctly from the trust-proxy setting
// (1 hop on Render). The previous code read the LEFT-most X-Forwarded-For
// value, which the client fully controls — an attacker could rotate it to
// dodge the login lockout. Never trust a raw client-supplied XFF here.
// IP-based and deliberately tenant-agnostic: a brute-forcer doesn't know or
// care which tenant they're attacking.
export function ipOf(req) {
  return req.ip || "?";
}
export function isLocked(ip) {
  const now = Date.now();
  const f = (FAILS.get(ip) || []).filter((t) => now - t < LOCK_WINDOW);
  FAILS.set(ip, f); return f.length >= MAX_FAILS;
}
export const registerFail = (ip) => FAILS.set(ip, [...(FAILS.get(ip) || []), Date.now()]);
export const clearFails = (ip) => FAILS.delete(ip);

// ---- sessions ----
export function loginUser(req, user) {
  const sid = Math.random().toString(16).slice(2) + Date.now().toString(16);
  req.session.uid = user.id; req.session.email = user.email; req.session.role = user.role;
  req.session.mboId = user.mbo_id; req.session.sid = sid;
  SESSIONS.set(sid, { uid: user.id, email: user.email, role: user.role, mbo_id: user.mbo_id, ip: ipOf(req),
    ua: String(req.headers["user-agent"] || "").slice(0, 120), login_at: Date.now(), last_seen: Date.now() });
}
export function logoutUser(req) {
  if (req.session.sid) SESSIONS.delete(req.session.sid);
  req.session.destroy(() => {});
}
export function touch(req) {
  const s = SESSIONS.get(req.session.sid);
  if (s) { s.last_seen = Date.now(); s.ip = ipOf(req); }
}
function activeSessionsUnfiltered() {
  const now = Date.now();
  return [...SESSIONS.entries()].map(([sid, s]) => ({ ...s, sid: sid.slice(0, 8),
    active: (now - s.last_seen) < ACTIVE_WINDOW, idle_s: Math.floor((now - s.last_seen) / 1000),
    age_s: Math.floor((now - s.login_at) / 1000) })).sort((a, b) => b.last_seen - a.last_seen);
}
// Tenant-scoped: an owner only ever sees sessions belonging to their own
// tenant's users. Cross-tenant visibility is superAdminActiveSessions() only.
export function activeSessions(mboId) {
  return activeSessionsUnfiltered().filter((s) => s.mbo_id === mboId);
}
export const currentUser = (req) => req.session.uid
  ? { id: req.session.uid, email: req.session.email, role: req.session.role, mboId: req.session.mboId ?? null } : null;
export const isAdmin = (req) => ADMIN_ROLES.has(req.session.role);
export const isOwner = (req) => req.session.role === "owner";
export const isSuperAdmin = (req) => req.session.role === "super_admin";

// ---- middleware ----
export async function guard(req, res, next) {
  const p = req.path;
  if (PUBLIC.has(p)) return next();
  if (!req.session.uid) return res.status(401).json({ error: "authentication required" });
  try {
    const identity = await liveIdentity(req.session.uid);
    if (identity.role == null) { logoutUser(req); return res.status(401).json({ error: "authentication required" }); }
    if (req.session.role !== identity.role) req.session.role = identity.role;
    if (req.session.mboId !== identity.mboId) req.session.mboId = identity.mboId;
  } catch (e) { return res.status(500).json({ error: "auth check failed" }); }
  touch(req);
  if (WRITE.has(req.method) && !isAdmin(req) && !isSuperAdmin(req)) return res.status(403).json({ error: "admin role required" });
  next();
}
export function ownerOnly(req, res, next) {
  if (!isOwner(req)) return res.status(403).json({ error: "owner role required" });
  next();
}
// Gates the /api/superadmin/* routes. Deliberately separate from guard()'s
// write-gating — a super_admin has no mbo_id/tenant role at all, so it
// isn't "an admin" in the tenant sense and must never fall through to
// ordinary tenant routes (see tenant.js's resolveTenant, which 403s those).
export function superAdminOnly(req, res, next) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: "super_admin role required" });
  next();
}
