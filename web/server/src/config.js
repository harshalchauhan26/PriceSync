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
  googleClientId: (e.GOOGLE_CLIENT_ID || "").trim(),
  adminEmail: (e.ADMIN_EMAIL || "admin@pricesync.local").toLowerCase(),
  adminPassword: e.ADMIN_PASSWORD || "admin",
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
