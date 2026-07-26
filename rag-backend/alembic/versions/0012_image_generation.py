"""image generation: message_attachments generation metadata

Revision ID: 0012_image_generation
Revises: 0011_research_workspace
Create Date: 2026-07-23 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012_image_generation"
down_revision: str | Sequence[str] | None = "0011_research_workspace"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("message_attachments") as batch_op:
        batch_op.add_column(
            sa.Column("source", sa.String(length=20), nullable=False, server_default="upload")
        )
        batch_op.add_column(sa.Column("generation_prompt", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("generation_negative_prompt", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("generation_seed", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("generation_model", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("generation_width", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("generation_height", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("saved_project_id", sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            "fk_message_attachments_saved_project_id",
            "projects",
            ["saved_project_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("message_attachments") as batch_op:
        batch_op.drop_constraint("fk_message_attachments_saved_project_id", type_="foreignkey")
        batch_op.drop_column("saved_project_id")
        batch_op.drop_column("generation_height")
        batch_op.drop_column("generation_width")
        batch_op.drop_column("generation_model")
        batch_op.drop_column("generation_seed")
        batch_op.drop_column("generation_negative_prompt")
        batch_op.drop_column("generation_prompt")
        batch_op.drop_column("source")
