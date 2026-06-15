#!/usr/bin/env python3
"""
PriceSync — one app, SQLite-backed.

Pages:
  /pipeline       run the price checker (DB in, DB out — no Excel locks)
  /review         approve mismatches, re-run errors, push prices to Shopify
  /integrations   add a Shopify token per brand and it just works

All state lives in pricesync.db (see store.py). The Excel sheet is only ever
read once, on import. Run:  python saas.py  ->  http://127.0.0.1:8080
"""

import io
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlsplit

import pandas as pd
import requests
from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

import price_tracker as pt
import store

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = int(
    float(os.environ.get("MAX_UPLOAD_MB", "64")) * 1024 * 1024)
UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")

LOCK = threading.Lock()
LOG = []
_thread_local = threading.local()
ACTIVE_COOLDOWN = pt.COOLDOWN_RANGE

CONFIG = {
    "concurrency": 5, "timeout_ms": 12000, "batch_size": 500, "rest_between": 60,
    "simulation": False, "retry_errors": False, "fresh_start": False,
    "safe_retry": True, "safe_concurrency": 1, "safe_cooldown_min": 4.0,
    "safe_cooldown_max": 8.0, "safe_rest_between": 30, "safe_batch_size": 25,
}
STATE = {
    "running": False, "abort": False, "phase": "idle", "total_rows": 0,
    "pre_done": 0, "completed": 0, "matched": 0, "mismatch": 0, "errors": 0,
    "retry_total": 0, "retry_completed": 0, "retry_recovered": 0,
    "started_at": None, "message": "Idle. Import a sheet, then Start.",
}
RERUN = {"running": False, "total": 0, "done": 0, "recovered": 0,
         "still_error": 0, "message": "Idle."}
RERUN_LOCK = threading.Lock()
PUSH = {"running": False, "total": 0, "done": 0, "ok": 0, "failed": 0, "message": "Idle."}
PUSH_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# Engine glue (DB-backed)
# ---------------------------------------------------------------------------

def _get_fetcher():
    f = getattr(_thread_local, "fetcher", None)
    if f is None:
        f = pt.Fetcher(timeout=CONFIG["timeout_ms"] / 1000.0,
                       cooldown_range=ACTIVE_COOLDOWN, quiet=True)
        _thread_local.fetcher = f
    return f


def _log(row_no, platform, brand, currency, price, status, msg="", url=""):
    with LOCK:
        LOG.append({
            "row": row_no, "platform": (platform or "?").lower(), "domain": brand,
            "url": url, "currency": currency or "-",
            "price": f"{price:.2f}" if isinstance(price, (int, float)) else "-",
            "status": status, "msg": msg})


def _process(prod):
    """Fetch + verify one product row. Returns (id, status, live, cur, state)."""
    pid = prod["id"]
    url = (prod["url"] or "").strip()
    platform = (prod["platform"] or "").strip()
    regex = prod["custom_regex"] or None
    base = prod["base_price"]
    brand = prod["brand"]

    if CONFIG["simulation"]:
        time.sleep(random.uniform(0.03, 0.12))
        roll = random.random()
        if roll < 0.05 or base is None:
            _log(pid, platform, brand, None, None, "Fetch Error",
                 "simulated failure", url=url)
            return pid, "Fetch Error", None, None, "error"
        live = base if roll > 0.12 else round(base * random.choice([0.9, 1.1]), 2)
        cur = "INR" if brand.endswith(".in") else "USD"
        if abs(live - base) <= pt.MATCH_TOLERANCE:
            _log(pid, platform, brand, cur, live, "Price Matched", url=url)
            return pid, f"Price Matched ({cur})", live, cur, "matched"
        _log(pid, platform, brand, cur, live, "Price Mismatch!",
             f"delta {live - base:+.2f}", url=url)
        return pid, f"Price Mismatch! ({cur})", live, cur, "mismatch"

    try:
        live, currency = pt.extract_row(_get_fetcher(), url, platform, regex)
        if live is None:
            raise ValueError("price not found")
    except Exception as exc:
        _log(pid, platform, brand, None, None, "Fetch Error", f"{exc}", url=url)
        return pid, "Fetch Error", None, None, "error"

    cur = currency or "UNKNOWN"
    if base is None:
        _log(pid, platform, brand, cur, live, "Fetch Error",
             "baseline price unreadable", url=url)
        return pid, "Fetch Error", live, cur, "error"
    delta = live - base
    if abs(delta) <= pt.MATCH_TOLERANCE:
        _log(pid, platform, brand, cur, live, "Price Matched", url=url)
        return pid, f"Price Matched ({cur})", live, cur, "matched"
    _log(pid, platform, brand, cur, live, "Price Mismatch!", f"delta {delta:+.2f}", url=url)
    return pid, f"Price Mismatch! ({cur})", live, cur, "mismatch"


