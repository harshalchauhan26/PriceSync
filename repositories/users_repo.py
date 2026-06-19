"""Data-access layer for users (wraps the Supabase connection in store)."""
import time

import store


def ensure_table():
    con = store.connect()
    con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            BIGSERIAL PRIMARY KEY,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'viewer',
            created_at    TIMESTAMPTZ DEFAULT now()
        )""")
    con.commit()
    con.close()


def get_by_email(email):
    con = store.connect()
    r = con.execute("SELECT * FROM users WHERE email=%s", (email.lower().strip(),)).fetchone()
    con.close()
    return dict(r) if r else None


def create(email, password_hash, role="viewer"):
    con = store.connect()
    con.execute(
        "INSERT INTO users(email,password_hash,role) VALUES(%s,%s,%s) "
        "ON CONFLICT(email) DO NOTHING",
        (email.lower().strip(), password_hash, role))
    con.commit()
    con.close()
    return get_by_email(email)


def set_password(email, password_hash):
    con = store.connect()
    con.execute("UPDATE users SET password_hash=%s WHERE email=%s",
                (password_hash, email.lower().strip()))
    con.commit()
    con.close()


def count():
    con = store.connect()
    n = con.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    con.close()
    return n


def list_all():
    con = store.connect()
    rows = con.execute("SELECT id,email,role,created_at FROM users ORDER BY id").fetchall()
    con.close()
    return [dict(r) for r in rows]
