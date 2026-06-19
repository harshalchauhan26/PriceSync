"""Symmetric encryption for secrets at rest (e.g. Shopify access tokens).

Key is derived from SECRET_KEY so there's nothing extra to manage. Values are
stored with an 'enc:' prefix; legacy plaintext (no prefix) is read as-is so
existing rows keep working until they're next saved.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from core.config import Config

_PREFIX = "enc:"


def _fernet():
    key = base64.urlsafe_b64encode(hashlib.sha256(Config.SECRET_KEY.encode()).digest())
    return Fernet(key)


def encrypt(value):
    if not value:
        return value
    return _PREFIX + _fernet().encrypt(value.encode()).decode()


def decrypt(value):
    if not value or not value.startswith(_PREFIX):
        return value  # legacy plaintext or empty
    try:
        return _fernet().decrypt(value[len(_PREFIX):].encode()).decode()
    except InvalidToken:
        return ""