def _pending_ids(con):
    if CONFIG["fresh_start"]:
        rows = con.execute("SELECT id FROM products").fetchall()
    elif CONFIG["retry_errors"]:
        rows = con.execute(
            "SELECT id FROM products WHERE state IN ('pending','error')").fetchall()
    else:
        rows = con.execute("SELECT id FROM products WHERE state='pending'").fetchall()
    return [r["id"] for r in rows]


def _abortable_rest(seconds, label):
    with LOCK:
        STATE["message"] = f"{label} - resting {max(0, seconds):.0f}s..."
    t0 = time.time()
    while time.time() - t0 < max(0.0, float(seconds)) and not STATE["abort"]:
        time.sleep(0.5)


def _run_pass(con, ids, workers, batch_size, rest_between, cooldown, phase, label, on_done):
    global ACTIVE_COOLDOWN
    ACTIVE_COOLDOWN = cooldown
    workers = max(1, int(workers))
    batch_size = max(1, int(batch_size))
    with LOCK:
        STATE["phase"] = phase
    for bstart in range(0, len(ids), batch_size):
        if STATE["abort"]:
            return False
        batch = ids[bstart:bstart + batch_size]
        prods = {r["id"]: r for r in con.execute(
            "SELECT id,url,platform,custom_regex,base_price,brand FROM products "
            f"WHERE id IN ({','.join('?' * len(batch))})", batch).fetchall()}
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(_process, prods[i]): i for i in batch if i in prods}
            for fut in as_completed(futs):
                if STATE["abort"]:
                    for f2 in futs:
                        f2.cancel()
                    break
                pid, status, live, cur, st = fut.result()
                base = prods[pid]["base_price"]
                delta = (live - base) if (live is not None and base is not None) else None
                con.execute(
                    "UPDATE products SET status=?,live_price=?,currency=?,state=?,"
                    "delta=?,updated_at=? WHERE id=?",
                    (status, live, cur, st, delta,
                     time.strftime("%Y-%m-%d %H:%M:%S"), pid))
                con.commit()  # commit per row so Review/counts update live
                on_done(pid, st)
        if not STATE["abort"] and bstart + batch_size < len(ids):
            _abortable_rest(rest_between, label)
            with LOCK:
                STATE["message"] = label
    return not STATE["abort"]


def _pipeline():
    global ACTIVE_COOLDOWN
    con = store.connect()
    try:
        ids = _pending_ids(con)
        total = con.execute("SELECT COUNT(*) c FROM products").fetchone()["c"]
        with LOCK:
            STATE.update(total_rows=total, pre_done=total - len(ids),
                         message=f"Main pass - {len(ids)} pending")

        def main_done(pid, st):
            with LOCK:
                STATE["completed"] += 1
                STATE["matched" if st == "matched" else
                      "mismatch" if st == "mismatch" else "errors"] += 1

        finished = _run_pass(
            con, ids, min(25, max(1, int(CONFIG["concurrency"]))),
            CONFIG["batch_size"], CONFIG["rest_between"], pt.COOLDOWN_RANGE,
            "main", "Main pass", main_done)

        if finished and CONFIG["safe_retry"]:
            err = [r["id"] for r in con.execute(
                "SELECT id FROM products WHERE state='error' AND base_price IS NOT NULL"
                ).fetchall()]
            with LOCK:
                STATE.update(retry_total=len(err), retry_completed=0, retry_recovered=0)
            if err:
                with LOCK:
                    STATE["message"] = f"Safe-Retry Window - {len(err)} errors, gently"

                def retry_done(pid, st):
                    with LOCK:
                        STATE["retry_completed"] += 1
                        if st != "error":
                            STATE["retry_recovered"] += 1
                            STATE["errors"] = max(0, STATE["errors"] - 1)
                            if st == "matched":
                                STATE["matched"] += 1
                            elif st == "mismatch":
                                STATE["mismatch"] += 1

                _run_pass(con, err, CONFIG["safe_concurrency"],
                          CONFIG["safe_batch_size"], CONFIG["safe_rest_between"],
                          (float(CONFIG["safe_cooldown_min"]),
                           float(CONFIG["safe_cooldown_max"])),
                          "safe_retry", "Safe-Retry Window", retry_done)
        ACTIVE_COOLDOWN = pt.COOLDOWN_RANGE
        final = "Aborted" if STATE["abort"] else "Completed"
        rec = STATE["retry_recovered"]
        with LOCK:
            STATE["phase"] = "done"
            STATE["message"] = (f"{final}" +
                                (f" ({rec} recovered in Safe-Retry Window)" if rec else "") +
                                ". Results saved to database.")
    finally:
        con.close()
        with LOCK:
            STATE["running"] = False


