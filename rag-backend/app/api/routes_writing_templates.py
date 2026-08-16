"""Milestone 5.4 (LaTeX Templates & Project Import) — the curated
template registry API (Parts 1-3/19/21/22/42/43).

"Use template" reuses the EXACT SAME atomic creation path a confirmed
ZIP import uses (app/core/writing_project_creation.py) — after
creation there is no template-specific behavior anywhere (Part 16);
the new project is a completely normal WritingProject."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import CurrentUserDep, get_current_user
from app.core.writing_project_creation import ManifestFile, ProjectCreationError, create_project_from_manifest
from app.core.writing_templates import get_template, list_templates
from app.deps import (
    DBSessionDep,
    WritingProjectFileStorageDep,
    WritingProjectsRepositoryDep,
)
from app.schemas.writing import WritingProjectResponse
from app.schemas.writing_templates import (
    CreateFromTemplateRequest,
    WritingTemplateDetailResponse,
    WritingTemplateFileResponse,
    WritingTemplateListResponse,
    WritingTemplateSummaryResponse,
)

router = APIRouter(tags=["writing-templates"], dependencies=[Depends(get_current_user)])


def _summary_response(t) -> WritingTemplateSummaryResponse:
    return WritingTemplateSummaryResponse(
        id=t.id,
        name=t.name,
        description=t.description,
        category=t.category,
        license=t.license,
        source=t.source,
        version=t.version,
        file_count=t.file_count,
    )


@router.get("/writing-templates", response_model=WritingTemplateListResponse)
def list_writing_templates() -> WritingTemplateListResponse:
    """Part 48 — same-origin, no file bodies (bounded, cheap even with
    many templates in the registry)."""
    templates = list_templates()
    return WritingTemplateListResponse(
        templates=[_summary_response(t) for t in templates], total=len(templates)
    )


@router.get("/writing-templates/{template_id}", response_model=WritingTemplateDetailResponse)
def get_writing_template(template_id: str) -> WritingTemplateDetailResponse:
    detail = get_template(template_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Template not found")
    return WritingTemplateDetailResponse(
        **_summary_response(detail).model_dump(),
        root=detail.root,
        files=[WritingTemplateFileResponse(path=f.path, kind="text") for f in detail.files],
    )


@router.post(
    "/writing-templates/{template_id}/create",
    response_model=WritingProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_from_template(
    template_id: str,
    request: CreateFromTemplateRequest,
    user: CurrentUserDep,
    db: DBSessionDep,
    files_storage: WritingProjectFileStorageDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    detail = get_template(template_id)
    if detail is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Template not found")

    manifest_files = [
        ManifestFile(path=f.path, kind="text", content_text=f.content) for f in detail.files
    ]
    try:
        project = create_project_from_manifest(
            db,
            files_storage,
            user_id=user.id,
            title=request.title,
            description=request.description,
            files=manifest_files,
            root_path=detail.root,
        )
    except ProjectCreationError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    record = writing_projects_repository.get(user.id, project.id)
    assert record is not None
    return WritingProjectResponse(
        id=str(record.id),
        title=record.title,
        description=record.description,
        main_tex_content=record.main_tex_content,
        root_file_id=str(record.root_file_id) if record.root_file_id else None,
        archived_at=record.archived_at,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )
