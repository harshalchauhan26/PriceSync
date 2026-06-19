"""API layer: authentication routes (login page, login/logout, whoami)."""
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


@auth_bp.route("/api/login", methods=["POST"])
def api_login():
    d = request.get_json(silent=True) or {}
    user = auth_service.authenticate(d.get("email"), d.get("password"))
    if not user:
        return jsonify(ok=False, error="invalid email or password"), 401
    security.login_user(user)
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
