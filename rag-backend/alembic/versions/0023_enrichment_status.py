"""enrichment status tracking (milestone 4.1 — authoritative metadata
enrichment & duplicate awareness)

Revision ID: 0023_enrichment_status
Revises: 0022_bibliographic_metadata
Create Date: 2026-08-15 00:00:00.000000

`documents` gains three new, all-nullable columns recording the outcome of
the most recent Crossref lookup attempt for that document — see
app/core/bibliographic_enrichment_service.py's module docstring for how
they're written. NULL for every existing row means "never enriched," the
honest state for every document that predates this milestone (and every
document without a DOI, which can never be enriched at all) — never a
fabricated default.

`enrichment_status` is a short, fixed-vocabulary string (see
app/core/bibliographic_enrichment_service.py's EnrichmentStatus Literal)
rather than a boolean, so the UI can distinguish "never attempted" from
"attempted but the provider had nothing" from "attempted but the provider
was unreachable" — Section 21's explicit requirement.

Uses batch_alter_table for the same reason migration 0021/0022 do: SQLite
cannot ALTER TABLE ADD COLUMN / ALTER COLUMN outside of a batch operation.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0023_enrichment_status"
down_revision: str | Sequence[str] | None = "0022_bibliographic_metadata"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("last_enriched_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.add_column(sa.Column("enrichment_provider", sa.String(length=40), nullable=True))
        batch_op.add_column(sa.Column("enrichment_status", sa.String(length=40), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("documents", schema=None) as batch_op:
        batch_op.drop_column("enrichment_status")
        batch_op.drop_column("enrichment_provider")
        batch_op.drop_column("last_enriched_at")
