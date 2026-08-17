"""qa account flag (milestone 5.5 part 24)

Revision ID: 0029_qa_account_flag
Revises: 0028_compile_coordination
Create Date: 2026-08-17 00:30:00.000000

Adds `users.is_qa_account` — replaces the previous informal "recognize a
QA account by its email address" convention with a real, explicit
column. Purely informational (never read by any authorization check,
never exposed on UserResponse — see app/db/models_auth.py's own
docstring on this column); settable only via cli/qa_accounts.py, no API
endpoint writes it. Same `server_default=false()` pattern as
0019_zoom_in_mode.py's own boolean-column addition, so every existing
row backfills to False — adding this column can never silently mark an
existing real user's account as a QA account.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0029_qa_account_flag"
down_revision: str | Sequence[str] | None = "0028_compile_coordination"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("is_qa_account", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("is_qa_account")
