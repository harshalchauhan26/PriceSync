// Resolves the tenant context for a request, right after sec.guard()
// establishes WHO the caller is. Ordinary tenant users (viewer/admin/owner)
// get req.mboId set from their session; a platform super_admin has no
// tenant (mbo_id is NULL by construction) and is deliberately kept OUT of
// the ordinary tenant routes — they use the separate /api/superadmin/*
// routes (gated by sec.superAdminOnly) instead, which resolve their own
// :mboId per request without ever writing it back into the session.
export function resolveTenant(req, res, next) {
  if (req.session.role === "super_admin") {
    return res.status(403).json({ error: "super_admin has no tenant — use /api/superadmin/*" });
  }
  if (req.session.mboId == null) {
    return res.status(401).json({ error: "no tenant assigned to this account" });
  }
  req.mboId = req.session.mboId;
  next();
}
