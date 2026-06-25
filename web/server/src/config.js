// Central config — loads the SAME .env as the Python app (repo root).
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// web/server/src -> repo root is three levels up
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const e = process.env;

export const config = {
  databaseUrl: e.SUPABASE_DB_URL ||
    (e.SUPABASE_PROJECT_REF && e.SUPABASE_DB_PASSWORD
      ? `postgresql://postgres:${encodeURIComponent(e.SUPABASE_DB_PASSWORD)}@db.${e.SUPABASE_PROJECT_REF}.supabase.co:${e.SUPABASE_DB_PORT || 5432}/postgres`
      : ""),
  secret: e.SECRET_KEY || "dev-insecure-change-me",
  adminEmail: (e.ADMIN_EMAIL || "admin@pricesync.local").toLowerCase(),
  adminPassword: e.ADMIN_PASSWORD || "admin",
  // Render/Heroku-style hosts inject PORT and require binding 0.0.0.0. Honor that
  // automatically so cloud deploys pass the health check (otherwise the new build
  // fails and the platform keeps serving the previous, stale deploy). NODE_PORT
  // wins locally (PORT=8080 in .env belongs to the Python/Flask app); PORT is used
  // only on cloud where NODE_PORT isn't set.
  host: e.NODE_HOST || ((e.PORT && !e.NODE_PORT) || e.HOST === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"),
  port: parseInt(e.NODE_PORT || e.PORT || "8090", 10),
  // True on Render/Heroku-style hosts (PORT injected, NODE_PORT absent) or when
  // NODE_ENV=production. Drives HTTPS-only "secure" session cookies — never on
  // locally, where the browser would otherwise drop the cookie over plain http.
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

if (!config.databaseUrl) {
  console.error("[MBO] No Supabase connection. Set SUPABASE_DB_URL in .env");
}
