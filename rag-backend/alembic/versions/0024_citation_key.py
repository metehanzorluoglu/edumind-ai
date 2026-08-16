"""citation key (milestone 4.2 — citation & bibtex foundation)

Revision ID: 0024_citation_key
Revises: 0023_enrichment_status
Create Date: 2026-08-15 00:00:00.000000

`documents` gains one new, nullable column: `citation_key`, the
deterministic BibTeX/citation key (see app/core/citation_key.py) generated
once and persisted so it stays STABLE across future metadata edits
(Section 16/17 — "do not silently regenerate a previously persisted
citation key ... if it is already exposed externally").

NULL for every existing row — this migration does NOT backfill a value
for any pre-existing document (Section 17: "do not force a migration that
rewrites every existing row unnecessarily"). Every row gets its key
lazily, the first time one is actually needed, via
DocumentsRepository.get_or_create_citation_key — a self-healing read path,
not a bulk write here.

Uses batch_alter_table for the same reason migrations 0021/0022/0023 do:
SQLite cannot ALTER TABLE ADD COLUMN outside of a batch operation.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0024_citation_key"
down_revision: str | Sequence[str] | None = "0023_enrichment_status"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.add_column(sa.Column("citation_key", sa.String(length=120), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.drop_column("citation_key")
