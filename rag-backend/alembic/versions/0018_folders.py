"""folders: document library / folder management (milestone 1)

Revision ID: 0018_folders
Revises: 0017_message_generation_status
Create Date: 2026-08-07 00:00:00.000000

Adds the `folders` table (self-referencing parent_id for nested folders)
and `documents.folder_id` (nullable — NULL means "root/unfiled", the exact
placement every pre-existing document already has, so this migration
requires no backfill). See app/db/models_folders.py and
app/db/models_documents.py's `folder_id` docstring for the full reasoning,
in particular why there is deliberately no DB-level UNIQUE constraint on
folder name-per-parent (NULL-distinctness in SQL would make it inconsistent
between root and nested folders; enforced in app code instead).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018_folders"
down_revision: str | Sequence[str] | None = "0017_message_generation_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "folders",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
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
        sa.ForeignKeyConstraint(["parent_id"], ["folders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_folders_user_id"), "folders", ["user_id"], unique=False)
    op.create_index(
        "ix_folders_user_id_parent_id", "folders", ["user_id", "parent_id"], unique=False
    )

    op.add_column("documents", sa.Column("folder_id", sa.Uuid(), nullable=True))
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.create_foreign_key(
            "fk_documents_folder_id", "folders", ["folder_id"], ["id"], ondelete="SET NULL"
        )
        batch_op.create_index(
            "ix_documents_user_id_folder_id", ["user_id", "folder_id"], unique=False
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.drop_index("ix_documents_user_id_folder_id")
        batch_op.drop_constraint("fk_documents_folder_id", type_="foreignkey")
        batch_op.drop_column("folder_id")

    op.drop_index("ix_folders_user_id_parent_id", table_name="folders")
    op.drop_index(op.f("ix_folders_user_id"), table_name="folders")
    op.drop_table("folders")
