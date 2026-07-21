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
  adminEmail: (e.ADMIN_EMAIL || "admin@pricesync.local").toLowerCase(),
  adminPassword: e.ADMIN_PASSWORD || "admin",
  // Self-registration allowlist. Comma-separated email domains (e.g.
  // "growify.in,example.com") that may sign up via /api/register or Google.
  // EMPTY (default) = self-registration is CLOSED; the owner creates users
  // from the owner console. This stops anyone who can reach the URL from
  // registering a viewer and reading the whole catalog.
  allowedSignupDomains: (e.ALLOWED_SIGNUP_DOMAINS || "")
    .split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
  // When "1", seedOwner resets an EXISTING owner's password to ADMIN_PASSWORD
  // on boot (a clean, deliberate rotation). Unset it again afterwards.
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
    from: e.SMTP_FROM || e.SMTP_USER || "",
    to: e.ALERT_TO || "",
  },
};

const problems = [];
if (!config.databaseUrl) problems.push("SUPABASE_DB_URL (or SUPABASE_PROJECT_REF + SUPABASE_DB_PASSWORD) is required");
if (config.isCloud && config.secret === "dev-insecure-change-me") problems.push("SECRET_KEY must be a long random hex in production (sessions are insecure otherwise)");
if (problems.length) {
  console.error("[MBO] CONFIG ERROR:\n  - " + problems.join("\n  - "));
  if (!config.databaseUrl) process.exit(1);
}
