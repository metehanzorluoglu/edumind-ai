"""bibliographic metadata + provenance (milestone 4 — reference library &
bibliographic metadata foundation)

Revision ID: 0022_bibliographic_metadata
Revises: 0021_original_files_and_notebooks
Create Date: 2026-08-14 00:00:00.000000

Two additive changes, neither touching existing data beyond the safe
defaults below:

1. `documents` gains nine new columns: volume/issue/page_start/page_end/
   publisher/abstract/language (all nullable — NULL for every existing row,
   which is the honest "never extracted/entered" state, not a fabricated
   default), plus keywords/metadata_sources (JSON, NOT NULL, defaulting to
   `[]`/`{}` for every existing row — same "empty already means honestly
   unknown" reasoning as `authors` already uses, see Document's docstring).
2. `notebook_entries` gains document_authors_snapshot/
   document_publication_year_snapshot (both nullable, NULL for every
   existing entry) — same snapshot-at-add-time semantics as the existing
   `document_title_snapshot` column, extended to cover author/year.

Uses batch_alter_table throughout because SQLite cannot ALTER TABLE ADD
COLUMN with a non-constant default directly, and cannot ALTER COLUMN at
all — same reasoning as migration 0021.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0022_bibliographic_metadata"
down_revision: str | Sequence[str] | None = "0021_original_files_and_notebooks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.add_column(sa.Column("volume", sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column("issue", sa.String(length=50), nullable=True))
        batch_op.add_column(sa.Column("page_start", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("page_end", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("publisher", sa.String(length=512), nullable=True))
        batch_op.add_column(sa.Column("abstract", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("language", sa.String(length=16), nullable=True))
        batch_op.add_column(
            sa.Column("keywords", sa.JSON(), nullable=False, server_default="[]")
        )
        batch_op.add_column(
            sa.Column("metadata_sources", sa.JSON(), nullable=False, server_default="{}")
        )

    with op.batch_alter_table("notebook_entries", schema=None) as batch_op:
        batch_op.add_column(sa.Column("document_authors_snapshot", sa.JSON(), nullable=True))
        batch_op.add_column(
            sa.Column("document_publication_year_snapshot", sa.Integer(), nullable=True)
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("notebook_entries", schema=None) as batch_op:
        batch_op.drop_column("document_publication_year_snapshot")
        batch_op.drop_column("document_authors_snapshot")

    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.drop_column("metadata_sources")
        batch_op.drop_column("keywords")
        batch_op.drop_column("language")
        batch_op.drop_column("abstract")
        batch_op.drop_column("publisher")
        batch_op.drop_column("page_end")
        batch_op.drop_column("page_start")
        batch_op.drop_column("issue")
        batch_op.drop_column("volume")
