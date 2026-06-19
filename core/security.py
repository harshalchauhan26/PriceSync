"""Core security layer — passwords, sessions, access guards, rate limiting.

Session registry + rate limiter are in-memory (the app is single-process), which
is exactly what the owner console needs to see "who is active right now".
"""
import secrets
import threading
import time
from functools import wraps

from flask import session, jsonify, redirect, request, url_for
from werkzeug.security import generate_password_hash, check_password_hash

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
PUBLIC_PATHS = {"/login", "/api/login", "/register", "/api/register", "/healthz"}
ADMIN_ROLES = {"admin", "owner"}

# --- live session registry: sid -> {uid,email,role,ip,ua,login_at,last_seen} ---
SESSIONS = {}
_LOCK = threading.Lock()
ACTIVE_WINDOW = 300  # seconds since last_seen to count as "active"

# --- login rate limiter: ip -> [failure timestamps] ---
_FAILS = {}
_MAX_FAILS = 5
_LOCK_WINDOW = 600  # 10 min


def hash_password(pw):
    return generate_password_hash(pw)


def verify_password(pw, hashed):
    try:
        return check_password_hash(hashed, pw)
    except Exception:
        return False


def client_ip():
    xff = request.headers.get("X-Forwarded-For", "")
    return (xff.split(",")[0].strip() if xff else request.remote_addr) or "?"


# ---- rate limiting ----
def is_locked(ip):
    now = time.time()
    fails = [t for t in _FAILS.get(ip, []) if now - t < _LOCK_WINDOW]
    _FAILS[ip] = fails
    return len(fails) >= _MAX_FAILS


def register_fail(ip):
    _FAILS.setdefault(ip, []).append(time.time())


def clear_fails(ip):
    _FAILS.pop(ip, None)


# ---- sessions ----
def login_user(user):
    sid = secrets.token_hex(16)
    session["uid"] = user["id"]
    session["email"] = user["email"]
    session["role"] = user["role"]
    session["sid"] = sid
    session.permanent = True
    with _LOCK:
        SESSIONS[sid] = {"uid": user["id"], "email": user["email"],
                         "role": user["role"], "ip": client_ip(),
                         "ua": request.headers.get("User-Agent", "")[:120],
                         "login_at": time.time(), "last_seen": time.time()}


def logout_user():
    sid = session.get("sid")
    if sid:
        with _LOCK:
            SESSIONS.pop(sid, None)
    session.clear()


def touch():
    sid = session.get("sid")
    if sid:
        with _LOCK:
            s = SESSIONS.get(sid)
            if s:
                s["last_seen"] = time.time()
                s["ip"] = client_ip()


def active_sessions():
    now = time.time()
    with _LOCK:
        out = []
        for sid, s in SESSIONS.items():
            out.append({**s, "sid": sid[:8],
                        "active": (now - s["last_seen"]) < ACTIVE_WINDOW,
                        "idle_s": int(now - s["last_seen"]),
                        "age_s": int(now - s["login_at"])})
    return sorted(out, key=lambda x: -x["last_seen"])


def current_user():
    if session.get("uid"):
        return {"id": session["uid"], "email": session.get("email"),
                "role": session.get("role")}
    return None


def is_admin():
    return session.get("role") in ADMIN_ROLES


def is_owner():
    return session.get("role") == "owner"


def _is_public(path):
    return path in PUBLIC_PATHS or path.startswith("/static")


def guard():
    """before_request: gate everything, enforce read-only for viewers."""
    path = request.path
    if _is_public(path):
        return None
    if not session.get("uid"):
        if path.startswith("/api/"):
            return jsonify(error="authentication required"), 401
        return redirect(url_for("auth.login_page"))
    touch()
    if request.method in WRITE_METHODS and not is_admin():
        return jsonify(error="admin role required for this action"), 403
    return None


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **k):
        if not session.get("uid"):
            return jsonify(error="authentication required"), 401
        return fn(*a, **k)
    return wrapper


def role_required(*roles):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **k):
            if session.get("role") not in roles:
                return jsonify(error=f"requires role: {', '.join(roles)}"), 403
            return fn(*a, **k)
        return wrapper
    return deco


def owner_required(fn):
    return role_required("owner")(fn)
