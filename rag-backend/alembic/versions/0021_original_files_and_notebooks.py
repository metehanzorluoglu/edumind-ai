"""original document files + dual-anchor highlights + notebooks (frontend
milestone 3.1 — original document reader & research notes workspace)

Revision ID: 0021_original_files_and_notebooks
Revises: 0020_document_highlights
Create Date: 2026-08-10 00:00:00.000000

Three additive changes, none of which touch existing data:

1. `documents` gains storage_key/original_mime_type/original_file_size_bytes
   (all nullable) — see app/services/document_file_storage.py. Every
   existing row gets NULL, which is exactly the correct "no original file
   retained" state for a document ingested before this milestone (the
   Reader's legacy-fallback signal).
2. `document_highlights.chunk_id`/`chunk_index` become nullable (a PDF
   visual-only highlight may have no semantic anchor — see
   DocumentHighlight's docstring) and gain `visual_anchor_json`. Uses
   batch_alter_table because SQLite cannot ALTER COLUMN in place.
3. New `notebooks` / `notebook_entries` tables (M3.1 Notebook spec) —
   deliberately no FK from notebook_entries to document_highlights/documents
   (see NotebookEntry's docstring for why: preservation semantics require
   entries to survive deletion of either).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0021_original_files_and_notebooks"
down_revision: str | Sequence[str] | None = "0020_document_highlights"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.add_column(sa.Column("storage_key", sa.String(length=600), nullable=True))
        batch_op.add_column(sa.Column("original_mime_type", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("original_file_size_bytes", sa.Integer(), nullable=True))

    with op.batch_alter_table("document_highlights", schema=None) as batch_op:
        batch_op.alter_column("chunk_id", existing_type=sa.String(length=36), nullable=True)
        batch_op.alter_column("chunk_index", existing_type=sa.Integer(), nullable=True)
        batch_op.add_column(sa.Column("visual_anchor_json", sa.Text(), nullable=True))

    op.create_table(
        "notebooks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("notebooks", schema=None) as batch_op:
        batch_op.create_index("ix_notebooks_user_id_created_at", ["user_id", "created_at"])
        batch_op.create_index(batch_op.f("ix_notebooks_user_id"), ["user_id"], unique=False)

    op.create_table(
        "notebook_entries",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("notebook_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("entry_type", sa.String(length=20), nullable=False),
        sa.Column("highlight_id", sa.Uuid(), nullable=True),
        sa.Column("document_id", sa.String(length=36), nullable=True),
        sa.Column("document_title_snapshot", sa.String(length=1024), nullable=True),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column("excerpt_snapshot", sa.Text(), nullable=True),
        sa.Column("note_text", sa.Text(), nullable=True),
        sa.Column("chunk_id_snapshot", sa.String(length=36), nullable=True),
        sa.Column("chunk_index_snapshot", sa.Integer(), nullable=True),
        sa.Column("visual_anchor_snapshot_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        # Deliberately NO ForeignKeyConstraint to notebook_entries.document_id
        # / a highlights table — see NotebookEntry's docstring. `notebook_id`
        # DOES cascade (deleting the whole notebook legitimately removes its
        # entries — see NotebooksRepository.delete, which also does this
        # explicitly since SQLite doesn't enforce declared FK actions).
        sa.ForeignKeyConstraint(["notebook_id"], ["notebooks.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("notebook_entries", schema=None) as batch_op:
        batch_op.create_index(
            "ix_notebook_entries_notebook_id_created_at", ["notebook_id", "created_at"]
        )
        batch_op.create_index(
            "ix_notebook_entries_notebook_id_highlight_id", ["notebook_id", "highlight_id"]
        )
        batch_op.create_index(batch_op.f("ix_notebook_entries_notebook_id"), ["notebook_id"], unique=False)
        batch_op.create_index(batch_op.f("ix_notebook_entries_user_id"), ["user_id"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("notebook_entries", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_notebook_entries_user_id"))
        batch_op.drop_index(batch_op.f("ix_notebook_entries_notebook_id"))
        batch_op.drop_index("ix_notebook_entries_notebook_id_highlight_id")
        batch_op.drop_index("ix_notebook_entries_notebook_id_created_at")
    op.drop_table("notebook_entries")

    with op.batch_alter_table("notebooks", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_notebooks_user_id"))
        batch_op.drop_index("ix_notebooks_user_id_created_at")
    op.drop_table("notebooks")

    with op.batch_alter_table("document_highlights", schema=None) as batch_op:
        batch_op.drop_column("visual_anchor_json")
        batch_op.alter_column("chunk_index", existing_type=sa.Integer(), nullable=False)
        batch_op.alter_column("chunk_id", existing_type=sa.String(length=36), nullable=False)

    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.drop_column("original_file_size_bytes")
        batch_op.drop_column("original_mime_type")
        batch_op.drop_column("storage_key")
