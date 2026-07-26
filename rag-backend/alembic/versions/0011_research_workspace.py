"""finish the research workspace: conversation_scope_settings,
message_sources.scope, messages.transparency

Revision ID: 0011_research_workspace
Revises: 0010_research_preferences
Create Date: 2026-07-22 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011_research_workspace"
down_revision: str | Sequence[str] | None = "0010_research_preferences"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "conversation_scope_settings",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("chat_enabled", sa.Boolean(), nullable=False),
        sa.Column("project_enabled", sa.Boolean(), nullable=False),
        sa.Column("general_enabled", sa.Boolean(), nullable=False),
        sa.Column("include_other_project_summaries", sa.Boolean(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("conversation_id"),
    )

    with op.batch_alter_table("message_sources") as batch_op:
        batch_op.add_column(
            sa.Column(
                "scope", sa.String(length=16), nullable=False, server_default="general"
            )
        )

    with op.batch_alter_table("messages") as batch_op:
        batch_op.add_column(
            sa.Column("transparency", sa.JSON(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("messages") as batch_op:
        batch_op.drop_column("transparency")

    with op.batch_alter_table("message_sources") as batch_op:
        batch_op.drop_column("scope")

    op.drop_table("conversation_scope_settings")
