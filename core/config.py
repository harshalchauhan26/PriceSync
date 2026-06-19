"""Core configuration layer — single place that reads environment/.env."""
import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-insecure-change-me")
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 12  # 12h

    # Seed admin (created on first boot if there are no users yet)
    ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@pricesync.local")
    ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin")

    HOST = os.environ.get("HOST", "127.0.0.1")
    PORT = int(os.environ.get("PORT", "8080"))
    THREADS = int(os.environ.get("THREADS", "16"))
    MAX_UPLOAD_MB = float(os.environ.get("MAX_UPLOAD_MB", "64"))
