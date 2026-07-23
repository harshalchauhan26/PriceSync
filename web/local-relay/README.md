# PriceSync home-IP fetch relay (free, no credit card, no cloud VM)

anitadongre.com/saakshakinni.com IP-ban the Render server, and mymoledro.com
geo-inflates its price from a non-India IP (see the project memory notes) —
the existing `web/relay` Cloudflare Worker fixes the first two but Cloudflare's
own edge egress isn't India either, so it can't fix mymoledro or any brand not
explicitly special-cased in that Worker. This relay instead runs **on this
machine** (a real Indian residential IP, the same one the daily
`scripts/run-local-only.mjs` Task Scheduler job already uses) and is exposed to the
internet via a free Cloudflare Tunnel — no VM, no card, no ongoing cost.

Same wire contract as `web/relay/worker.js`: `GET <url>/?url=<target>` with
`Authorization: Bearer <secret>`, host must be on the allowlist. `engine.js`'s
`Fetcher` doesn't care which relay implementation is behind `FETCH_RELAY_URL`
— point it at this instead of the Worker.

## Run it

```
node web/local-relay/server.mjs
```

Reads `LOCAL_RELAY_PORT` (default 8099), `LOCAL_RELAY_SECRET` (falls back to
`FETCH_RELAY_SECRET`), `LOCAL_RELAY_ALLOWED_HOSTS` (default: anitadongre.com,
saakshakinni.com, labelanushree.com, mymoledro.com) from the repo-root `.env`.
No npm install needed — built-in `fetch`/`http` only.

## Expose it (Cloudflare Tunnel, free, no account needed for a quick test)

`web/local-relay/bin/cloudflared.exe` is a portable download (gitignored —
grab your own copy or reuse the one already here):

```
web/local-relay/bin/cloudflared.exe tunnel --url http://localhost:8099
```

It prints a random `https://<words>.trycloudflare.com` URL — that's your
`FETCH_RELAY_URL`. **This URL changes every time cloudflared restarts** —
fine for testing, but for anything you want to leave running unattended,
set up a **named tunnel** instead (one-time, needs a free Cloudflare login):

```
web/local-relay/bin/cloudflared.exe tunnel login          # opens a browser, authorize your CF account
web/local-relay/bin/cloudflared.exe tunnel create pricesync-relay
web/local-relay/bin/cloudflared.exe tunnel route dns pricesync-relay relay.<your-domain>   # needs a domain on Cloudflare
web/local-relay/bin/cloudflared.exe tunnel run pricesync-relay
```

Without a domain on Cloudflare, stick with the quick tunnel and just accept
that a restart means grabbing a new URL and updating Render's env var.

## Point Render at it

Service → Environment:

```
FETCH_RELAY_URL=<the trycloudflare.com or named-tunnel URL>
FETCH_RELAY_SECRET=<same value as this machine's LOCAL_RELAY_SECRET in .env>
```

## Verify

```
curl -H "Authorization: Bearer <secret>" "https://<tunnel-url>/?url=https%3A%2F%2Fwww.anitadongre.com%2Fgrassland-embroidered-saree---green-8909300033232.html"
```
should return the product HTML with the real INR price.

## Caveat

This only works while **this machine, the relay process, and the tunnel are
all running**. No cost, no card — but a real uptime dependency, unlike a paid
VM. If that trade-off stops working for you, revisit a proper India-region
host later.
