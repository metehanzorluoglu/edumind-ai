"""writing import sessions (milestone 5.4 — LaTeX templates & project
import)

Revision ID: 0027_writing_import_sessions
Revises: 0026_writing_project_files
Create Date: 2026-08-16 00:00:00.000000

Adds `writing_import_sessions` — the short-lived "upload -> inspect ->
preview -> confirm" record described in app/db/models_writing.py's
WritingImportSession docstring. Pure schema addition, no data migration
(this table has no pre-M5.4 equivalent to migrate from). Curated
templates (Part 19) are NOT a database concept at all — they live as
static files under app/templates/writing_templates/ — so there is
nothing to migrate for them either.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0027_writing_import_sessions"
down_revision: str | Sequence[str] | None = "0026_writing_project_files"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "writing_import_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("original_filename", sa.String(length=255), nullable=False),
        sa.Column("storage_key", sa.String(length=300), nullable=False),
        sa.Column("inspection_json", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_writing_import_sessions_user_id", "writing_import_sessions", ["user_id"], unique=False
    )
    op.create_index(
        "ix_writing_import_sessions_expires_at",
        "writing_import_sessions",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_writing_import_sessions_expires_at", table_name="writing_import_sessions")
    op.drop_index("ix_writing_import_sessions_user_id", table_name="writing_import_sessions")
    op.drop_table("writing_import_sessions")
