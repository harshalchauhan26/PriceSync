// Token encryption at rest (AES-256-GCM, key derived from SECRET_KEY).
import crypto from "node:crypto";
import { config } from "./config.js";

const key = crypto.createHash("sha256").update(config.secret).digest();
const P = "enc:";

export function encrypt(s) {
  if (!s) return s;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(s, "utf8"), c.final()]);
  return P + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(s) {
  if (!s || !s.startsWith(P)) return s;
  try {
    const b = Buffer.from(s.slice(P.length), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch { return ""; }
}
