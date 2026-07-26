"""messages: add client_message_id for send idempotency

Revision ID: 0004_message_client_id
Revises: 0003_conversations
Create Date: 2026-07-21 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_message_client_id"
down_revision: str | Sequence[str] | None = "0003_conversations"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("messages", sa.Column("client_message_id", sa.String(length=64), nullable=True))
    op.create_index(
        "ux_messages_conversation_id_client_message_id",
        "messages",
        ["conversation_id", "client_message_id"],
        unique=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ux_messages_conversation_id_client_message_id", table_name="messages")
    op.drop_column("messages", "client_message_id")
