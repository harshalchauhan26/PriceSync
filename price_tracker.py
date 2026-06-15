#!/usr/bin/env python3
"""
PRICE MBO TRACKER - batch-wise price verification utility.

Reads an e-commerce tracker sheet (.xlsx or .csv), fetches each row's
Designer Product URL live, auto-detects the listing currency (USD/CAD/INR)
and clean price, compares against the Studio East Price baseline, writes
status columns back into the sheet, and compiles a Markdown mismatch report.

Usage:
    python price_tracker.py                       # auto-detect default input file
    python price_tracker.py path/to/sheet.xlsx    # explicit input
    python price_tracker.py --batch-size 4 --timeout 15 --report mismatch_report.md
"""

import argparse
import json
import os
import random
import re
import sys
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import pandas as pd
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_INPUT_CANDIDATES = [
    "MBO_Scraped_Result.xlsx - Sheet1.csv",
    "MBO_Scraped_Result.xlsx",
]

REQUIRED_COLUMNS = [
    "MBO Product URL",
    "Designer Product URL",
    "Platform Type",
    "Custom Regex",
    "Studio East Price",
]

# Rotational meta-headers: realistic desktop browser UA pool.
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

BATCH_SIZE = 4                  # rows per pool step (spec: 3-5)
COOLDOWN_RANGE = (1.2, 2.8)     # randomized seconds between web calls
SHOPIFY_CENTS_THRESHOLD = 1_000_000  # values above this get /100 down-scale
MATCH_TOLERANCE = 1.0           # unit variance allowed for a "match"

CURRENCIES = ("USD", "CAD", "INR")


# ---------------------------------------------------------------------------
# Fetch layer
# ---------------------------------------------------------------------------

