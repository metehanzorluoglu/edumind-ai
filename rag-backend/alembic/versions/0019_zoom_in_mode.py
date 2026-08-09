"""zoom-in / strict selected-source mode (milestone 4)

Revision ID: 0019_zoom_in_mode
Revises: 0018_folders
Create Date: 2026-08-08 00:00:00.000000

Adds `conversation_scope_settings.zoom_in_mode` (nullable=False,
default/server_default False) — minimal, backward-compatible extension of
the existing per-conversation "active scope" toggle bar (see
app/db/models_conversation_scope.py) rather than a new table, per the
milestone's "extend, don't duplicate" instruction. `server_default=false`
means every pre-existing row (every conversation that already has a
lazily-created settings row) is backfilled to `zoom_in_mode=False` — the
exact "keep behaving exactly as before" default: no existing conversation
is silently placed into strict mode by this migration.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019_zoom_in_mode"
down_revision: str | Sequence[str] | None = "0018_folders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("conversation_scope_settings", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "zoom_in_mode", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("conversation_scope_settings", schema=None) as batch_op:
        batch_op.drop_column("zoom_in_mode")
