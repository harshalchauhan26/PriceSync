# Brand fetch runbook — geo-pricing, routing, and what is actually verified

Written 2026-07-30. This exists so the reasoning below is not re-derived from
scratch next time a brand looks broken. Commits: `a81e4f6`, `7e86473`,
`6c86a11`, `6d3f03d`, `62e99eb`, `0cc2445`.

## The one idea that explains all of it

These stores do **not** ban the cloud server's IP. They price by **the country
the request asks for**, and each exposes a URL lever that sets it. A cloud run
was getting different numbers because it never asked for India, not because it
was blocked. Every "geo-inflation" and "USD conversion" theory before this was
wrong, and so was every fix built on them (local-only lists, the relay, a paid
proxy).

Corollary: prefer a URL lever over routing tricks. A lever works from any
egress; routing only moves the problem to a different IP.

## Current state

| Brand | Lever | Baseline | Cloud routing |
|---|---|---|---|
| mymoledro.com | `?country=IN` (Shopify Markets) | `base_price`, INR | direct |
| labelanushree.com | `?wcpbc-manual-country=IN` (WCPBC) | `base_price`, INR | direct |
| anitadongre.com | fetch host swapped to `us.anitadongre.com` | `base_usd`, USD | direct |
| saakshakinni.com | Woo Store API, INR-only | `base_usd` on 163 rows | direct |

Levers live in `DEFAULT_APPEND_PARAMS` / `DEFAULT_FETCH_HOSTS` in
`web/server/src/engine.js`. Both apply at **fetch time only** — `canonicalUrl`
strips everything in `FETCH_ONLY_PARAMS` before a URL is stored, because a fetch
param that once leaked into `products.url` corrupted a whole brand's rows.

`DEFAULT_LOCAL_ONLY_BRANDS` and `DEFAULT_CLOUD_SKIP_BRANDS` are both **empty**.
Every brand is fetched directly. The machinery stays for a site that genuinely
IP-blocks.

## Per-brand detail

### mymoledro.com — Shopify Markets
`?country=US` returns **339622.61** for the ₹275,000 sakura and **315678.43**
for lila-lehenga: byte-identical to what sat in the DB as "mismatch". So the
old ~1.235x was simply the US market price, and the decimals came from a market
price adjustment — rounding it would have produced a wrong integer, not a fix.
`?country=IN` returns the exact base from any IP. `/en-in/` 404s (no locale
routing). The old `mlveda_country=in` param was always dead: MLveda is
client-side JS and cannot touch a server fetch.

### labelanushree.com — WooCommerce "Price Based on Country" (WCPBC)
Not WOOCS, and not the WMC param the engine was sending. Lever is
`?wcpbc-manual-country=IN`; `=US` serves **$375** for the ₹34,000 Jade Lehenga,
again the exact stored value. Confirmed dead ends: `?currency=`,
`?woocs_current_currency=`, `?aelia_cs_currency=`, `?curcy=`, the `woocs` and
`aelia` cookies, `CF-IPCountry`, `X-Forwarded-For`.

Of its 312 failing rows, **309** were `currency mismatch: asked INR, page served
USD` and only **3** were HTTP 428 — and those 3 fetch fine locally at full pace,
so 428 was never the story.

### anitadongre.com — tracked on the US storefront, in USD
The US and Indian sites are **different prices, not a conversion**. Implied
INR/USD across 8 products: 71.97, 71.96, 56.87, 65.63, 72.00, 72.00, 59.79,
56.93 — a conversion would give one constant. So the US number cannot be derived
from the rupee baseline by any rate.

The brand is in `fetch_usd_brands`, which routes it to the `base_usd`
comparison in `finalizeOne` (unset `base_usd` self-seeds on first fetch, same as
saakshakinni). All 173 `products.url` values were rewritten to
`us.anitadongre.com`; `brand` stays `anitadongre.com` so vendor filters match,
and `base_price` keeps the rupee baseline, so this is reversible.

Expect ~18% `redirected off product page` on this brand vs ~14% on `www` — the
US store doesn't carry every Indian garment. Not a bug.

`detectCurrency` needed a fix for this: the US page prices in USD and declares
`priceCurrency=USD` but keeps `India ₹` in its country-switcher, and a
bare-symbol rupee test read that menu label as the page currency. A rupee symbol
now has to actually label a number (what the `Rs` branch always required), with
tags stripped first so `<span>₹</span>1,200` still counts.

### saakshakinni.com — the Store API `?slug=` trap (fixed 2026-07-31)
`?slug=` is **not** a unique key. WooCommerce indexes every VARIATION under its
own slug, so `/product/rosetta-blouse-dracy-skirt/` returns two objects and the
**variation comes first**: the size-M variation of the *sibling* product
`…-dracy-skirt-2` (`parent: 29751`, `type: "variation"`, regular_price ₹15,500,
`price_range: null`), then the real variable parent (`parent: 0`,
range ₹11,000–₹26,500). `extractWooApi` read `arr[0]`, so it stored ₹15,500 and
`preferHigh` never fired — variations carry no `price_range` — leaving base
26,500 vs live 15,500 as a phantom −11,000 mismatch.

`pickWooProduct` now takes the top-level product (`parent` falsy, `type !==
"variation"`) whose permalink ends in the requested slug. This is a **code fix,
not a config one — it needs a deploy.** Any saakshakinni row whose product has a
same-slug-prefixed sibling was affected; re-run the brand after deploying.

### houseofmasaba.com / mahimamahajan.in
Flagged as suspicious (uniform 1.298 ratio; 17% `product unavailable`), then
**confirmed fine by the user. Do not touch.**

## Config: where the knobs are

