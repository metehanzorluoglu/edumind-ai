"""project corpus: promoted-attachment tracking columns

Adds message_attachments.promoted_document_id (which Document a chat
attachment was ingested into, if it ever was) and
project_attachments.document_id (the same, from the project side) — both
nullable, both tables have zero real-world rows for these new concepts at
the time of this migration, so no backfill is needed.

Revision ID: 0008_project_corpus
Revises: 0007_research_scopes
Create Date: 2026-07-22 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008_project_corpus"
down_revision: str | Sequence[str] | None = "0007_research_scopes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("message_attachments") as batch_op:
        batch_op.add_column(
            sa.Column("promoted_document_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_message_attachments_promoted_document_id",
            "documents",
            ["promoted_document_id"],
            ["document_id"],
            ondelete="SET NULL",
        )
    op.create_index(
        "ix_message_attachments_promoted_document_id",
        "message_attachments",
        ["promoted_document_id"],
        unique=False,
    )

    with op.batch_alter_table("project_attachments") as batch_op:
        batch_op.add_column(sa.Column("document_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_project_attachments_document_id",
            "documents",
            ["document_id"],
            ["document_id"],
            ondelete="CASCADE",
        )
    op.create_index(
        "ix_project_attachments_document_id", "project_attachments", ["document_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_project_attachments_document_id", table_name="project_attachments")
    with op.batch_alter_table("project_attachments") as batch_op:
        batch_op.drop_constraint("fk_project_attachments_document_id", type_="foreignkey")
        batch_op.drop_column("document_id")

    op.drop_index(
        "ix_message_attachments_promoted_document_id", table_name="message_attachments"
    )
    with op.batch_alter_table("message_attachments") as batch_op:
        batch_op.drop_constraint("fk_message_attachments_promoted_document_id", type_="foreignkey")
        batch_op.drop_column("promoted_document_id")
