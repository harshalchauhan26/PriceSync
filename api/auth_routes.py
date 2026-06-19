"""API layer: authentication routes (login, register, logout, whoami)."""
from flask import (Blueprint, jsonify, redirect, render_template, request,
                   session, url_for)

from core import security
from services import auth_service

auth_bp = Blueprint("auth", __name__)


@auth_bp.route("/login")
def login_page():
    if session.get("uid"):
        return redirect(url_for("home"))
    return render_template("login.html")


@auth_bp.route("/register")
def register_page():
    if session.get("uid"):
        return redirect(url_for("home"))
    return render_template("register.html")


@auth_bp.route("/api/login", methods=["POST"])
def api_login():
    ip = security.client_ip()
    if security.is_locked(ip):
        return jsonify(ok=False, error="too many attempts — try again in a few minutes"), 429
    d = request.get_json(silent=True) or {}
    user = auth_service.authenticate(d.get("email"), d.get("password"))
    if not user:
        security.register_fail(ip)
        return jsonify(ok=False, error="invalid email or password"), 401
    security.clear_fails(ip)
    security.login_user(user)
    return jsonify(ok=True, email=user["email"], role=user["role"])


@auth_bp.route("/api/register", methods=["POST"])
def api_register():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip()
    password = d.get("password") or ""
    if not email or "@" not in email:
        return jsonify(ok=False, error="valid email required"), 400
    if len(password) < 6:
        return jsonify(ok=False, error="password must be at least 6 characters"), 400
    try:
        user = auth_service.register(email, password, role="viewer")
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    security.login_user(user)   # auto sign-in after registering
    return jsonify(ok=True, email=user["email"], role=user["role"])


@auth_bp.route("/logout")
def logout():
    security.logout_user()
    return redirect(url_for("auth.login_page"))


@auth_bp.route("/api/me")
def api_me():
    u = security.current_user()
    if not u:
        return jsonify(error="not authenticated"), 401
    return jsonify(**u)