Per-brand lists live in Supabase `meta`, unioned with the code defaults.
A plain entry ADDS, a `-brand.com` entry REMOVES (including a code default).
Changes take effect within a 30s cache TTL — **no deploy needed**.

Current values (mbo 1): `fetch_usd_brands=anitadongre.com`,
`range_high_brands=saakshakinni.com,aisharao.com`, `woo_api_brands=saakshakinni.com`,
`gentle_brands=anitadongre.com,saakshakinni.com`,
`native_currency_brands={"manijassal.com":"CAD","sapanaamin.com":"CAD"}`,
`relay_append_params={"anitadongre.com":{"switch":"true"}}`,
`local_only_brands` and `cloud_skip_brands` both empty.

### Two traps
1. **The Brand Rules panel saves raw overrides but displays the effective set.**
   Editing that field silently drops every `-brand.com` token — this is how
   `local_only_brands` got emptied mid-session. To remove a code default you must
   type `-brand.com` yourself.
2. **There is no endpoint or UI for `cloud_skip_brands`** — only
   `/api/fetch/local_only` exists (`server.js:777-778`). Changing cloud-skip
   means a direct meta write.

## The relay — and the 400 that wasted hours

`web/relay/worker.js` on Cloudflare, live at
`pricesync-relay.harshal-growify.workers.dev`, secret set, version `02bf3bfb`.

**It answers a host outside `ALLOWED_HOSTS` with HTTP 400** (deliberately, so the
fetcher's 403-backoff won't retry a config error). That surfaces as
`Fetch Error (store returned HTTP 400)` and looks exactly like the origin
rejecting you. All 44 mymoledro rows failed this way because the brand was
local-only (so relayed) while `mymoledro.com` wasn't allowlisted.

**A uniform 400 across one whole brand is almost certainly this, not the site.**
Only `www.` is normalised away, so a country subdomain like `us.anitadongre.com`
needs its own entry. Allowlist now covers all five hosts.

Relay routing only applies to `local_only_brands` (`pipeline.js:213`), and both
lists are empty, so nothing is relayed today.

## Verified vs not

Verified from the dev machine, and where noted from a US datacenter:
labelanushree 422/424 matched (0 errors), mymoledro 44/44 matched,
anitadongre 138/173 seeded with USD.

**Not verified from Render's own egress.** Every lever was tested from this
machine and from Anthropic's US fetcher — which is *not* a stand-in for Render.
The only authoritative test for a cloud fetch is a real cloud run.

Watch on the next cloud run: **spot-check a mymoledro value** (sakura must read
`275000`, not `339622`). An inflated result is INR-labelled, so the currency
guard cannot flag it and the matched/mismatch counters look normal either way.

## Method: diagnosing the next geo-priced brand

1. **Mirror test.** From an India IP, asking "does `?currency=INR` return INR"
   is an identity no-op that proves nothing. Try to force the **wrong** country
   or currency. A price that flips to the exact figure the cloud had been
   storing identifies the plugin and the lever in one shot.
2. **Fingerprint on a plain fetch.** Appending a param echoes it into the HTML,
   so a plugin sniff on a parameterised fetch always "finds" whatever you asked
   for. Fetch with no params.
3. **Confirm remotely, but don't conclude from it.** WebFetch (US datacenter)
   shows a param survives a foreign hop. It does not show what Render gets.
4. **Test regexes from a file**, never inline through a shell — quote mangling
   yields false "regex doesn't match" results.

## Environment facts that cost time

- **Render runs in Virginia (US East)**, service `srv-d8nulmernols73e6v8cg`,
  and its runtime is still labelled Python 3 though it runs Node.
  `web/render.yaml` says `region: singapore` — **the yaml is wrong**, the live
  service predates it. The 2026-06-26 "co-locate in Singapore" migration never
  happened; DB is Mumbai, app is Virginia.
- Live app: `https://pricesync-my53.onrender.com`. Deploy = push to main
  (`autoDeploy`). A deploy **restarts the process and kills any in-flight run** —
  pipeline state is in memory.
- `web/client/dist` is gitignored; Render builds the client itself.
- Confirm which commit is live via Super Admin → Diagnostics → Uptime (resets on
  deploy). `/api/health` reports mail transport only.

## Revert recipes

- **A lever stops working:** add the brand to `local_only_brands` (plain entry)
  and refresh from a local run. No deploy.
- **anitadongre back to rupee tracking:** remove it from `fetch_usd_brands`;
  `base_price` still holds the INR baseline. To restore URLs:
  `replace(url,'//us.anitadongre.com','//www.anitadongre.com')`.
- **Re-import restores `www` URLs** for anitadongre — `import_catalog` was left
  untouched. The fetch-time host swap covers that case.

## UI: boot countdown (`0cc2445`)

Run and Abort had dead air behind an empty console. The wait is real:
`/pipe/start` returns once the run is flagged but `startPipeline` must load the
work list from Postgres before it can log a row, and `/pipe/abort` only sets a
flag the run notices when in-flight fetches settle.

Both now show an estimated countdown. The estimate is **measured and learned per
browser** (localStorage rolling average) since the true wait scales with catalog
size and DB round trip. Boot ends on the **first log line** — `running` and
`total_rows` both go true too early (the server keeps the previous run's
`total_rows` until the list loads).

## Open items

- Brand Rules display-vs-save mismatch (trap 1 above).
- No `cloud_skip_brands` endpoint/UI (trap 2 above).
- `Fetcher.get` retries only 403/429/5xx, so **428 is fatal on first hit** with
  no backoff. Worth 3 rows here; still wrong.
- `extractRow` falls back to *assuming* the requested currency when
  `detectCurrency` returns null. Erroring the row instead would be safer — that
  assumption is what silently stamped 8 USD prices as INR during the
  `us.anitadongre` test.
