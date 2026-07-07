# PriceSync fetch relay (Cloudflare Worker, free)

anitadongre.com and saakshakinni.com ban the Render server's IP, so the
deployed pipeline can't fetch them directly. This tiny Worker fetches those
pages from Cloudflare's network instead; the tracker routes only the brands on
its `local_only_brands` list through it. Free tier allows 100,000 requests/day
— a full run of both brands uses ~400.

## Deploy (dashboard, ~10 minutes, no CLI)

1. Create a free account at https://dash.cloudflare.com (no domain needed).
2. **Workers & Pages → Create → Worker**, name it `pricesync-relay`, Deploy.
3. **Edit code**, replace the hello-world with the contents of `worker.js`,
   then **Deploy**.
4. **Settings → Variables and Secrets**, add:
   - `RELAY_SECRET` (type *Secret*) — a long random string, e.g. run
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `ALLOWED_HOSTS` (type *Text*) — `anitadongre.com,saakshakinni.com`
5. Copy the worker URL, e.g. `https://pricesync-relay.<your-account>.workers.dev`.

## Point Render at it

In the Render service → **Environment**, add and redeploy:

```
FETCH_RELAY_URL=https://pricesync-relay.<your-account>.workers.dev
FETCH_RELAY_SECRET=<same value as RELAY_SECRET>
```

## Verify

- `GET /api/fetch/local_only` on the app should return `"relay_configured": true`.
- Run the pipeline for one of the two brands; rows should come back
  matched/mismatch instead of `Fetch Error` or skipped.
- Quick manual check:
  `curl -H "Authorization: Bearer <secret>" "https://pricesync-relay.<acct>.workers.dev/?url=https%3A%2F%2Fsaakshakinni.com%2Fproduct%2Fseria-dress%2F"`
  should return the product HTML.

## Behaviour matrix

| Where the run happens | FETCH_RELAY_URL set? | local-only brands are… |
|---|---|---|
| Render (cloud) | yes | fetched through the relay |
| Render (cloud) | no  | skipped (protects good data) |
| local machine  | –   | fetched directly (local IP is fine) |

## CLI alternative

```
cd web/relay
npx wrangler login
npx wrangler secret put RELAY_SECRET
npx wrangler deploy
```
