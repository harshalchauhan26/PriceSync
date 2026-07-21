// Auth-gate tests. Sets the allowlist env BEFORE importing config/security
// (node runs each test file in its own process, so this env is isolated).
process.env.ALLOWED_SIGNUP_DOMAINS = "growify.in, example.com";
process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || "postgresql://u:p@localhost:5432/db";

import { test } from "node:test";
import assert from "node:assert/strict";
const { signupAllowed } = await import("../src/security.js");

test("signupAllowed: only allowlisted domains may self-register", () => {
  assert.equal(signupAllowed("harshal@growify.in"), true);
  assert.equal(signupAllowed("someone@example.com"), true);
  assert.equal(signupAllowed("attacker@evil.com"), false);
  assert.equal(signupAllowed("no-at-sign"), false);
  assert.equal(signupAllowed(""), false);
  assert.equal(signupAllowed(null), false);
  assert.equal(signupAllowed("MixedCase@GROWIFY.IN"), true);
});
