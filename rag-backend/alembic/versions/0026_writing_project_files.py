"""writing project files: file/folder tree + root file (milestone 5.3 —
LaTeX project workspace & file management)

Revision ID: 0026_writing_project_files
Revises: 0025_writing_projects
Create Date: 2026-08-16 00:00:00.000000

Adds `writing_project_files` (see app/db/models_writing.py's
WritingProjectFile docstring for the full "no stored path, parent_id is
structural truth" design), plus two new nullable columns on
`writing_projects`: `root_file_id` (FK, added AFTER the new table exists
so the FK target is valid) and `archived_at`.

Part 2 — DATA MIGRATION, not just a schema change: every EXISTING
writing_projects row's `main_tex_content` is materialized into a new
`writing_project_files` row (kind="text", name="main.tex", parent_id=NULL)
and `root_file_id` is set to point at it. `main_tex_content` itself is
left completely untouched (never cleared, never overwritten) — it
remains the same column, now treated as a write-through mirror of the
root file's content (see WritingProjectFilesRepository.update_text_content),
so a pre-migration backup/rollback path still has a fully intact
manuscript with zero data loss, exactly as this milestone's spec
requires ("Do not delete or overwrite existing project content during
migration").
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0026_writing_project_files"
down_revision: str | Sequence[str] | None = "0025_writing_projects"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "writing_project_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("writing_project_id", sa.Uuid(), nullable=False),
        sa.Column("parent_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=100), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("content_text", sa.Text(), nullable=True),
        sa.Column("storage_key", sa.String(length=300), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["writing_project_id"], ["writing_projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["parent_id"], ["writing_project_files.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "writing_project_id", "parent_id", "name", name="uq_writing_project_files_sibling_name"
        ),
    )
    op.create_index(
        "ix_writing_project_files_project_id",
        "writing_project_files",
        ["writing_project_id"],
        unique=False,
    )
    op.create_index(
        "ix_writing_project_files_parent_id",
        "writing_project_files",
        ["parent_id"],
        unique=False,
    )

    with op.batch_alter_table("writing_projects", schema=None) as batch_op:
        batch_op.add_column(sa.Column("root_file_id", sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.create_foreign_key(
            "fk_writing_projects_root_file_id",
            "writing_project_files",
            ["root_file_id"],
            ["id"],
            ondelete="SET NULL",
        )

    # --- Data migration: materialize every existing project's
    # main_tex_content as its own main.tex file row, and point
    # root_file_id at it. main_tex_content itself is left untouched. ---
    bind = op.get_bind()
    writing_projects = sa.table(
        "writing_projects",
        sa.column("id", sa.Uuid()),
        sa.column("main_tex_content", sa.Text()),
        sa.column("root_file_id", sa.Uuid()),
    )
    writing_project_files = sa.table(
        "writing_project_files",
        sa.column("id", sa.Uuid()),
        sa.column("writing_project_id", sa.Uuid()),
        sa.column("parent_id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("name", sa.String()),
        sa.column("size_bytes", sa.Integer()),
        sa.column("content_text", sa.Text()),
    )
    existing_projects = bind.execute(
        sa.select(writing_projects.c.id, writing_projects.c.main_tex_content)
    ).all()
    for project_id, main_tex_content in existing_projects:
        content = main_tex_content or ""
        file_id = uuid.uuid4()
        bind.execute(
            writing_project_files.insert().values(
                id=file_id,
                writing_project_id=project_id,
                parent_id=None,
                kind="text",
                name="main.tex",
                size_bytes=len(content.encode("utf-8")),
                content_text=content,
            )
        )
        bind.execute(
            writing_projects.update()
            .where(writing_projects.c.id == project_id)
            .values(root_file_id=file_id)
        )


def downgrade() -> None:
    """Downgrade schema. `main_tex_content` was never touched by
    upgrade(), so every project's manuscript source is still fully
    intact after this runs — only the new file-tree rows and columns are
    removed."""
    with op.batch_alter_table("writing_projects", schema=None) as batch_op:
        batch_op.drop_constraint("fk_writing_projects_root_file_id", type_="foreignkey")
        batch_op.drop_column("archived_at")
        batch_op.drop_column("root_file_id")
    op.drop_index("ix_writing_project_files_parent_id", table_name="writing_project_files")
    op.drop_index("ix_writing_project_files_project_id", table_name="writing_project_files")
    op.drop_table("writing_project_files")
