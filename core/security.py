"""Core security layer — password hashing, session helpers, access guards."""
from functools import wraps

from flask import session, jsonify, redirect, request, url_for
from werkzeug.security import generate_password_hash, check_password_hash

# Methods that mutate state require the 'admin' role; viewers are read-only.
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Paths reachable without a session.
PUBLIC_PATHS = {"/login", "/api/login", "/healthz"}


def hash_password(pw):
    return generate_password_hash(pw)


def verify_password(pw, hashed):
    try:
        return check_password_hash(hashed, pw)
    except Exception:
        return False


def login_user(user):
    session["uid"] = user["id"]
    session["email"] = user["email"]
    session["role"] = user["role"]
    session.permanent = True


def logout_user():
    session.clear()


def current_user():
    if session.get("uid"):
        return {"id": session["uid"], "email": session.get("email"),
                "role": session.get("role")}
    return None


def is_admin():
    return session.get("role") == "admin"


def _is_public(path):
    return path in PUBLIC_PATHS or path.startswith("/static")


def guard():
    """before_request hook: gate everything, enforce read-only for viewers."""
    path = request.path
    if _is_public(path):
        return None
    if not session.get("uid"):
        if path.startswith("/api/"):
            return jsonify(error="authentication required"), 401
        return redirect(url_for("auth.login_page"))
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


def role_required(role):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **k):
            if session.get("role") != role:
                return jsonify(error=f"{role} role required"), 403
            return fn(*a, **k)
        return wrapper
    return deco
