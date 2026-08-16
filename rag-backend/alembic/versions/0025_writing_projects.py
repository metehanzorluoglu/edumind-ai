"""writing projects: writing_projects, writing_project_documents
(milestone 5 — academic writing & latex foundation)

Revision ID: 0025_writing_projects
Revises: 0024_citation_key
Create Date: 2026-08-15 00:00:00.000000

Two new tables, both entirely additive — no existing table is touched.
See app/db/models_writing.py for the full architecture reasoning (why
this is NOT built on the existing `projects`/`project_documents` tables).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0025_writing_projects"
down_revision: str | Sequence[str] | None = "0024_citation_key"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "writing_projects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("main_tex_content", sa.Text(), nullable=False),
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
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_writing_projects_user_id"), "writing_projects", ["user_id"], unique=False
    )
    op.create_index(
        "ix_writing_projects_user_id_updated_at",
        "writing_projects",
        ["user_id", "updated_at"],
        unique=False,
    )

    op.create_table(
        "writing_project_documents",
        sa.Column("writing_project_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column(
            "added_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["writing_project_id"], ["writing_projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["document_id"], ["documents.document_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("writing_project_id", "document_id"),
    )
    op.create_index(
        "ix_writing_project_documents_document_id",
        "writing_project_documents",
        ["document_id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_writing_project_documents_document_id", table_name="writing_project_documents"
    )
    op.drop_table("writing_project_documents")
    op.drop_index("ix_writing_projects_user_id_updated_at", table_name="writing_projects")
    op.drop_index(op.f("ix_writing_projects_user_id"), table_name="writing_projects")
    op.drop_table("writing_projects")