# ---------------------------------------------------------------------------
# Shopify
# ---------------------------------------------------------------------------

def _integration(brand):
    con = store.connect()
    r = con.execute("SELECT * FROM integrations WHERE brand=?", (brand,)).fetchone()
    con.close()
    return dict(r) if r else None


def _product_handle(url):
    return urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1].split("?")[0]


def push_price_to_shopify(brand, url, price):
    cfg = _integration(brand)
    if not cfg or not cfg.get("shop_domain") or not cfg.get("access_token"):
        return {"ok": False, "status": f"no Shopify token for '{brand}' (add it in Integrations)"}
    if price is None:
        return {"ok": False, "status": "approve a final price first"}
    handle = _product_handle(url)
    if cfg.get("dry_run"):
        return {"ok": True, "status": f"DRY RUN: would set '{handle}' -> {price}"}
    ver = cfg.get("api_version") or "2024-10"
    base = f"https://{cfg['shop_domain']}/admin/api/{ver}"
    headers = {"X-Shopify-Access-Token": cfg["access_token"], "Content-Type": "application/json"}
    try:
        r = requests.get(f"{base}/products.json",
                         params={"handle": handle, "fields": "id,variants"},
                         headers=headers, timeout=20)
        r.raise_for_status()
        products = r.json().get("products", [])
        if not products:
            return {"ok": False, "status": f"handle '{handle}' not found in store"}
        variants = products[0].get("variants", [])
        updated = 0
        for v in variants:
            pr = requests.put(f"{base}/variants/{v['id']}.json",
                              json={"variant": {"id": v["id"], "price": f"{price}"}},
                              headers=headers, timeout=20)
            if pr.status_code in (200, 201):
                updated += 1
        ok = updated > 0
        return {"ok": ok, "status": f"{'updated' if ok else 'FAILED'} "
                f"{updated}/{len(variants)} variant(s) -> {price}"}
    except requests.RequestException as exc:
        return {"ok": False, "status": f"Shopify API error: {exc}"}


def verify_shopify(brand):
    cfg = _integration(brand)
    if not cfg or not cfg.get("shop_domain") or not cfg.get("access_token"):
        return {"ok": False, "status": f"no token saved for '{brand}'"}
    ver = cfg.get("api_version") or "2024-10"
    try:
        r = requests.get(f"https://{cfg['shop_domain']}/admin/api/{ver}/shop.json",
                         headers={"X-Shopify-Access-Token": cfg["access_token"]}, timeout=15)
    except requests.RequestException as exc:
        return {"ok": False, "status": f"connection error: {exc}"}
    if r.status_code == 200:
        shop = r.json().get("shop", {})
        mode = " · DRY-RUN" if cfg.get("dry_run") else " · LIVE"
        return {"ok": True, "status": f"connected to {shop.get('name')} ({shop.get('myshopify_domain')}){mode}"}
    if r.status_code == 401:
        return {"ok": False, "status": "401 - invalid/expired token"}
    if r.status_code == 404:
        return {"ok": False, "status": "404 - shop_domain not found"}
    return {"ok": False, "status": f"HTTP {r.status_code}"}


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def home():
    return render_template("pipeline.html", active="pipeline")


@app.route("/pipeline")
def page_pipeline():
    return render_template("pipeline.html", active="pipeline")


