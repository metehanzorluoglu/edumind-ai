"""document_jobs: add timings_json column

Revision ID: 0014_document_job_timings
Revises: 0013_document_jobs
Create Date: 2026-08-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0014_document_job_timings"
down_revision: str | Sequence[str] | None = "0013_document_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("document_jobs", sa.Column("timings_json", sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("document_jobs", "timings_json")
