"""research scopes: conversation_documents, project_documents,
project_attachments, conversation_notes, project_notes

Revision ID: 0007_research_scopes
Revises: 0006_chat_attachments
Create Date: 2026-07-22 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007_research_scopes"
down_revision: str | Sequence[str] | None = "0006_chat_attachments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "conversation_documents",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("conversation_id", "document_id"),
    )
    op.create_index(
        "ix_conversation_documents_document_id",
        "conversation_documents",
        ["document_id"],
        unique=False,
    )

    op.create_table(
        "project_documents",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id", "document_id"),
    )
    op.create_index(
        "ix_project_documents_document_id", "project_documents", ["document_id"], unique=False
    )

    op.create_table(
        "project_attachments",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("message_attachment_id", sa.Uuid(), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["message_attachment_id"], ["message_attachments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("project_id", "message_attachment_id"),
    )
    op.create_index(
        "ix_project_attachments_message_attachment_id",
        "project_attachments",
        ["message_attachment_id"],
        unique=False,
    )

    op.create_table(
        "conversation_notes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_conversation_notes_conversation_id",
        "conversation_notes",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_conversation_notes_user_id", "conversation_notes", ["user_id"], unique=False
    )

    op.create_table(
        "project_notes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_project_notes_project_id", "project_notes", ["project_id"], unique=False)
    op.create_index("ix_project_notes_user_id", "project_notes", ["user_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_project_notes_user_id", table_name="project_notes")
    op.drop_index("ix_project_notes_project_id", table_name="project_notes")
    op.drop_table("project_notes")

    op.drop_index("ix_conversation_notes_user_id", table_name="conversation_notes")
    op.drop_index("ix_conversation_notes_conversation_id", table_name="conversation_notes")
    op.drop_table("conversation_notes")

    op.drop_index(
        "ix_project_attachments_message_attachment_id", table_name="project_attachments"
    )
    op.drop_table("project_attachments")

    op.drop_index("ix_project_documents_document_id", table_name="project_documents")
    op.drop_table("project_documents")

    op.drop_index("ix_conversation_documents_document_id", table_name="conversation_documents")
    op.drop_table("conversation_documents")
