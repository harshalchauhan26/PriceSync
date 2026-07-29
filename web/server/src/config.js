import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const e = process.env;

export const config = {
  databaseUrl: e.SUPABASE_DB_URL ||
    (e.SUPABASE_PROJECT_REF && e.SUPABASE_DB_PASSWORD
      ? `postgresql://postgres:${encodeURIComponent(e.SUPABASE_DB_PASSWORD)}@db.${e.SUPABASE_PROJECT_REF}.supabase.co:${e.SUPABASE_DB_PORT || 5432}/postgres`
      : ""),
  secret: e.SECRET_KEY || "dev-insecure-change-me",
  fetchProxyUrl: (e.FETCH_PROXY_URL || "").trim(),
  fetchRelayUrl: (e.FETCH_RELAY_URL || "").trim().replace(/\/+$/, ""),
  fetchRelaySecret: (e.FETCH_RELAY_SECRET || "").trim(),
  googleClientId: (e.GOOGLE_CLIENT_ID || "").trim(),
  // Legacy/back-compat only — no longer used to seed anything (see
  // superAdminEmail below). Kept so an old .env with these set doesn't
  // throw on a missing key.
  adminEmail: (e.ADMIN_EMAIL || "admin@pricesync.local").toLowerCase(),
  adminPassword: e.ADMIN_PASSWORD || "admin",
  // Bootstraps the platform SUPER-ADMIN account (mbo_id NULL, cross-tenant
  // support role) — deliberately a SEPARATE env var from ADMIN_EMAIL/
  // ADMIN_PASSWORD (which used to seed a tenant owner pre-multi-tenancy).
  // BLANK (default) = no super-admin seeding at boot at all — this must
  // never silently repurpose an existing tenant-owner login. Incident
  // 2026-07-23: seeding used ADMIN_EMAIL, which was still the user's daily
  // owner login for Tenant 1; ensureUsers()'s per-boot backfill kept
  // re-assigning it back to a tenant, and seedSuperAdmin kept converting it
  // back to super_admin — flapping between roles on every restart and
  // breaking the client (which has no super_admin UI). Set BOTH vars only
  // for a NEW, dedicated support email, never an email you also use as a
  // tenant's owner.
  superAdminEmail: (e.SUPERADMIN_EMAIL || "").trim().toLowerCase(),
  superAdminPassword: e.SUPERADMIN_PASSWORD || "",
  // When "1", seedSuperAdmin resets an EXISTING super-admin's password to
  // SUPERADMIN_PASSWORD on boot (a clean, deliberate rotation). Unset it
  // again afterwards.
  seedOwnerResetPassword: e.SEED_OWNER_RESET_PASSWORD === "1",
  maxUploadMb: Math.max(1, parseInt(e.MAX_UPLOAD_MB || "16", 10) || 16),
  host: e.NODE_HOST || ((e.PORT && !e.NODE_PORT) || e.HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"),
  port: parseInt(e.NODE_PORT || e.PORT || "8090", 10),
  isCloud: ((!!e.PORT && !e.NODE_PORT) || e.NODE_ENV === "production"),
  smtp: {
    host: e.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(e.SMTP_PORT || "587", 10),
    user: e.SMTP_USER || "",
    pass: e.SMTP_PASS || "",
    // MAIL_FROM first: with an HTTPS provider there's no SMTP_USER to fall back
    // on, and every provider rejects a send with an empty From.
    from: e.MAIL_FROM || e.SMTP_FROM || e.SMTP_USER || "",
    to: e.ALERT_TO || "",
  },
  // HTTPS email APIs, used INSTEAD of SMTP when a key is present.
  //
  // Why this exists: Render's FREE plan blocks all outbound traffic to SMTP
  // ports 25/465/587 (policy change 2025-09-26), so nodemailer can never
  // connect to smtp.gmail.com there — every send died with "Connection
  // timeout" while the credentials were perfectly valid. These providers send
  // over HTTPS/443, which is not blocked, so mail works on the free plan.
  // Upgrading Render to any paid instance also fixes SMTP (port 25 stays
  // blocked on every plan; 465/587 open up on paid) — then leave these unset.
  //
  // Set exactly ONE key. Precedence if several are set: Resend, Brevo, SendGrid.
  // Detection is deliberately NOT dependent on getting the variable name exactly
  // right. Provider API keys have unmistakable prefixes, so any env var holding
  // one is recognised whatever it's called — a key pasted as BREVO_KEY,
  // BREVO_SMTP_KEY or MAIL_KEY still works. Exact names are still preferred and
  // checked first; prefix scanning is only the fallback.
  //   Brevo: xkeysib-…   Resend: re_…   SendGrid: SG.…
  mail: mailKeys(e),
  // Product count at or above which a run ALSO sends the "started" and "50%"
  // notices. Below it, a run sends only the completion mail (which carries the
  // sheets) — a small run finishes quickly enough that progress mail is noise,
  // and on a free plan capped per day those sends are better spent elsewhere.
  mailProgressMin: Math.max(0, parseInt(e.MAIL_PROGRESS_MIN || "2000", 10) || 2000),
  // Reject a fetched price whose currency isn't the one the fetch requested,
  // instead of converting it and comparing anyway (see pipeline.js finalizeOne).
  // ON by default: a wrong-currency comparison is silent and looks exactly like
  // real price drift. Set STRICT_FETCH_CURRENCY=0 to fall back to the old
  // convert-and-compare behaviour if a brand ever needs it.
  strictFetchCurrency: e.STRICT_FETCH_CURRENCY !== "0",
};

function mailKeys(e) {
  const trim = (v) => String(v || "").trim();
  // Which env var supplied each key, for the diagnostics readout — knowing the
  // name is what turns "still says smtp" into a five-second fix.
  const source = {};
  const byPrefix = (prefix, nameRe) => {
    for (const [k, v] of Object.entries(e)) {
      const val = trim(v);
      if (!val) continue;
      if (val.startsWith(prefix) || (nameRe.test(k) && /KEY|TOKEN|SECRET/i.test(k) && val.length > 20)) {
        source[prefix] = k;
        return val;
      }
    }
    return "";
  };
  const pick = (exactName, prefix, nameRe) => {
    const exact = trim(e[exactName]);
    if (exact) { source[prefix] = exactName; return exact; }
    return byPrefix(prefix, nameRe);
  };
  const resendKey = pick("RESEND_API_KEY", "re_", /RESEND/i);
  const brevoKey = pick("BREVO_API_KEY", "xkeysib-", /BREVO/i);
  const sendgridKey = pick("SENDGRID_API_KEY", "SG.", /SENDGRID/i);
  return { resendKey, brevoKey, sendgridKey,
    keySource: source["re_"] || source["xkeysib-"] || source["SG."] || null };
}

const problems = [];
if (!config.databaseUrl) problems.push("SUPABASE_DB_URL (or SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD) is required");
if (config.isCloud && config.secret === "dev-insecure-change-me") problems.push("SECRET_KEY must be a long random hex in production (sessions are insecure otherwise)");
if (problems.length) {
  console.error("[MBO] CONFIG ERROR:\n  - " + problems.join("\n  - "));
  if (!config.databaseUrl) process.exit(1);
}
