// Auth: users, bcrypt, sessions registry, rate-limit, guards (port of core/security.py).
import bcrypt from "bcryptjs";
import { q, one } from "./db.js";

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC = new Set(["/api/login", "/api/register", "/api/health"]);
const ADMIN_ROLES = new Set(["admin", "owner"]);

export const SESSIONS = new Map();          // sid -> {uid,email,role,ip,ua,login_at,last_seen}
const ACTIVE_WINDOW = 300_000;
const FAILS = new Map(); const MAX_FAILS = 5; const LOCK_WINDOW = 600_000;

// ---- users repo ----
export async function ensureUsers() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer', created_at TIMESTAMPTZ DEFAULT now())`);
}
export const getUser = (email) => one("SELECT * FROM users WHERE email=$1", [String(email || "").toLowerCase().trim()]);
export async function createUser(email, password, role = "viewer") {
  const hash = await bcrypt.hash(password, 10);
  await q("INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING",
    [email.toLowerCase().trim(), hash, role]);
  return getUser(email);
}
export const setRole = (email, role) => q("UPDATE users SET role=$1 WHERE email=$2", [role, email.toLowerCase().trim()]);
export const deleteUser = (email) => q("DELETE FROM users WHERE email=$1", [email.toLowerCase().trim()]);
export const listUsers = () => q("SELECT id,email,role,created_at FROM users ORDER BY id");
export async function countUsers() { return Number((await one("SELECT COUNT(*) c FROM users")).c); }
export async function verify(email, password) {
  const u = await getUser(email);
  if (u && await bcrypt.compare(password, u.password_hash)) return u;
  return null;
}
export async function seedOwner(email, password) {
  await ensureUsers();
  const u = await getUser(email);
  if (!u) { await createUser(email, password, "owner"); return email + " (created)"; }
  let changed = false;
  if (u.role !== "owner") { await setRole(email, "owner"); changed = true; }
  // Migrate non-bcrypt (werkzeug pbkdf2 from the Python app) -> bcrypt.
  if (!String(u.password_hash || "").startsWith("$2")) {
    const hash = await bcrypt.hash(password, 10);
    await q("UPDATE users SET password_hash=$1 WHERE email=$2", [hash, email.toLowerCase().trim()]);
    changed = true;
  }
  return changed ? email + " (updated)" : null;
}

// ---- rate limit ----
export function ipOf(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? String(xff).split(",")[0].trim() : req.ip) || "?";
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
  req.session.sid = sid;
  SESSIONS.set(sid, { uid: user.id, email: user.email, role: user.role, ip: ipOf(req),
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
export function activeSessions() {
  const now = Date.now();
  return [...SESSIONS.entries()].map(([sid, s]) => ({ ...s, sid: sid.slice(0, 8),
    active: (now - s.last_seen) < ACTIVE_WINDOW, idle_s: Math.floor((now - s.last_seen) / 1000),
    age_s: Math.floor((now - s.login_at) / 1000) })).sort((a, b) => b.last_seen - a.last_seen);
}
export const currentUser = (req) => req.session.uid
  ? { id: req.session.uid, email: req.session.email, role: req.session.role } : null;
export const isAdmin = (req) => ADMIN_ROLES.has(req.session.role);
export const isOwner = (req) => req.session.role === "owner";

// ---- middleware ----
export function guard(req, res, next) {
  const p = req.path;
  if (PUBLIC.has(p)) return next();
  if (!req.session.uid) return res.status(401).json({ error: "authentication required" });
  touch(req);
  if (WRITE.has(req.method) && !isAdmin(req)) return res.status(403).json({ error: "admin role required" });
  next();
}
export function ownerOnly(req, res, next) {
  if (!isOwner(req)) return res.status(403).json({ error: "owner role required" });
  next();
}