@app.route("/review")
def page_review():
    return render_template("review.html", active="review")


@app.route("/integrations")
def page_integrations():
    return render_template("integrations.html", active="integrations")


@app.route("/healthz")
def healthz():
    with LOCK:
        return jsonify(ok=True, running=STATE["running"], phase=STATE["phase"])


@app.route("/api/meta")
def api_meta():
    return jsonify(counts=store.counts(),
                   last_import=store.get_meta("last_import"),
                   last_import_rows=store.get_meta("last_import_rows"),
                   last_import_file=store.get_meta("last_import_file"))


# ---- Pipeline API ----

@app.route("/api/import", methods=["POST"])
def api_import():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(ok=False, error="no file"), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, secure_filename(f.filename))
    f.save(path)
    # replace=True -> the DB becomes exactly this sheet (rows not in it are removed)
    replace = (request.args.get("mode", "replace") != "add")
    try:
        res = store.import_sheet(path, replace=replace)
    except Exception as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True, **res, counts=store.counts())


@app.route("/api/clear_db", methods=["POST"])
def api_clear_db():
    if STATE["running"]:
        return jsonify(ok=False, error="stop the running pipeline first"), 409
    con = store.connect()
    con.execute("DELETE FROM products")
    con.commit()
    con.close()
    return jsonify(ok=True, counts=store.counts())


@app.route("/api/pipe/config", methods=["POST"])
def api_config():
    data = request.get_json(force=True) or {}
    with LOCK:
        for k in CONFIG:
            if k in data:
                CONFIG[k] = data[k]
    return jsonify(ok=True, config=CONFIG)


@app.route("/api/pipe/start", methods=["POST"])
def api_start():
    with LOCK:
        if STATE["running"]:
            return jsonify(error="already running"), 409
        if store.counts()["total"] == 0:
            return jsonify(error="no products in database — import a sheet first"), 400
        STATE.update(running=True, abort=False, phase="main", completed=0,
                     matched=0, mismatch=0, errors=0, retry_total=0,
                     retry_completed=0, retry_recovered=0,
                     started_at=time.time(), message="Starting...")
    threading.Thread(target=_pipeline, daemon=True).start()
    return jsonify(ok=True)


@app.route("/api/pipe/abort", methods=["POST"])
def api_abort():
    STATE["abort"] = True
    return jsonify(ok=True)


@app.route("/api/pipe/clear_log", methods=["POST"])
def api_clear_log():
    with LOCK:
        LOG.clear()
    return jsonify(ok=True)


@app.route("/api/pipe/status")
def api_status():
    cursor = int(request.args.get("cursor", 0))
    with LOCK:
        entries = LOG[cursor:]
        snap = dict(STATE)
        cfg = dict(CONFIG)
    elapsed = int(time.time() - snap["started_at"]) if snap["started_at"] else 0
    return jsonify(running=snap["running"], phase=snap["phase"],
                   total_rows=snap["total_rows"], pre_done=snap["pre_done"],
                   completed=snap["completed"],
                   current_row=snap["pre_done"] + snap["completed"],
                   matched=snap["matched"], mismatch=snap["mismatch"],
                   errors=snap["errors"], retry_total=snap["retry_total"],
                   retry_completed=snap["retry_completed"],
                   retry_recovered=snap["retry_recovered"], elapsed=elapsed,
                   message=snap["message"], config=cfg,
                   cursor=cursor + len(entries), entries=entries,
                   log_total=cursor + len(entries))


@app.route("/api/export")
def api_export():
    kind = request.args.get("kind", "all")
    fmt_ = request.args.get("fmt", "xlsx")
    con = store.connect()
    where = {"all": "1=1", "mismatch": "state='mismatch'", "error": "state='error'",
             "approved": "decision='approved'"}.get(kind, "1=1")
    df = pd.read_sql_query(
        f"SELECT id, brand, platform, url, base_price, live_price, currency, "
        f"status, delta, decision, markup_pct, custom_price, final_price, "
        f"shopify_status, shopify_at FROM products WHERE {where} ORDER BY id",
        con)
    con.close()
    bio = io.BytesIO()
    if fmt_ == "csv":
        bio.write(df.to_csv(index=False).encode("utf-8"))
        mime, name = "text/csv", f"pricesync_{kind}.csv"
    else:
        with pd.ExcelWriter(bio, engine="openpyxl") as xw:
            df.to_excel(xw, index=False, sheet_name="export")
        mime, name = ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                      f"pricesync_{kind}.xlsx")
    bio.seek(0)
    return send_file(bio, mimetype=mime, as_attachment=True, download_name=name)


