"""API layer: owner-only console (live sessions, jobs, user management)."""
from flask import Blueprint, jsonify, request

from core import security
from services import auth_service

admin_bp = Blueprint("admin", __name__)


@admin_bp.route("/api/admin/sessions")
@security.owner_required
def sessions():
    return jsonify(sessions=security.active_sessions())


@admin_bp.route("/api/admin/users")
@security.owner_required
def users():
    out = []
    for u in auth_service.list_users():
        u = dict(u)
        u["created_at"] = str(u.get("created_at"))
        out.append(u)
    return jsonify(users=out)


@admin_bp.route("/api/admin/users/role", methods=["POST"])
@security.owner_required
def set_role():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip()
    role = (d.get("role") or "").strip()
    try:
        auth_service.set_role(email, role)
    except ValueError as exc:
        return jsonify(ok=False, error=str(exc)), 400
    return jsonify(ok=True)


@admin_bp.route("/api/admin/users/delete", methods=["POST"])
@security.owner_required
def delete_user():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip()
    if security.current_user() and email == security.current_user()["email"]:
        return jsonify(ok=False, error="you can't delete your own account"), 400
    auth_service.delete_user(email)
    return jsonify(ok=True)
