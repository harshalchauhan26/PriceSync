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


def seed_admin(email, password):
    """Create the first admin if the users table is empty."""
    if users_repo.count() == 0:
        users_repo.create(email, security.hash_password(password), "admin")
        return email
    return None