# ---- Review API ----

@app.route("/api/review/items")
def api_items():
    kind = request.args.get("kind", "mismatch")
    brand = request.args.get("brand", "").strip()
    state = {"mismatch": "mismatch", "error": "error", "resolved": "matched"}.get(kind, "mismatch")
    where, params = "state=?", [state]
    if brand:
        where += " AND brand=?"
        params.append(brand)
    con = store.connect()
    rows = con.execute(
        f"SELECT * FROM products WHERE {where} ORDER BY decision='pending' DESC, "
        f"ABS(COALESCE(delta,0)) DESC LIMIT 1000", params).fetchall()
    con.close()
    return jsonify(items=[dict(r) for r in rows], counts=store.counts())


@app.route("/api/review/brands")
def api_brands():
    kind = request.args.get("kind", "").strip()
    state = {"mismatch": "mismatch", "error": "error", "resolved": "matched"}.get(kind)
    con = store.connect()
    if state:
        rows = con.execute("SELECT brand, COUNT(*) c FROM products WHERE state=? "
                           "AND brand<>'' GROUP BY brand ORDER BY c DESC", (state,)).fetchall()
    else:
        rows = con.execute("SELECT brand, COUNT(*) c FROM products WHERE brand<>'' "
                           "GROUP BY brand ORDER BY c DESC").fetchall()
    configured = {r["brand"] for r in con.execute(
        "SELECT brand FROM integrations WHERE access_token IS NOT NULL AND access_token<>''").fetchall()}
    con.close()
    return jsonify(brands=[{"brand": r["brand"], "count": r["c"],
                            "shopify": r["brand"] in configured} for r in rows])


@app.route("/api/review/decide", methods=["POST"])
def api_decide():
    d = request.get_json(force=True) or {}
    pid = d.get("row")
    if pid in (None, ""):
        return jsonify(ok=False, error="missing row"), 400
    con = store.connect()
    it = con.execute("SELECT base_price, live_price FROM products WHERE id=?", (int(pid),)).fetchone()
    if it is None:
        con.close()
        return jsonify(ok=False, error="unknown row"), 404
    decision = d.get("decision", "approved")
    ref = d.get("ref", "live")
    markup = d.get("markup_pct")
    custom = d.get("custom_price")
    markup = None if markup in ("", None) else float(markup)
    custom = None if custom in ("", None) else float(custom)
    final = None
    if decision == "approved":
        final = store_compute_final(it["base_price"], it["live_price"], ref, markup, custom)
    con.execute("UPDATE products SET decision=?,markup_pct=?,custom_price=?,ref=?,"
                "final_price=?,note=?,decided_at=? WHERE id=?",
                (decision, markup, custom, ref, final, d.get("note", ""),
                 time.strftime("%Y-%m-%d %H:%M:%S"), int(pid)))
    con.commit()
    con.close()
    return jsonify(ok=True, final_price=final)


def store_compute_final(base, live, ref, markup_pct, custom_price):
    if custom_price is not None and float(custom_price) > 0:
        return round(float(custom_price), 2)
    reference = base if ref == "base" else live
    if reference is None:
        reference = live if live is not None else base
    if reference is None:
        return None
    return round(reference * (1 + float(markup_pct or 0) / 100.0), 2)


@app.route("/api/review/rerun", methods=["POST"])
def api_rerun():
    with RERUN_LOCK:
        if RERUN["running"]:
            return jsonify(ok=False, error="re-run already running"), 409
    d = request.get_json(silent=True) or {}
    con = store.connect()
    if d.get("rows"):
        ids = [int(x) for x in d["rows"]]
    else:
        ids = [r["id"] for r in con.execute("SELECT id FROM products WHERE state='error'").fetchall()]
    con.close()
    if not ids:
        return jsonify(ok=False, error="no error rows to re-run"), 400
    with RERUN_LOCK:
        RERUN.update(running=True, total=len(ids), done=0, recovered=0,
                     still_error=0, message=f"Slow re-run of {len(ids)} rows...")
    threading.Thread(target=_rerun_worker, args=(ids,), daemon=True).start()
    return jsonify(ok=True, total=len(ids))


