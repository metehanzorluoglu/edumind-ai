"""local auth: users.password_hash + auth_rate_limit_hits

Revision ID: 0015_local_auth_credentials
Revises: 0014_document_job_timings
Create Date: 2026-08-02 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015_local_auth_credentials"
down_revision: str | Sequence[str] | None = "0014_document_job_timings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable ADD COLUMN — a plain, non-batch operation SQLite supports
    # natively (unlike dropping/altering an existing column, which would
    # need batch mode). Existing rows all get NULL, meaning "no local
    # password credential" — every pre-existing OAuth-only user remains
    # exactly as valid as before this migration.
    op.add_column("users", sa.Column("password_hash", sa.String(length=255), nullable=True))

    op.create_table(
        "auth_rate_limit_hits",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("bucket_key", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_auth_rate_limit_hits_bucket_key"),
        "auth_rate_limit_hits",
        ["bucket_key"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_auth_rate_limit_hits_bucket_key"), table_name="auth_rate_limit_hits")
    op.drop_table("auth_rate_limit_hits")
    # SQLite's ALTER TABLE has no native DROP COLUMN — Alembic's batch mode
    # rebuilds the table under the hood (copy-and-swap) to emulate it. Any
    # password_hash values written after upgrade() are lost on downgrade;
    # this is the one irreversible aspect of this migration (see
    # deploy/oracle/README.md's migration notes) — every other table/row
    # (users, oauth_accounts, sessions, oauth_transactions, and every other
    # column on users) is left fully intact.
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("password_hash")
