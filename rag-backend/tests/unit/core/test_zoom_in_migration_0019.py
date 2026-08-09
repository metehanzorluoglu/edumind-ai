"""Migration compatibility for 0019_zoom_in_mode (adds
conversation_scope_settings.zoom_in_mode) — same subprocess-against-a-
scratch-DB technique as test_auth_migration_0015.py/
test_email_verification_migration_0016.py, for the same reason: alembic/
env.py resolves its target DB from the process-global, @lru_cache'd
app.config.get_settings().database_url, so only a real subprocess with
DATABASE_URL overridden in its own environment can safely avoid ever
touching this process's real (possibly production) database.

Proves the milestone's explicit backward-compatibility requirement: a
pre-existing conversation_scope_settings row (created before this
migration ever ran) is backfilled to zoom_in_mode=False, never left NULL
and never defaulted to True.
"""

import os
import sqlite3
import subprocess
import tempfile
import uuid
from pathlib import Path

_RAG_BACKEND_DIR = Path(__file__).resolve().parents[3]
_PRE_MIGRATION_REVISION = "0018_folders"


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


def _seed_pre_migration_scope_row(db_path: str) -> str:
    """One user, one conversation, one conversation_scope_settings row —
    exactly what every conversation that ever loaded its scope toggle bar
    before this migration existed already has."""
    user_id = str(uuid.uuid4())
    conversation_id = str(uuid.uuid4())
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO users (id, email, email_verified, is_active, is_dev_test_user) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, "pre-migration@example.com", True, True, False),
        )
        conn.execute(
            "INSERT INTO conversations (id, user_id, title, title_is_custom) VALUES (?, ?, ?, ?)",
            (conversation_id, user_id, "Untitled", False),
        )
        conn.execute(
            "INSERT INTO conversation_scope_settings "
            "(conversation_id, chat_enabled, project_enabled, general_enabled, "
            "include_other_project_summaries) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, True, True, True, False),
        )
        conn.commit()
    finally:
        conn.close()
    return conversation_id


def test_upgrade_adds_zoom_in_mode_and_backfills_existing_rows_to_false() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", _PRE_MIGRATION_REVISION, database_url=database_url)
        conversation_id = _seed_pre_migration_scope_row(db_path)

        _run_alembic("upgrade", "head", database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute(
                "PRAGMA table_info(conversation_scope_settings)"
            )}
            assert "zoom_in_mode" in columns

            zoom_in_mode = conn.execute(
                "SELECT zoom_in_mode FROM conversation_scope_settings WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()[0]
            assert zoom_in_mode == 0, "pre-existing row must backfill to False, never NULL/True"
        finally:
            conn.close()
    finally:
        os.remove(db_path)


def test_downgrade_removes_zoom_in_mode_column() -> None:
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        database_url = f"sqlite:///{db_path}"
        _run_alembic("upgrade", "head", database_url=database_url)

        _run_alembic("downgrade", _PRE_MIGRATION_REVISION, database_url=database_url)

        conn = sqlite3.connect(db_path)
        try:
            columns = {row[1] for row in conn.execute(
                "PRAGMA table_info(conversation_scope_settings)"
            )}
            assert "zoom_in_mode" not in columns
        finally:
            conn.close()
    finally:
        os.remove(db_path)
