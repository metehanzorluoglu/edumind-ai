"""Milestone 6.1 (Writing Context Engine) — the API/service boundary Part
25 asks for: "create the API/service boundary now and test it with
deterministic inspection/mocks." Deliberately the ONLY new endpoint this
milestone adds (Part 0: "M6.1 is NOT an AI writing-feature milestone") —
it builds and returns a WritingContextPacket, it never calls a model.

Auth-gated exactly like every other Writing endpoint (CurrentUserDep);
WritingProjectFilesRepository.get_all_content's existing ownership check
(returns None for a project that doesn't exist or isn't the caller's) is
the SAME mechanism every other Writing route already relies on for Part
19's "never retrieve another user's Writing project" — no new
authorization logic was written for this endpoint, the existing one was
reused as-is.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, status

from app.core.security import CurrentUserDep
from app.core.writing_context_engine import (
    WritingContextAuthorizationError,
    build_writing_context,
)
from app.core.writing_context_schemas import WritingContextPacket, WritingContextRequest
from app.db.writing_projects_repository import WritingProjectsRepository
from app.deps import (
    DBSessionDep,
    NotebooksRepositoryDep,
    RetrieverDep,
    WritingProjectFilesRepositoryDep,
)

router = APIRouter(prefix="/writing-projects", tags=["writing-context"])


@router.post("/{project_id}/context", response_model=WritingContextPacket)
def post_writing_context(
    project_id: str,
    body: WritingContextRequest,
    user: CurrentUserDep,
    db: DBSessionDep,
    files_repository: WritingProjectFilesRepositoryDep,
    notebooks_repository: NotebooksRepositoryDep,
    retriever: RetrieverDep,
) -> WritingContextPacket:
    """Builds one Writing context packet for `project_id` — the
    request-time boundary later Milestone 6 features (M6.2+) call
    instead of rebuilding context logic themselves (Part 25). Also the
    endpoint a DEV-ONLY frontend context inspector (Part 21, not built
    this milestone — see the M6.1 report) would call if/when one is
    added. `project_id` in the URL and `body.project_id` are reconciled
    here (the URL is authoritative — a caller who somehow sent mismatched
    ids gets the URL's project checked, never a silent mix of the two)."""
    if body.project_id != project_id:
        body = body.model_copy(update={"project_id": project_id})

    try:
        project_uuid = uuid.UUID(project_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found") from exc

    projects_repository = WritingProjectsRepository(db)
    project = projects_repository.get(user.id, project_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    edum8_reference_count = projects_repository.reference_count(project.id)

    try:
        return build_writing_context(
            body,
            user_id=user.id,
            files_repo=files_repository,
            notebooks_repo=notebooks_repository,
            retriever=retriever,
            edum8_reference_count=edum8_reference_count,
        )
    except WritingContextAuthorizationError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found") from exc
