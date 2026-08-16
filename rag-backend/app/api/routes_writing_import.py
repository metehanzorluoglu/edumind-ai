"""Milestone 5.4 (LaTeX Templates & Project Import) — the ZIP-import
"upload -> inspect -> preview -> confirm" API (Part 5/9/14/31/32).

Every route here starts by sweeping expired import sessions (Part 32 —
"no unbounded accumulation") before doing anything else; this is a
cheap, correct-enough substitute for a scheduled background job given
this milestone's scope (see WritingImportSessionsRepository's own
docstring for the full reasoning).

Ownership (Part 31): a session's `user_id` is checked on every
inspect/confirm/cancel — a guessed session_id belonging to another
user's upload 404s identically to a nonexistent one, matching every
other ownership check in this codebase."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.config import get_settings
from app.core.security import CurrentUserDep, get_current_user
from app.core.writing_project_creation import ManifestFile, ProjectCreationError, create_project_from_manifest
from app.core.writing_project_import import ArchiveRejected, inspect_archive
from app.deps import (
    DBSessionDep,
    WritingImportSessionsRepositoryDep,
    WritingImportStorageDep,
    WritingProjectFileStorageDep,
    WritingProjectsRepositoryDep,
)
from app.schemas.writing import WritingProjectResponse
from app.schemas.writing_import import (
    ConfirmImportRequest,
    ImportFilePreviewResponse,
    ImportInspectionResponse,
    ImportWarningResponse,
)

router = APIRouter(
    prefix="/writing-projects/import", tags=["writing-import"], dependencies=[Depends(get_current_user)]
)


def _parse_uuid_or_404(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Import session not found") from exc


@router.post("/inspect", response_model=ImportInspectionResponse)
def inspect_import(
    user: CurrentUserDep,
    sessions_repository: WritingImportSessionsRepositoryDep,
    import_storage: WritingImportStorageDep,
    file: UploadFile = File(...),
) -> ImportInspectionResponse:
    """Part 5/6/9 — accepts .zip only; the ENTIRE inspection pipeline
    (app/core/writing_project_import.py) runs before anything is staged
    to disk or recorded in the database. A rejected archive (Parts 6-8's
    release-critical categories) never creates a session at all."""
    settings = get_settings()
    expired_keys = sessions_repository.sweep_expired()
    for key in expired_keys:
        import_storage.delete(key)

    declared_name = file.filename or "upload.zip"
    if not declared_name.lower().endswith(".zip"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Only .zip files are accepted")

    data = file.file.read(settings.writing_import_max_archive_bytes + 1)
    if len(data) > settings.writing_import_max_archive_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Archive exceeds the {settings.writing_import_max_archive_bytes}-byte upload limit",
        )

    try:
        inspection = inspect_archive(data, max_archive_bytes=settings.writing_import_max_archive_bytes)
    except ArchiveRejected as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    session_id = uuid.uuid4()
    storage_key = import_storage.save(user_id=user.id, session_id=session_id, data=data)
    record = sessions_repository.create(
        session_id=session_id,
        user_id=user.id,
        original_filename=declared_name,
        storage_key=storage_key,
        inspection=inspection,
        ttl_minutes=settings.writing_import_session_ttl_minutes,
    )
    return ImportInspectionResponse(
        session_id=str(record.id),
        suggested_title=inspection.suggested_title,
        files=[
            ImportFilePreviewResponse(path=f.path, kind=f.kind, size_bytes=f.size_bytes)
            for f in inspection.files
        ],
        root_candidates=inspection.root_candidates,
        preselected_root=inspection.preselected_root,
        warnings=[ImportWarningResponse(path=w.path, reason=w.reason) for w in inspection.warnings],
        total_size_bytes=inspection.total_size_bytes,
        expires_at=record.expires_at.isoformat(),
    )


@router.post(
    "/{session_id}/confirm", response_model=WritingProjectResponse, status_code=status.HTTP_201_CREATED
)
def confirm_import(
    session_id: str,
    request: ConfirmImportRequest,
    user: CurrentUserDep,
    db: DBSessionDep,
    sessions_repository: WritingImportSessionsRepositoryDep,
    import_storage: WritingImportStorageDep,
    files_storage: WritingProjectFileStorageDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    session_id_uuid = _parse_uuid_or_404(session_id)
    expired_keys = sessions_repository.sweep_expired()
    for key in expired_keys:
        import_storage.delete(key)

    session = sessions_repository.get(user.id, session_id_uuid)
    if session is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Import session not found or has expired — please re-upload"
        )

    inspection = session.inspection
    root_path = request.root_path
    if root_path is None:
        root_path = inspection.preselected_root
    if root_path is not None and root_path not in {f.path for f in inspection.files}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="root_path is not one of the imported files")
    if root_path is None and len(inspection.root_candidates) > 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Multiple possible root documents were found — root_path is required",
        )

    # Text file bodies are already in the persisted inspection JSON
    # (Part 14 — confirm never re-reads the archive for those); binary
    # bytes are NOT persisted there (kept small/JSON-serializable), so
    # they're re-read here from the staged archive, entry by entry, by
    # the exact same safe path each entry already passed inspection
    # under.
    import io
    import zipfile

    manifest_files: list[ManifestFile] = []
    binary_paths = [f.path for f in inspection.files if f.kind == "binary"]
    if binary_paths:
        archive_bytes = import_storage.read(session.storage_key)
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            by_normalized = {
                info.filename.replace("\\", "/").lstrip("/"): info for info in archive.infolist()
            }
            binary_content: dict[str, bytes] = {}
            for path in binary_paths:
                info = by_normalized.get(path)
                if info is None:
                    raise HTTPException(
                        status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Staged archive is missing a previously-inspected entry: {path}",
                    )
                with archive.open(info) as fh:
                    binary_content[path] = fh.read()

    for f in inspection.files:
        if f.kind == "text":
            manifest_files.append(ManifestFile(path=f.path, kind="text", content_text=f.content_text or ""))
        else:
            mime_type = _mime_for_path(f.path)
            manifest_files.append(
                ManifestFile(
                    path=f.path, kind="binary", raw_bytes=binary_content[f.path], mime_type=mime_type
                )
            )

    try:
        project = create_project_from_manifest(
            db,
            files_storage,
            user_id=user.id,
            title=request.title,
            description=request.description,
            files=manifest_files,
            root_path=root_path,
        )
    except ProjectCreationError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc

    deleted_key = sessions_repository.delete(user.id, session_id_uuid)
    if deleted_key:
        import_storage.delete(deleted_key)

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


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_import(
    session_id: str,
    user: CurrentUserDep,
    sessions_repository: WritingImportSessionsRepositoryDep,
    import_storage: WritingImportStorageDep,
) -> None:
    session_id_uuid = _parse_uuid_or_404(session_id)
    storage_key = sessions_repository.delete(user.id, session_id_uuid)
    if storage_key is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Import session not found")
    import_storage.delete(storage_key)


def _mime_for_path(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "pdf": "application/pdf",
    }.get(ext, "application/octet-stream")
