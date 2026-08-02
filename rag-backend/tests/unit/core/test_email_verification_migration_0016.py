"""Migration compatibility for 0016_email_verification (adds
users.email_verified_at + the email_verification_tokens table, plus the
backfill/grandfather policy for pre-existing rows — see the migration's
own module docstring and deploy/oracle/README.md's "Migration
instructions").

Same subprocess-against-a-scratch-DB technique as
test_auth_migration_0015.py, for the same reason: alembic/env.py resolves
its target DB from the process-global, @lru_cache'd
app.config.get_settings().database_url, so only a real subprocess with
DATABASE_URL overridden in its own environment can safely avoid ever
touching this process's real (possibly production) database.
"""

import os
import sqlite3
import subprocess
import tempfile
import uuid
from pathlib import Path

_RAG_BACKEND_DIR = Path(__file__).resolve().parents[3]
_PRE_MIGRATION_REVISION = "0015_local_auth_credentials"


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


def _seed_pre_migration_users(db_path: str) -> dict[str, str]:
    """Three pre-existing users covering every backfill/grandfather case
    this migration must handle correctly:
    - oauth_verified: OAuth, already verified -> gets email_verified_at
      backfilled to created_at, stays verified.
    - oauth_unverified: OAuth, never verified -> stays unverified, no
      email_verified_at.
    - local_preexisting: local (password) account that predates this
      feature, was never verified under the old code -> grandfathered to
      verified, email_verified_at backfilled to created_at.
    """
    ids = {
        "oauth_verified": str(uuid.uuid4()),
        "oauth_unverified": str(uuid.uuid4()),
        "local_preexisting": str(uuid.uuid4()),
    }
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO users (id, email, email_verified, display_name, avatar_url, "
            "is_active, is_dev_test_user, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ids["oauth_verified"],
                "oauth-verified@example.com",
                True,
                None,
                None,
                True,
                False,
                None,
            ),
        )
        conn.execute(
            "INSERT INTO users (id, email, email_verified, display_name, avatar_url, "
            "is_active, is_dev_test_user, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ids["oauth_unverified"],
                "oauth-unverified@example.com",
                False,
                None,
                None,
                True,
                False,
                None,
            ),
        )
        conn.execute(
            "INSERT INTO users (id, email, email_verified, display_name, avatar_url, "
            "is_active, is_dev_test_user, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ids["local_preexisting"],
                "local-preexisting@example.com",
                False,
                None,
                None,
                True,
                False,
                "$argon2id$v=19$m=65536,t=3,p=4$fakehashfortest$fakehashfortest",
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return ids


def test_upgrade_backfills_email_verified_at_and_grandfathers_local_users() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", _PRE_MIGRATION_REVISION, database_url=database_url)
        ids = _seed_pre_migration_users(db_path)

        _run_alembic("upgrade", "head", database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "email_verified_at" in columns

            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            assert "email_verification_tokens" in tables

            oauth_verified = conn.execute(
                "SELECT email_verified, email_verified_at FROM users WHERE id = ?",
                (ids["oauth_verified"],),
            ).fetchone()
            assert oauth_verified[0] == 1
            assert oauth_verified[1] is not None

            oauth_unverified = conn.execute(
                "SELECT email_verified, email_verified_at FROM users WHERE id = ?",
                (ids["oauth_unverified"],),
            ).fetchone()
            assert oauth_unverified[0] == 0
            assert oauth_unverified[1] is None

            local_preexisting = conn.execute(
                "SELECT email_verified, email_verified_at FROM users WHERE id = ?",
                (ids["local_preexisting"],),
            ).fetchone()
            # Grandfathered: a pre-existing local account predating this
            # feature must not be silently locked out.
            assert local_preexisting[0] == 1
            assert local_preexisting[1] is not None
        finally:
            conn.close()
    finally:
        os.remove(db_path)


def test_downgrade_removes_new_schema_but_preserves_users() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", _PRE_MIGRATION_REVISION, database_url=database_url)
        ids = _seed_pre_migration_users(db_path)
        _run_alembic("upgrade", "head", database_url=database_url)

        _run_alembic("downgrade", _PRE_MIGRATION_REVISION, database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "email_verified_at" not in columns

            tables = {
                row[0]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            assert "email_verification_tokens" not in tables

            for user_id in ids.values():
                row = conn.execute(
                    "SELECT id FROM users WHERE id = ?", (user_id,)
                ).fetchone()
                assert row is not None
        finally:
            conn.close()
    finally:
        os.remove(db_path)
