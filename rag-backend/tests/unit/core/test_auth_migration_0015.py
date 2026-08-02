"""Migration compatibility for 0015_local_auth_credentials (adds
users.password_hash + the auth_rate_limit_hits table — see
app/db/models_auth.py and app/core/auth_rate_limiter.py).

Runs the real `alembic` CLI as a subprocess against a throwaway temp
SQLite file, with DATABASE_URL overridden in that subprocess's own
environment only — alembic/env.py resolves its target DB from
app.config.get_settings().database_url, which is process-global and
@lru_cache'd, so running in-process against a custom Config would still
silently resolve to this process's real (possibly production) database.
A subprocess is the only way to safely point migrations at a scratch DB
without ever touching the real one.
"""

import os
import sqlite3
import subprocess
import tempfile
import uuid
from pathlib import Path

_RAG_BACKEND_DIR = Path(__file__).resolve().parents[3]
_PRE_MIGRATION_REVISION = "0014_document_job_timings"


def _run_alembic(action: str, revision: str, *, database_url: str) -> None:
    env = {**os.environ, "DATABASE_URL": database_url}
    result = subprocess.run(
        ["python3", "-m", "alembic", action, revision],
        cwd=_RAG_BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, (
        f"alembic failed:\nstdout={result.stdout}\nstderr={result.stderr}"
    )


def _seed_pre_migration_data(db_path: str) -> dict[str, str]:
    """Inserts one row each into users/oauth_accounts/sessions using
    exactly the 0001_auth_core column set (pre-password_hash) — models a
    real production database that predates this migration."""
    user_id = str(uuid.uuid4())
    account_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO users (id, email, email_verified, display_name, avatar_url, "
            "is_active, is_dev_test_user) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, "preexisting@example.com", True, "Pre-existing User", None, True, False),
        )
        conn.execute(
            "INSERT INTO oauth_accounts (id, user_id, provider, provider_account_id, "
            "provider_email) VALUES (?, ?, ?, ?, ?)",
            (account_id, user_id, "google", "google-sub-preexisting", "preexisting@example.com"),
        )
        conn.execute(
            "INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at) "
            "VALUES (?, ?, ?, datetime('now', '+30 days'))",
            (session_id, user_id, "a" * 64),
        )
        conn.commit()
    finally:
        conn.close()
    return {"user_id": user_id, "account_id": account_id, "session_id": session_id}


def test_upgrade_preserves_existing_data_and_adds_new_schema() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", _PRE_MIGRATION_REVISION, database_url=database_url)
        ids = _seed_pre_migration_data(db_path)

        _run_alembic("upgrade", "head", database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "password_hash" in columns

            row = conn.execute(
                "SELECT email, password_hash, is_active FROM users WHERE id = ?",
                (ids["user_id"],),
            ).fetchone()
            assert row is not None
            assert row[0] == "preexisting@example.com"
            assert row[1] is None  # pre-existing OAuth-only user: no password
            assert row[2] == 1

            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM oauth_accounts WHERE id = ?", (ids["account_id"],)
                ).fetchone()[0]
                == 1
            )
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE id = ?", (ids["session_id"],)
                ).fetchone()[0]
                == 1
            )

            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            assert "auth_rate_limit_hits" in tables
        finally:
            conn.close()
    finally:
        os.remove(db_path)


def test_downgrade_removes_new_schema_but_preserves_original_tables_and_rows() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", _PRE_MIGRATION_REVISION, database_url=database_url)
        ids = _seed_pre_migration_data(db_path)
        _run_alembic("upgrade", "head", database_url=database_url)

        _run_alembic("downgrade", _PRE_MIGRATION_REVISION, database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "password_hash" not in columns

            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            assert "auth_rate_limit_hits" not in tables

            row = conn.execute(
                "SELECT email, is_active FROM users WHERE id = ?", (ids["user_id"],)
            ).fetchone()
            assert row is not None
            assert row[0] == "preexisting@example.com"
            assert row[1] == 1

            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM oauth_accounts WHERE id = ?", (ids["account_id"],)
                ).fetchone()[0]
                == 1
            )
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM sessions WHERE id = ?", (ids["session_id"],)
                ).fetchone()[0]
                == 1
            )
        finally:
            conn.close()
    finally:
        os.remove(db_path)
