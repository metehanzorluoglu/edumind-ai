"""shared compile coordination (milestone 5.5 part 22/23)

Revision ID: 0028_compile_coordination
Revises: 0027_writing_import_sessions
Create Date: 2026-08-17 00:00:00.000000

Fixes a known gap flagged by WritingImportSession's own docstring
(0027): the backend runs 2 uvicorn workers, and compile coordination was
entirely in-process (app/core/compile_artifact_cache.py's PDF cache,
app/core/rate_limiter.py's per-user compile rate limit, routes_writing.py's
own `_compiling_projects` in-process set) — invisible across workers, so
a compile POST landing on worker A and the follow-up PDF GET landing on
worker B could silently 404, a rate-limit burst split across both
workers could each see an empty local window, and two workers could
each start their own compile for the same project simultaneously.

Adds:
- `compile_artifacts` — mirrors `writing_import_sessions` exactly (a DB
  row carrying `expires_at`; the PDF bytes themselves live on the shared
  `/data`-mounted volume via CompileArtifactStorage).
- `compile_rate_limit_hits` — mirrors `auth_rate_limit_hits` exactly (a
  row-per-request sliding-window limiter), kept as its own table rather
  than reusing auth_rate_limit_hits so this unrelated feature never
  touches the security-sensitive auth module.
- `writing_projects.compiling_since` — a nullable timestamp, claimed via
  an atomic conditional UPDATE (WritingProjectsRepository.
  try_claim_compile_lock) replacing the old in-process
  `_compiling_projects` set.

Pure schema addition, no data migration — none of this state has a
pre-5.5 equivalent to migrate from (a NULL compiling_since on every
existing project is exactly "no compile currently running", the correct
value for all of them).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0028_compile_coordination"
down_revision: str | Sequence[str] | None = "0027_writing_import_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "compile_artifacts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("storage_key", sa.String(length=300), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["writing_projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_compile_artifacts_user_id", "compile_artifacts", ["user_id"], unique=False
    )
    op.create_index(
        "ix_compile_artifacts_expires_at", "compile_artifacts", ["expires_at"], unique=False
    )

    op.create_table(
        "compile_rate_limit_hits",
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
        "ix_compile_rate_limit_hits_bucket_key",
        "compile_rate_limit_hits",
        ["bucket_key"],
        unique=False,
    )

    with op.batch_alter_table("writing_projects", schema=None) as batch_op:
        batch_op.add_column(sa.Column("compiling_since", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("writing_projects", schema=None) as batch_op:
        batch_op.drop_column("compiling_since")

    op.drop_index(
        "ix_compile_rate_limit_hits_bucket_key", table_name="compile_rate_limit_hits"
    )
    op.drop_table("compile_rate_limit_hits")

    op.drop_index("ix_compile_artifacts_expires_at", table_name="compile_artifacts")
    op.drop_index("ix_compile_artifacts_user_id", table_name="compile_artifacts")
    op.drop_table("compile_artifacts")