class Fetcher:
    """requests wrapper with rotating User-Agents, per-domain rate limiting,
    and exponential-backoff retries on 403/429 throttling."""

    # Shared across all Fetcher instances/worker threads: a domain may only
    # be hit once per cooldown window no matter how many workers run.
    _domain_next = {}
    _domain_lock = threading.Lock()

    def __init__(self, timeout=15, cooldown_range=COOLDOWN_RANGE, quiet=False,
                 max_retries=3):
        self.timeout = timeout
        self.cooldown_range = cooldown_range
        self.session = requests.Session()
        self.quiet = quiet
        self.max_retries = max_retries
        self._first_call = True

    def _await_domain_slot(self, url):
        """Block until this domain's next-allowed timestamp; reserve a slot."""
        domain = urlsplit(url).netloc
        while True:
            with Fetcher._domain_lock:
                now = time.time()
                nxt = Fetcher._domain_next.get(domain, 0.0)
                if now >= nxt:
                    Fetcher._domain_next[domain] = (
                        now + random.uniform(*self.cooldown_range))
                    return
                wait = nxt - now
            time.sleep(min(wait, 0.5))

    def _push_domain_back(self, url, seconds):
        """Move a throttled domain's next-allowed slot into the future."""
        domain = urlsplit(url).netloc
        with Fetcher._domain_lock:
            Fetcher._domain_next[domain] = max(
                Fetcher._domain_next.get(domain, 0.0),
                time.time() + seconds)

    def _headers(self):
        return {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

    def _cooldown(self):
        if self._first_call:
            self._first_call = False
            return
        pause = random.uniform(*self.cooldown_range)
        if not self.quiet:
            print(f"    ... cooldown {pause:.1f}s")
        time.sleep(pause)

    def get(self, url):
        """GET with humanized cooldown, per-domain pacing, and backoff retries.

        403/429 responses are retried up to max_retries times with a fresh
        User-Agent and exponentially growing waits (respecting Retry-After
        when the server sends one). The throttled domain's shared slot is
        pushed back so other workers do not pile onto it meanwhile.
        """
        self._cooldown()
        resp = None
        for attempt in range(self.max_retries + 1):
            self._await_domain_slot(url)
            resp = self.session.get(url, headers=self._headers(),
                                    timeout=self.timeout, allow_redirects=True)
            if resp.status_code not in (403, 429):
                break
            if attempt >= self.max_retries:
                break
            retry_after = resp.headers.get("Retry-After")
            try:
                backoff = float(retry_after)
            except (TypeError, ValueError):
                backoff = (2 ** attempt) * 3 + random.uniform(0.5, 2.0)
            backoff = min(backoff, 45.0)
            self._push_domain_back(url, backoff)
            if not self.quiet:
                print(f"    ... {resp.status_code} throttled, backing off "
                      f"{backoff:.0f}s (attempt {attempt + 1}/{self.max_retries})")
            time.sleep(backoff)
        resp.raise_for_status()
        return resp


# ---------------------------------------------------------------------------
# Sanitization & currency detection
# ---------------------------------------------------------------------------

def sanitize_price(raw):
    """Convert a messy price token (string or number) to float.

    Strips currency codes/symbols, commas, NBSP, spacer tokens and badges.
    Returns None if no usable number remains.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw)
    # Remove currency words/codes and symbols.
    text = re.sub(r"(?i)\b(USD|CAD|INR|Rs\.?|MRP)\b", "", text)
    text = text.replace("₹", "").replace("$", "").replace("C$", "")
    # Remove commas, NBSP, narrow spaces, apostrophe group separators.
    text = re.sub(r"[,   ' ]", "", text)
    m = re.search(r"\d+(?:\.\d+)?", text)
    if not m:
        return None
    return float(m.group(0))


def descale_if_cents(value):
    """Shopify multiplier anomaly: huge integers are prices in cents."""
    if value is not None and value > SHOPIFY_CENTS_THRESHOLD:
        return value / 100.0
    return value


def detect_currency(text):
    """Dynamically detect USD/CAD/INR from page source. No TLD rules.

    Checks structured signals first (og:price:currency, schema priceCurrency,
    itemprop currency nodes), then contextual symbols.
    """
    if not text:
        return None
    # 1. Meta tags: og:price:currency / product:price:currency
    m = re.search(
        r'(?:og|product):price:currency["\'][^>]*content=["\']([A-Z]{3})["\']'
        r'|content=["\']([A-Z]{3})["\'][^>]*(?:og|product):price:currency',
        text)
    if m:
        code = (m.group(1) or m.group(2)).upper()
        if code in CURRENCIES:
            return code
    # 2. JSON-LD / schema graphs / Shopify JSON: priceCurrency or currency keys
    m = re.search(r'"(?:priceCurrency|price_currency|currency)"\s*:\s*"([A-Z]{3})"', text)
    if m and m.group(1).upper() in CURRENCIES:
        return m.group(1).upper()
    # 3. itemprop="priceCurrency"
    m = re.search(r'itemprop=["\']priceCurrency["\'][^>]*content=["\']([A-Z]{3})["\']', text)
    if m and m.group(1).upper() in CURRENCIES:
        return m.group(1).upper()
    # 4. Contextual symbols / codes in visible text.
    if "₹" in text or re.search(r"(?i)\bRs\.?\s*\d", text):
        return "INR"
    if re.search(r"\bC\$|\bCAD\b", text):
        return "CAD"
    if re.search(r"\bUSD\b", text) or "$" in text:
        return "USD"
    return None


# ---------------------------------------------------------------------------
# Platform extractors
# ---------------------------------------------------------------------------

def extract_price_from_html(html, custom_regex=None):
    """Generic HTML price extraction (WooCommerce meta tags, schema, regex)."""
    # Custom regex from the sheet takes priority when provided.
    if custom_regex:
        m = re.search(custom_regex, html, re.DOTALL)
        if m:
            token = m.group(1) if m.groups() else m.group(0)
            return sanitize_price(token)
        return None
    # property="product:price:amount" (content before or after the property attr)
    m = re.search(
        r'property=["\']product:price:amount["\'][^>]*content=["\']([^"\']+)["\']'
        r'|content=["\']([^"\']+)["\'][^>]*property=["\']product:price:amount["\']',
        html)
    if m:
        return sanitize_price(m.group(1) or m.group(2))
    # itemprop="price" with a content attribute
    m = re.search(
        r'itemprop=["\']price["\'][^>]*content=["\']([^"\']+)["\']'
        r'|content=["\']([^"\']+)["\'][^>]*itemprop=["\']price["\']',
        html)
    if m:
        return sanitize_price(m.group(1) or m.group(2))
    # itemprop="price" wrapping visible text
    m = re.search(r'itemprop=["\']price["\'][^>]*>([^<]+)<', html)
    if m:
        return sanitize_price(m.group(1))
    # JSON-LD schema graph "price" (or AggregateOffer "lowPrice")
    m = re.search(r'"(?:price|lowPrice)"\s*:\s*"?([0-9][0-9,.]*)"?', html)
    if m:
        return sanitize_price(m.group(1))
    # WooCommerce visible price span markup
    m = re.search(
        r'woocommerce-Price-amount[^>]*>(?:<bdi>)?\s*(?:<span[^>]*>[^<]*</span>)?\s*([0-9][0-9,.]*)',
        html)
    if m:
        return sanitize_price(m.group(1))
    return None


def shopify_js_url(url):
    """Append .js to the product URL path, preserving any query string."""
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    if not path.endswith(".js"):
        path += ".js"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, ""))


# Currency is a per-storefront property; cache it per domain to avoid an
# extra HTML fetch for every Shopify row on the same store.
_DOMAIN_CURRENCY = {}


def extract_shopify(fetcher, url):
    """Shopify route: product .js JSON first, HTML fallback if blocked.

    Returns (price, currency, page_text_for_currency_detection).
    """
    domain = urlsplit(url).netloc
    try:
        resp = fetcher.get(shopify_js_url(url))
        data = resp.json()
        variants = data.get("variants") or []
        raw = variants[0].get("price") if variants else None
        if raw is None:
            raw = data.get("price")
        if isinstance(raw, int):
            # The .js endpoint encodes prices as integer cents (13000 == 130.00).
            price = raw / 100.0
        else:
            # String/decimal payloads: sanitize, then apply the luxury-scale
            # cents-anomaly safeguard (> 1,000,000 -> /100).
            price = descale_if_cents(sanitize_price(raw))
        currency = detect_currency(resp.text) or _DOMAIN_CURRENCY.get(domain)
        if price is not None and currency is None:
            # product.js usually has no currency; one extra HTML fetch for it.
            try:
                html = fetcher.get(url).text
                currency = detect_currency(html)
            except requests.RequestException:
                pass
        if price is not None:
            if currency:
                _DOMAIN_CURRENCY[domain] = currency
            return price, currency
    except (requests.RequestException, ValueError):
        pass  # blocked or non-JSON -> fall back to HTML parsing
    html = fetcher.get(url).text
    price = descale_if_cents(extract_price_from_html(html))
    currency = detect_currency(html) or _DOMAIN_CURRENCY.get(domain)
    if price is not None and currency:
        _DOMAIN_CURRENCY[domain] = currency
    return price, currency


def extract_wordpress(fetcher, url):
    """WordPress/WooCommerce route: meta tags / itemprop / schema in HTML."""
    html = fetcher.get(url).text
    return extract_price_from_html(html), detect_currency(html)


def extract_custom(fetcher, url, custom_regex):
    """Custom route: regex pattern supplied per-row in the sheet."""
    html = fetcher.get(url).text
    return extract_price_from_html(html, custom_regex=custom_regex), detect_currency(html)


def extract_row(fetcher, url, platform, custom_regex):
    platform = (platform or "").strip().lower()
    if platform == "shopify":
        return extract_shopify(fetcher, url)
    if platform in ("wordpress", "woocommerce"):
        return extract_wordpress(fetcher, url)
    if platform == "custom":
        return extract_custom(fetcher, url, custom_regex)
    # Unknown platform: best-effort generic HTML parse.
    return extract_wordpress(fetcher, url)


# ---------------------------------------------------------------------------
# Sheet I/O
# ---------------------------------------------------------------------------

def find_input_file(explicit=None):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"Input file not found: {explicit}")
        return explicit
    for candidate in DEFAULT_INPUT_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    sys.exit("No input file found. Expected one of: "
             + ", ".join(DEFAULT_INPUT_CANDIDATES))


def load_sheet(path):
    if path.lower().endswith(".csv"):
        df = pd.read_csv(path)
    else:
        df = pd.read_excel(path)
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(f"Input sheet is missing required columns: {missing}")
    return df


def save_sheet(df, path):
    if path.lower().endswith(".csv"):
        df.to_csv(path, index=False)
    else:
        df.to_excel(path, index=False)


# ---------------------------------------------------------------------------
# Verification pipeline
# ---------------------------------------------------------------------------

def verify(df, fetcher, batch_size=BATCH_SIZE, save_cb=None, limit=None,
           resume=True, retry_errors=False):
    """Iterate rows in batches, fetch live prices, write status columns.

    resume: skip rows that already carry a Status (from a previous run).
    retry_errors: treat rows whose Status is 'Fetch Error' as pending again.
    save_cb: called after every batch to checkpoint progress to disk.
    limit: process at most this many pending rows.
    """
    for col in ("Live Price", "Detected Currency", "Status"):
        if col not in df.columns:
            df[col] = ""
    df["Live Price"] = df["Live Price"].astype(object)

    def is_done(i):
        s = str(df.at[i, "Status"] or "").strip()
        if not s or s == "nan":
            return False
        if retry_errors and s.startswith("Fetch Error"):
            return False
        return True

    pending = [i for i in df.index if not (resume and is_done(i))]
    skipped = len(df) - len(pending)
    if skipped:
        print(f"Resume: skipping {skipped} already-processed rows; "
              f"{len(pending)} pending.")
    if limit:
        pending = pending[:limit]
        print(f"Limit: processing first {len(pending)} pending rows this run.")

    mismatches = []
    total = len(pending)
    for batch_start in range(0, total, batch_size):
        batch = pending[batch_start:batch_start + batch_size]
        print(f"\n=== Batch {batch_start // batch_size + 1} "
              f"(rows {batch_start + 1}-{min(batch_start + batch_size, total)} of {total}) ===",
              flush=True)
        for idx in batch:
            row = df.loc[idx]
            url = str(row["Designer Product URL"]).strip()
            platform = str(row["Platform Type"]).strip()
            regex = row["Custom Regex"]
            regex = None if pd.isna(regex) or not str(regex).strip() else str(regex).strip()
            base = sanitize_price(row["Studio East Price"])
            print(f"  [{idx + 1}/{total}] {platform:<12} {url[:80]}")

            try:
                live, currency = extract_row(fetcher, url, platform, regex)
                if live is None:
                    raise ValueError("price not found in page (layout change?)")
            except Exception as exc:
                df.at[idx, "Status"] = "Fetch Error"
                print(f"      -> Fetch Error ({type(exc).__name__}: {exc})")
                continue

            cur = currency or "UNKNOWN"
            df.at[idx, "Live Price"] = live
            df.at[idx, "Detected Currency"] = cur

            if base is None:
                df.at[idx, "Status"] = "Fetch Error"
                print("      -> Fetch Error (baseline Studio East Price unreadable)")
                continue

            delta = live - base
            if abs(delta) <= MATCH_TOLERANCE:
                df.at[idx, "Status"] = f"Price Matched ({cur})"
                print(f"      -> Price Matched ({cur})  live={live:g} base={base:g}")
            else:
                df.at[idx, "Status"] = f"Price Mismatch! ({cur})"
                print(f"      -> Price Mismatch! ({cur})  live={live:g} base={base:g} "
                      f"delta={delta:+g}")
                mismatches.append({
                    "url": url,
                    "platform": platform,
                    "base": base,
                    "live": live,
                    "currency": cur,
                    "delta": delta,
                })
        if save_cb:
            save_cb()  # checkpoint progress after every batch
    return mismatches


def collect_mismatches(df):
    """Rebuild the mismatch list from the sheet itself (survives resume)."""
    out = []
    for _, row in df.iterrows():
        status = str(row.get("Status") or "")
        if not status.startswith("Price Mismatch!"):
            continue
        base = sanitize_price(row["Studio East Price"])
        live = sanitize_price(row["Live Price"])
        out.append({
            "url": str(row["Designer Product URL"]).strip(),
            "platform": str(row["Platform Type"]).strip(),
            "base": base,
            "live": live,
            "currency": str(row.get("Detected Currency") or "UNKNOWN"),
            "delta": (live - base) if live is not None and base is not None else 0.0,
        })
    return out


def build_report(mismatches):
    """Compile mismatch rows into a copy-paste-ready Markdown table."""
    lines = ["# Price Mismatch Alert Report", ""]
    if not mismatches:
        lines.append("No price mismatches detected. All live prices are "
                     "within tolerance of the Studio East baseline.")
        return "\n".join(lines) + "\n"
    lines += [
        f"**{len(mismatches)} mismatch(es) detected.**",
        "",
        "| Product Link | Platform | Reference Price | Live Price | Currency | Delta |",
        "|---|---|---:|---:|---|---:|",
    ]
    for m in mismatches:
        lines.append(
            f"| {m['url']} | {m['platform']} | {m['base']:g} | {m['live']:g} "
            f"| {m['currency']} | {m['delta']:+g} |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="PRICE MBO TRACKER - batch price verification")
    ap.add_argument("input", nargs="?", help="tracker sheet (.xlsx or .csv); "
                    "defaults to MBO_Scraped_Result.* in the working directory")
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    ap.add_argument("--timeout", type=float, default=15)
    ap.add_argument("--report", default="mismatch_report.md")
    ap.add_argument("--min-cooldown", type=float, default=COOLDOWN_RANGE[0])
    ap.add_argument("--max-cooldown", type=float, default=COOLDOWN_RANGE[1])
    ap.add_argument("--limit", type=int, default=None,
                    help="process at most N pending rows this run")
    ap.add_argument("--no-resume", action="store_true",
                    help="re-process rows even if they already have a Status")
    ap.add_argument("--retry-errors", action="store_true",
                    help="re-process rows whose Status is 'Fetch Error'")
    args = ap.parse_args(argv)

    path = find_input_file(args.input)
    print(f"Input sheet: {path}")
    df = load_sheet(path)
    print(f"Loaded {len(df)} rows.")

    fetcher = Fetcher(timeout=args.timeout,
                      cooldown_range=(args.min_cooldown, args.max_cooldown))
    verify(df, fetcher, batch_size=max(1, args.batch_size),
           save_cb=lambda: save_sheet(df, path),
           limit=args.limit, resume=not args.no_resume,
           retry_errors=args.retry_errors)
    mismatches = collect_mismatches(df)

    save_sheet(df, path)
    print(f"\nUpdated sheet written back to: {path}")

    report = build_report(mismatches)
    with open(args.report, "w", encoding="utf-8") as fh:
        fh.write(report)
    print(f"Mismatch report written to: {args.report}\n")
    print("=" * 70)
    print(report)


if __name__ == "__main__":
    main()
