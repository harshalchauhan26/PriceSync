#!/usr/bin/env python3
"""
Live currency conversion to INR for PriceSync.

Designer sites quote prices in USD / CAD / INR; the baseline (Studio East Price)
is in INR. To compare and to approve a final price, foreign live prices are
converted to INR using the *current* exchange rate.

Rates are fetched from a free, no-key endpoint and cached (6h). If the network
is unavailable we fall back to sane recent approximations so the app still works.
"""

import time
import requests

_TTL = 6 * 3600
_CACHE = {"at": 0.0, "rates": {}}
# cur -> INR per 1 unit of cur (rough recent values; only used if the API fails)
_FALLBACK = {"INR": 1.0, "USD": 83.0, "CAD": 61.0, "EUR": 90.0, "GBP": 105.0,
             "AUD": 55.0, "AED": 22.6}


def _fetch():
    """Return {cur: INR_per_unit}. Source gives cur-per-1-INR, so we invert."""
    r = requests.get("https://open.er-api.com/v6/latest/INR", timeout=10)
    r.raise_for_status()
    rates = (r.json() or {}).get("rates", {})
    out = {c: (1.0 / v) for c, v in rates.items() if v}
    out["INR"] = 1.0
    if "USD" not in out:                 # sanity: must have at least USD
        raise ValueError("FX payload missing USD")
    return out


def rates():
    now = time.time()
    if now - _CACHE["at"] > _TTL or not _CACHE["rates"]:
        try:
            _CACHE["rates"] = _fetch()
            _CACHE["at"] = now
        except Exception:
            if not _CACHE["rates"]:
                _CACHE["rates"] = dict(_FALLBACK)
    return _CACHE["rates"]


def rate_of(currency):
    c = (currency or "INR").strip().upper()
    return rates().get(c) or _FALLBACK.get(c, 1.0)


def to_inr(amount, currency):
    """Convert an amount in `currency` to INR. None-safe. INR/unknown -> as-is."""
    if amount is None:
        return None
    c = (currency or "INR").strip().upper()
    if c in ("INR", "", "UNKNOWN", "RS", "₹"):
        return round(float(amount), 2)
    return round(float(amount) * rate_of(c), 2)


def snapshot(currencies=("USD", "CAD", "INR")):
    """Current rates for display in the UI."""
    rr = rates()
    return {c: round(rr.get(c, _FALLBACK.get(c, 1.0)), 4) for c in currencies}


if __name__ == "__main__":
    print(snapshot())
    print("100 USD ->", to_inr(100, "USD"), "INR")