def _rerun_worker(ids):
    fetcher = pt.Fetcher(timeout=15, cooldown_range=(4.0, 8.0), quiet=True)
    con = store.connect()
    recovered = still = 0
    try:
        for pid in ids:
            with RERUN_LOCK:
                if not RERUN["running"]:
                    break
            it = con.execute("SELECT url,platform,custom_regex,base_price,brand "
                             "FROM products WHERE id=?", (pid,)).fetchone()
            if it is None:
                continue
            try:
                live, currency = pt.extract_row(fetcher, it["url"], it["platform"],
                                                it["custom_regex"] or None)
                if live is None:
                    raise ValueError("price not found")
            except Exception as exc:
                con.execute("UPDATE products SET rerun_status=?,rerun_at=? WHERE id=?",
                            (f"Fetch Error: {exc}", time.strftime("%Y-%m-%d %H:%M:%S"), pid))
                con.commit()
                still += 1
                with RERUN_LOCK:
                    RERUN["done"] += 1
                    RERUN["still_error"] = still
                continue
            base = it["base_price"]
            cur = currency or "UNKNOWN"
            if base is not None and abs(live - base) <= pt.MATCH_TOLERANCE:
                state, st = "matched", f"Price Matched ({cur})"
            else:
                state, st = "mismatch", f"Price Mismatch! ({cur})"
            delta = (live - base) if base is not None else None
            con.execute("UPDATE products SET state=?,status=?,live_price=?,currency=?,"
                        "delta=?,rerun_status=?,rerun_at=? WHERE id=?",
                        (state, st, live, cur, delta, st,
                         time.strftime("%Y-%m-%d %H:%M:%S"), pid))
            con.commit()
            recovered += 1
            with RERUN_LOCK:
                RERUN["done"] += 1
                RERUN["recovered"] = recovered
    finally:
        con.close()
        with RERUN_LOCK:
            RERUN["running"] = False
            RERUN["message"] = f"Done. {recovered} recovered, {still} still erroring."


@app.route("/api/review/rerun_status")
def api_rerun_status():
    with RERUN_LOCK:
        return jsonify(dict(RERUN))


@app.route("/api/review/rerun_stop", methods=["POST"])
def api_rerun_stop():
    with RERUN_LOCK:
        RERUN["running"] = False
    return jsonify(ok=True)


@app.route("/api/review/push", methods=["POST"])
def api_push():
    d = request.get_json(force=True) or {}
    pid = d.get("row")
    con = store.connect()
    it = con.execute("SELECT brand,url,final_price,decision FROM products WHERE id=?",
                     (int(pid),)).fetchone()
    if it is None:
        con.close()
        return jsonify(ok=False, error="unknown row"), 404
    if it["decision"] != "approved":
        con.close()
        return jsonify(ok=False, error="approve a final price first"), 400
    res = push_price_to_shopify(it["brand"], it["url"], it["final_price"])
    con.execute("UPDATE products SET shopify_status=?,shopify_at=? WHERE id=?",
                (res["status"], time.strftime("%Y-%m-%d %H:%M:%S"), int(pid)))
    con.commit()
    con.close()
    return jsonify(ok=res["ok"], status=res["status"])


@app.route("/api/review/push_all", methods=["POST"])
def api_push_all():
    with PUSH_LOCK:
        if PUSH["running"]:
            return jsonify(ok=False, error="a push is already running"), 409
    d = request.get_json(silent=True) or {}
    brand = (d.get("brand") or "").strip()
    con = store.connect()
    q = "SELECT id FROM products WHERE decision='approved'" + (" AND brand=?" if brand else "")
    ids = [r["id"] for r in con.execute(q, (brand,) if brand else ()).fetchall()]
    con.close()
    if not ids:
        return jsonify(ok=False, error="no approved rows to push" + (f" for {brand}" if brand else "")), 400
    with PUSH_LOCK:
        PUSH.update(running=True, total=len(ids), done=0, ok=0, failed=0,
                    message=f"Pushing {len(ids)} approved price(s)...")
    threading.Thread(target=_push_all_worker, args=(ids,), daemon=True).start()
    return jsonify(ok=True, total=len(ids))


