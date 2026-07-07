// PriceSync fetch relay — Cloudflare Worker (free tier).
// The tracker's cloud server is IP-banned by a couple of brand sites; this
// worker fetches those pages from Cloudflare's network instead and passes the
// body + status straight through. Locked down so it is NOT an open proxy:
// requests need the shared RELAY_SECRET and the target host must be on
// ALLOWED_HOSTS.
//
// Vars (Worker Settings -> Variables):
//   RELAY_SECRET   long random string; same value goes in Render's FETCH_RELAY_SECRET
//   ALLOWED_HOSTS  comma list, e.g. "anitadongre.com,saakshakinni.com"
export default {
  async fetch(req, env) {
    const auth = req.headers.get("authorization") || "";
    if (!env.RELAY_SECRET || auth !== `Bearer ${env.RELAY_SECRET}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const target = new URL(req.url).searchParams.get("url");
    if (!target) return new Response("missing url param", { status: 400 });
    let t;
    try { t = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
    if (t.protocol !== "https:" && t.protocol !== "http:") {
      return new Response("bad scheme", { status: 400 });
    }
    const allowed = (env.ALLOWED_HOSTS || "").split(",")
      .map((s) => s.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);
    const host = t.hostname.toLowerCase().replace(/^www\./, "");
    // 400 (not 403) so the tracker's 403-backoff never retries a config error.
    if (!allowed.includes(host)) return new Response("host not allowed", { status: 400 });

    const fwd = new Headers();
    for (const h of ["user-agent", "accept", "accept-language", "upgrade-insecure-requests",
      "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user"]) {
      const v = req.headers.get(h);
      if (v) fwd.set(h, v);
    }
    let resp;
    try {
      resp = await fetch(t.toString(), { headers: fwd, redirect: "follow" });
    } catch (e) {
      return new Response("relay fetch failed: " + e.message, { status: 502 });
    }
    if (resp.status === 204 || resp.status === 304) return new Response(null, { status: resp.status });
    return new Response(await resp.arrayBuffer(), {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") || "text/html",
        // where the origin actually landed us after redirects — lets the
        // tracker side diagnose geo/bot redirects without guessing
        "x-relay-final-url": resp.url || "",
        "x-relay-redirected": String(resp.redirected || false),
      },
    });
  },
};
