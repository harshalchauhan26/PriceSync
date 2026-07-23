// PriceSync home-IP fetch relay — plain Node, no dependencies (uses the
// built-in fetch). Runs on this machine (a real Indian residential/ISP IP)
// and is exposed to the internet via a Cloudflare Tunnel, so the deployed
// Render app can route IP-banned/geo-priced brands through it instead of a
// Cloudflare Worker (whose edge egress isn't India either).
//
// Same wire contract as web/relay/worker.js: GET <url>/?url=<target> with
// Authorization: Bearer <RELAY_SECRET>, host must be on ALLOWED_HOSTS. Reuse
// the SAME secret in Render's FETCH_RELAY_SECRET and this process's
// LOCAL_RELAY_SECRET so the two are interchangeable to engine.js's Fetcher.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dotenv dependency — this script has no node_modules
// of its own). Only handles simple KEY=VALUE lines, good enough for our vars.
function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(path.resolve(__dirname, "../../.env"));

const PORT = parseInt(process.env.LOCAL_RELAY_PORT || "8099", 10);
const SECRET = (process.env.LOCAL_RELAY_SECRET || process.env.FETCH_RELAY_SECRET || "").trim();
const ALLOWED_HOSTS = (process.env.LOCAL_RELAY_ALLOWED_HOSTS ||
  "anitadongre.com,saakshakinni.com,labelanushree.com,mymoledro.com")
  .split(",").map((s) => s.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);

if (!SECRET) {
  console.error("LOCAL_RELAY_SECRET (or FETCH_RELAY_SECRET) is not set — refusing to start an unauthenticated relay.");
  process.exit(1);
}

const FORWARD_HEADERS = ["user-agent", "accept", "accept-language", "upgrade-insecure-requests",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "referer", "cookie"];

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let reqUrl;
  try { reqUrl = new URL(req.url, `http://localhost:${PORT}`); } catch { return send(res, 400, "bad request"); }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${SECRET}`) return send(res, 401, "unauthorized");

  const target = reqUrl.searchParams.get("url");
  if (!target) return send(res, 400, "missing url param");
  let t;
  try { t = new URL(target); } catch { return send(res, 400, "bad url"); }
  if (t.protocol !== "https:" && t.protocol !== "http:") return send(res, 400, "bad scheme");

  const host = t.hostname.toLowerCase().replace(/^www\./, "");
  // 400 (not 403) so the caller's 403-backoff never retries a config error —
  // mirrors web/relay/worker.js exactly.
  if (!ALLOWED_HOSTS.includes(host)) return send(res, 400, "host not allowed");

  const fwd = {};
  for (const h of FORWARD_HEADERS) { const v = req.headers[h]; if (v) fwd[h] = v; }

  let resp;
  try {
    resp = await fetch(t.toString(), { headers: fwd, redirect: "follow" });
  } catch (e) {
    return send(res, 502, "relay fetch failed: " + e.message);
  }
  const noBody = resp.status === 204 || resp.status === 304;
  const body = noBody ? Buffer.alloc(0) : Buffer.from(await resp.arrayBuffer());
  const elapsed = Date.now() - started;
  console.log(`[local-relay] ${req.method} ${host} -> ${resp.status} (${body.length}B, ${elapsed}ms) final=${resp.url}`);
  res.writeHead(resp.status, {
    "content-type": resp.headers.get("content-type") || "text/html",
    "x-relay-final-url": resp.url || "",
    "x-relay-redirected": String(resp.redirected || false),
    "x-relay-set-cookie": (resp.headers.get("set-cookie") || "").slice(0, 500),
  });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`[local-relay] listening on http://localhost:${PORT} — allowed hosts: ${ALLOWED_HOSTS.join(", ")}`);
});
