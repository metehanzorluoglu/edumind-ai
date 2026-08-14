"""document highlights: document_highlights (frontend milestone 3 — reader)

Revision ID: 0020_document_highlights
Revises: 0019_zoom_in_mode
Create Date: 2026-08-10 00:00:00.000000

New table only — no existing table is touched, so this is purely additive
and needs no backfill. See app/db/models_documents.py's DocumentHighlight
docstring for the anchor design (chunk_id/chunk_index/page_number,
document_id FK with ondelete=CASCADE so a deleted document never leaves
orphaned highlights behind).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020_document_highlights"
down_revision: str | Sequence[str] | None = "0019_zoom_in_mode"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "document_highlights",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("chunk_id", sa.String(length=36), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("selected_text", sa.Text(), nullable=False),
        sa.Column("note_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("document_highlights", schema=None) as batch_op:
        batch_op.create_index(
            "ix_document_highlights_user_id_document_id", ["user_id", "document_id"]
        )
        batch_op.create_index(
            batch_op.f("ix_document_highlights_user_id"), ["user_id"], unique=False
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("document_highlights", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_document_highlights_user_id"))
        batch_op.drop_index("ix_document_highlights_user_id_document_id")
    op.drop_table("document_highlights")
