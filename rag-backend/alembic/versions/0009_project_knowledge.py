"""project memory: project_knowledge_items

Revision ID: 0009_project_knowledge
Revises: 0008_project_corpus
Create Date: 2026-07-22 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009_project_knowledge"
down_revision: str | Sequence[str] | None = "0008_project_corpus"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "project_knowledge_items",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("research_topic", sa.Text(), nullable=False),
        sa.Column("research_question", sa.Text(), nullable=False),
        sa.Column("key_concepts", sa.JSON(), nullable=False),
        sa.Column("methodology", sa.Text(), nullable=False),
        sa.Column("frameworks", sa.JSON(), nullable=False),
        sa.Column("analysis_techniques", sa.JSON(), nullable=False),
        sa.Column("decisions", sa.JSON(), nullable=False),
        sa.Column("open_questions", sa.JSON(), nullable=False),
        sa.Column("keywords", sa.JSON(), nullable=False),
        sa.Column("referenced_documents", sa.JSON(), nullable=False),
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
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_project_knowledge_items_project_id", "project_knowledge_items", ["project_id"]
    )
    op.create_index(
        "ix_project_knowledge_items_conversation_id",
        "project_knowledge_items",
        ["conversation_id"],
    )
    op.create_index(
        "ix_project_knowledge_items_user_id", "project_knowledge_items", ["user_id"]
    )
    op.create_index(
        "ix_project_knowledge_items_project_id_status",
        "project_knowledge_items",
        ["project_id", "status"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_project_knowledge_items_project_id_status", table_name="project_knowledge_items"
    )
    op.drop_index("ix_project_knowledge_items_user_id", table_name="project_knowledge_items")
    op.drop_index(
        "ix_project_knowledge_items_conversation_id", table_name="project_knowledge_items"
    )
    op.drop_index("ix_project_knowledge_items_project_id", table_name="project_knowledge_items")
    op.drop_table("project_knowledge_items")
