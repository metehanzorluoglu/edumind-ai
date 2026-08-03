"""messages: status/error_message/parent_message_id/generation_started_at

Revision ID: 0017_message_generation_status
Revises: 0016_email_verification
Create Date: 2026-08-02 23:00:00.000000

Backs the stream-disconnect-recovery redesign (QA finding BUG-1): an
assistant reply is now persisted incrementally by a server-side background
thread that is not tied to the client's HTTP/SSE connection, so a dropped
browser connection (e.g. a QUIC transport failure) no longer discards a
generation that finished successfully on the backend.

- `status`: 'generating' | 'complete' | 'error' | 'cancelled' | 'interrupted'.
  Every pre-existing row is backfilled to 'complete' — under the old
  synchronous design, a message only ever existed in the database once its
  generation had already fully finished, so 'complete' is the only truthful
  value for history that predates this column.
- `error_message`: set only for status='error' (an LLM/provider failure);
  never populated with anything privacy-sensitive.
- `parent_message_id`: self-referential FK, set only on assistant messages,
  pointing at the user message that triggered them — how a retry/reconnect
  looks up "does a reply already exist for this question" without needing a
  separate index table. NULL for every user message and for assistant
  messages persisted before this column existed (their originating user
  message is not reliably recoverable from data alone).
- `generation_started_at`: when the background worker began (or resumed) an
  attempt — used only to detect/report a message stuck in 'generating' for
  implausibly long (e.g. after an unclean process restart never got the
  chance to run the startup interrupted-sweep — see
  app/core/generation_manager.py).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0017_message_generation_status"
down_revision: str | Sequence[str] | None = "0016_email_verification"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "messages",
        sa.Column("status", sa.String(length=20), nullable=False, server_default="complete"),
    )
    op.add_column("messages", sa.Column("error_message", sa.Text(), nullable=True))
    op.add_column(
        "messages", sa.Column("parent_message_id", sa.Uuid(as_uuid=True), nullable=True)
    )
    op.add_column(
        "messages",
        sa.Column("generation_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    with op.batch_alter_table("messages", schema=None) as batch_op:
        batch_op.create_foreign_key(
            "fk_messages_parent_message_id",
            "messages",
            ["parent_message_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch_op.create_index(
            "ix_messages_parent_message_id", ["parent_message_id"], unique=False
        )

    # Backfill: every existing row was, by construction of the old
    # synchronous design, already a finished message.
    op.execute("UPDATE messages SET status = 'complete' WHERE status IS NULL")


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("messages", schema=None) as batch_op:
        batch_op.drop_index("ix_messages_parent_message_id")
        batch_op.drop_constraint("fk_messages_parent_message_id", type_="foreignkey")
        batch_op.drop_column("generation_started_at")
        batch_op.drop_column("parent_message_id")
        batch_op.drop_column("error_message")
        batch_op.drop_column("status")
