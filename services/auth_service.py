"""Business logic for authentication / user management."""
from core import security
from repositories import users_repo


def init():
    users_repo.ensure_table()


def authenticate(email, password):
    user = users_repo.get_by_email(email or "")
    if user and security.verify_password(password or "", user["password_hash"]):
        return user
    return None


def register(email, password, role="viewer"):
    if not email or not password:
        raise ValueError("email and password required")
    if users_repo.get_by_email(email):
        raise ValueError("user already exists")
    return users_repo.create(email, security.hash_password(password), role)


def ensure_owner(email, password):
    """Guarantee the configured owner exists with role 'owner' (super-admin)."""
    user = users_repo.get_by_email(email)
    if not user:
        users_repo.create(email, security.hash_password(password), "owner")
        return email + " (created)"
    if user["role"] != "owner":
        users_repo.set_role(email, "owner")
        return email + " (promoted)"
    return None


def set_role(email, role):
    if role not in ("owner", "admin", "viewer"):
        raise ValueError("invalid role")
    users_repo.set_role(email, role)


def delete_user(email):
    users_repo.delete(email)


def list_users():
    return users_repo.list_all()