def _push_all_worker(ids):
    con = store.connect()
    ok = fail = 0
    try:
        for pid in ids:
            with PUSH_LOCK:
                if not PUSH["running"]:
                    break
            it = con.execute("SELECT brand,url,final_price FROM products WHERE id=?", (pid,)).fetchone()
            if it is None:
                continue
            res = push_price_to_shopify(it["brand"], it["url"], it["final_price"])
            con.execute("UPDATE products SET shopify_status=?,shopify_at=? WHERE id=?",
                        (res["status"], time.strftime("%Y-%m-%d %H:%M:%S"), pid))
            con.commit()
            ok, fail = (ok + 1, fail) if res["ok"] else (ok, fail + 1)
            with PUSH_LOCK:
                PUSH["done"] += 1
                PUSH["ok"], PUSH["failed"] = ok, fail
                PUSH["message"] = f"Pushing... {ok} ok, {fail} failed"
    finally:
        con.close()
        with PUSH_LOCK:
            PUSH["running"] = False
            PUSH["message"] = f"Done. {ok} pushed, {fail} failed."


@app.route("/api/review/push_status")
def api_push_status():
    with PUSH_LOCK:
        return jsonify(dict(PUSH))


# ---- Integrations API ----

@app.route("/api/integrations")
def api_integrations():
    con = store.connect()
    brands = con.execute(
        "SELECT brand, COUNT(*) c, SUM(state='mismatch') m FROM products "
        "WHERE brand<>'' GROUP BY brand ORDER BY c DESC").fetchall()
    cfgs = {r["brand"]: dict(r) for r in con.execute("SELECT * FROM integrations").fetchall()}
    con.close()
    out = []
    for b in brands:
        c = cfgs.get(b["brand"], {})
        out.append({"brand": b["brand"], "products": b["c"], "mismatches": b["m"] or 0,
                    "shop_domain": c.get("shop_domain", ""),
                    "api_version": c.get("api_version", "2024-10"),
                    "dry_run": bool(c.get("dry_run", 0)),
                    "has_token": bool(c.get("access_token"))})
    return jsonify(brands=out)


@app.route("/api/integrations/save", methods=["POST"])
def api_int_save():
    d = request.get_json(force=True) or {}
    brand = (d.get("brand") or "").strip()
    if not brand:
        return jsonify(ok=False, error="missing brand"), 400
    con = store.connect()
    existing = con.execute("SELECT access_token FROM integrations WHERE brand=?", (brand,)).fetchone()
    token = (d.get("access_token") or "").strip()
    if not token and existing:  # keep existing token if field left blank
        token = existing["access_token"]
    con.execute("""INSERT INTO integrations(brand,shop_domain,access_token,api_version,dry_run,updated_at)
                   VALUES(?,?,?,?,?,?)
                   ON CONFLICT(brand) DO UPDATE SET shop_domain=excluded.shop_domain,
                     access_token=excluded.access_token, api_version=excluded.api_version,
                     dry_run=excluded.dry_run, updated_at=excluded.updated_at""",
                (brand, (d.get("shop_domain") or "").strip(), token,
                 (d.get("api_version") or "2024-10").strip(),
                 1 if d.get("dry_run") else 0, time.strftime("%Y-%m-%d %H:%M:%S")))
    con.commit()
    con.close()
    return jsonify(ok=True)


@app.route("/api/integrations/verify", methods=["POST"])
def api_int_verify():
    brand = ((request.get_json(silent=True) or {}).get("brand") or "").strip()
    if not brand:
        return jsonify(ok=False, status="missing brand")
    return jsonify(**verify_shopify(brand))


@app.route("/api/integrations/delete", methods=["POST"])
def api_int_delete():
    brand = ((request.get_json(silent=True) or {}).get("brand") or "").strip()
    con = store.connect()
    con.execute("DELETE FROM integrations WHERE brand=?", (brand,))
    con.commit()
    con.close()
    return jsonify(ok=True)


# ---------------------------------------------------------------------------

def serve():
    store.init()  # start empty; the app only works on sheets you import
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    try:
        from waitress import serve as wserve
        print(f"[PriceSync] http://{host}:{port}")
        wserve(app, host=host, port=port, threads=int(os.environ.get("THREADS", "16")))
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    serve()
