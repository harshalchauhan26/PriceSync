// Auth/tenancy role-gate tests — pure, no DB (node runs each test file in
// its own process; SUPABASE_DB_URL is stubbed since config.js requires one
// to be present at import time, but nothing here actually queries it).
process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@localhost:5432/db";

import { test } from "node:test";
import assert from "node:assert/strict";
const sec = await import("../src/security.js");

test("ROLES and PLATFORM_ROLES are disjoint — a role is tenant-scoped XOR platform-level", () => {
  for (const r of sec.ROLES) assert.equal(sec.PLATFORM_ROLES.has(r), false);
  for (const r of sec.PLATFORM_ROLES) assert.equal(sec.ROLES.has(r), false);
});

test("isAdmin/isOwner/isSuperAdmin read the session role, not tenant assignment", () => {
  const owner = { session: { role: "owner", mboId: 1 } };
  const admin = { session: { role: "admin", mboId: 1 } };
  const viewer = { session: { role: "viewer", mboId: 1 } };
  const superAdmin = { session: { role: "super_admin", mboId: null } };

  assert.equal(sec.isOwner(owner), true);
  assert.equal(sec.isAdmin(owner), true);
  assert.equal(sec.isSuperAdmin(owner), false);

  assert.equal(sec.isOwner(admin), false);
  assert.equal(sec.isAdmin(admin), true);
  assert.equal(sec.isSuperAdmin(admin), false);

  assert.equal(sec.isOwner(viewer), false);
  assert.equal(sec.isAdmin(viewer), false);
  assert.equal(sec.isSuperAdmin(viewer), false);

  assert.equal(sec.isOwner(superAdmin), false);
  assert.equal(sec.isAdmin(superAdmin), false);
  assert.equal(sec.isSuperAdmin(superAdmin), true);
});

test("superAdminOnly middleware 403s anyone but a super_admin", () => {
  const calls = [];
  const next = () => calls.push("next");
  const resFor = () => {
    const r = { statusCode: null, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  const ownerRes = resFor();
  sec.superAdminOnly({ session: { role: "owner" } }, ownerRes, next);
  assert.equal(ownerRes.statusCode, 403);
  assert.equal(calls.length, 0);

  const saRes = resFor();
  sec.superAdminOnly({ session: { role: "super_admin" } }, saRes, next);
  assert.equal(calls.length, 1);
});

test("activeSessions filters by mbo_id — one tenant never sees another's sessions", () => {
  sec.SESSIONS.set("sidA", { uid: 1, email: "a@tenant1.example", role: "owner", mbo_id: 1, last_seen: Date.now(), login_at: Date.now() });
  sec.SESSIONS.set("sidB", { uid: 2, email: "b@tenant2.example", role: "owner", mbo_id: 2, last_seen: Date.now(), login_at: Date.now() });
  try {
    const tenant1 = sec.activeSessions(1);
    assert.equal(tenant1.length, 1);
    assert.equal(tenant1[0].email, "a@tenant1.example");
    const tenant2 = sec.activeSessions(2);
    assert.equal(tenant2.length, 1);
    assert.equal(tenant2[0].email, "b@tenant2.example");
  } finally {
    sec.SESSIONS.delete("sidA"); sec.SESSIONS.delete("sidB");
  }
});
