"""email verification: users.email_verified_at + email_verification_tokens

Revision ID: 0016_email_verification
Revises: 0015_local_auth_credentials
Create Date: 2026-08-02 00:00:00.000000

Compatibility / backfill policy for pre-existing rows (see
deploy/oracle/README.md's "Migration instructions" for the full writeup):

- Existing users with `email_verified = true` (every OAuth-provider user
  who signed in with a provider-confirmed email — see
  upsert_user_from_identity) get `email_verified_at` backfilled to their
  `created_at`, since the exact original verification moment isn't
  recorded anywhere and `created_at` is the closest true statement
  available ("verified no later than this").
- Existing *local* (password) users predate this feature entirely — they
  were created by POST /auth/register before any verification flow
  existed, so requiring them to suddenly verify would silently lock out
  already-trusted accounts with no warning, which is exactly what this
  migration must avoid (see PHASE 11's own explicit warning). They are
  therefore grandfathered: `email_verified` is set true, backfilled the
  same way, for every pre-existing local user who wasn't already verified.
- Every user created *after* this migration follows the real flow
  (`0` from POST /auth/register until POST /auth/verify-email succeeds) —
  this backfill only ever touches rows that existed before this revision
  ran, never a new one.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0016_email_verification"
down_revision: str | Sequence[str] | None = "0015_local_auth_credentials"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "users", sa.Column("email_verified_at", sa.DateTime(timezone=True), nullable=True)
    )

    op.create_table(
        "email_verification_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_email_verification_tokens_user_id"),
        "email_verification_tokens",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_email_verification_tokens_token_hash"),
        "email_verification_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_email_verification_tokens_expires_at"),
        "email_verification_tokens",
        ["expires_at"],
        unique=False,
    )

    # Backfill 1: already-verified users (OAuth, provider-confirmed email)
    # get email_verified_at set to their created_at.
    op.execute(
        "UPDATE users SET email_verified_at = created_at WHERE email_verified = 1"
    )
    # Backfill 2: grandfather pre-existing local (password) accounts that
    # predate this feature — see the module docstring for why.
    op.execute(
        "UPDATE users SET email_verified = 1, email_verified_at = created_at "
        "WHERE email_verified = 0 AND password_hash IS NOT NULL"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        op.f("ix_email_verification_tokens_expires_at"), table_name="email_verification_tokens"
    )
    op.drop_index(
        op.f("ix_email_verification_tokens_token_hash"), table_name="email_verification_tokens"
    )
    op.drop_index(
        op.f("ix_email_verification_tokens_user_id"), table_name="email_verification_tokens"
    )
    op.drop_table("email_verification_tokens")
    # The grandfather backfill's `email_verified` flips (upgrade()'s
    # Backfill 2) are NOT reversed here — this is the migration's one
    # irreversible aspect (see deploy/oracle/README.md); every other
    # change is fully reversed.
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("email_verified_at")
