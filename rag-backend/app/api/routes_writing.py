"""Milestone 5 (Academic Writing & LaTeX Foundation) — Writing Projects:
create/edit LaTeX manuscripts, associate them with existing library
Documents as references, and generate a BibTeX bibliography / portable
export from the exact same Milestone 4.2 citation engine every other
citation surface uses. See app/db/models_writing.py for why this is a
dedicated model rather than built on the pre-existing (chat) `projects`
table."""

import io
import logging
import uuid
import zipfile
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.bibliographic_enrichment_service import has_usable_doi
from app.core.bibtex import export_bibtex
from app.core.citation_item import CitationItem, document_to_citation_item
from app.core.compile_rate_limiter import enforce_compile_rate_limit
from app.core.latex_citations import parse_cite_keys
from app.core.latex_compiler_client import Diagnostic as ClientDiagnostic
from app.core.latex_source_hash import compute_source_hash
from app.core.security import CurrentUserDep, get_current_user
from app.db.documents_repository import DocumentRecord, DocumentsRepository
from app.db.models_writing import MAX_PROJECT_TOTAL_STORAGE_BYTES
from app.db.writing_project_files_repository import WritingProjectFilesRepository
from app.db.writing_projects_repository import (
    WritingProjectRecord,
    WritingProjectsRepository,
    WritingProjectSummary,
)
from app.deps import (
    CompileArtifactsRepositoryDep,
    CompileArtifactStorageDep,
    DBSessionDep,
    DocumentsRepositoryDep,
    LatexCompilerClientDep,
    SettingsDep,
    WritingProjectFilesRepositoryDep,
    WritingProjectFileStorageDep,
    WritingProjectsRepositoryDep,
)
from app.schemas.writing import (
    DEFAULT_MAIN_TEX_TEMPLATE,
    AddWritingProjectReferenceRequest,
    AddWritingProjectReferenceResult,
    AddWritingProjectReferencesResponse,
    CompileDiagnosticResponse,
    CompileWritingProjectResponse,
    CreateWritingProjectRequest,
    DuplicateWritingProjectRequest,
    UpdateWritingProjectRequest,
    WritingProjectBibliographyResponse,
    WritingProjectListResponse,
    WritingProjectReferenceResponse,
    WritingProjectReferencesResponse,
    WritingProjectResponse,
    WritingProjectSummaryResponse,
)
from app.services.writing_project_file_storage import WritingProjectFileStorage

#: Milestone 5.1 Part 39, made cross-worker by 5.5 Part 23 — "only one
#: active compile per project", now a DB-backed lock (see
#: WritingProjectsRepository.try_claim_compile_lock) rather than an
#: in-process set invisible across this deployment's 2 uvicorn workers.
#: A claim older than this is treated as free — self-heals a worker that
#: crashed mid-compile without ever releasing it. Comfortably above the
#: compiler client's own timeout (latex_compiler_timeout_seconds, default
#: 55s) plus this route's own pre/post-compile work, so a legitimately
#: slow-but-still-running compile is never mistaken for an abandoned one.
COMPILE_LOCK_STALE_AFTER_SECONDS = 180.0

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/writing-projects", tags=["writing"], dependencies=[Depends(get_current_user)]
)


def _summary_response(summary: WritingProjectSummary) -> WritingProjectSummaryResponse:
    return WritingProjectSummaryResponse(
        id=str(summary.id),
        title=summary.title,
        description=summary.description,
        reference_count=summary.reference_count,
        file_count=summary.file_count,
        archived_at=summary.archived_at,
        created_at=summary.created_at,
        updated_at=summary.updated_at,
    )


def _project_response(record: WritingProjectRecord) -> WritingProjectResponse:
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


def _parse_uuid_or_404(project_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(project_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Writing project not found"
        ) from exc


@router.post("", response_model=WritingProjectResponse, status_code=status.HTTP_201_CREATED)
def create_writing_project(
    request: CreateWritingProjectRequest,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    """Milestone 5 Section 8 — every new project starts from a minimal,
    honest template (the project's own title, an empty Introduction
    section) — never fake authors/affiliations/references."""
    record = writing_projects_repository.create(
        user_id=user.id,
        title=request.title,
        description=request.description,
        main_tex_content=DEFAULT_MAIN_TEX_TEMPLATE.format(title=request.title),
    )
    return _project_response(record)


@router.get("", response_model=WritingProjectListResponse)
def list_writing_projects(
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    q: str | None = None,
    sort: Literal["updated_at", "name", "created_at"] = "updated_at",
    archived: bool = False,
) -> WritingProjectListResponse:
    """Milestone 5.3 Part 26/27/28 — the project dashboard's own list
    call. `q` searches title/description only (Part 27); `sort` defaults
    to the pre-M5.3 behavior (most-recently-updated first) so an old
    frontend build that never passes these params sees identical
    ordering to before; `archived=true` shows ONLY archived projects
    (never a mixed view — Part 30's "hidden from the default active
    view")."""
    summaries = writing_projects_repository.list_for_user(
        user.id, search=q, sort=sort, include_archived=True
    )
    summaries = [
        s for s in summaries if (s.archived_at is not None) == archived
    ]
    return WritingProjectListResponse(
        projects=[_summary_response(s) for s in summaries], total=len(summaries)
    )


@router.get("/{project_id}", response_model=WritingProjectResponse)
def get_writing_project(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    project_id_uuid = _parse_uuid_or_404(project_id)
    record = writing_projects_repository.get(user.id, project_id_uuid)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    return _project_response(record)


@router.patch("/{project_id}", response_model=WritingProjectResponse)
def update_writing_project(
    project_id: str,
    request: UpdateWritingProjectRequest,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    """Milestone 5 Section 7 — the autosave endpoint: the editor PATCHes
    `main_tex_content` here on a debounced interval, never per keystroke.
    Partial update — only a field actually present in the request body is
    touched (same convention as PATCH /documents/{id}/metadata)."""
    fields_set = request.model_fields_set
    updates: dict[str, object] = {}
    if "title" in fields_set:
        if request.title is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="title cannot be cleared"
            )
        updates["title"] = request.title
    if "description" in fields_set:
        updates["description"] = request.description
    if "main_tex_content" in fields_set:
        if request.main_tex_content is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="main_tex_content cannot be cleared"
            )
        updates["main_tex_content"] = request.main_tex_content

    project_id_uuid = _parse_uuid_or_404(project_id)
    if not updates:
        record = writing_projects_repository.get(user.id, project_id_uuid)
        if record is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
        return _project_response(record)

    record = writing_projects_repository.update(user.id, project_id_uuid, updates)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    return _project_response(record)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_writing_project(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    files_repository: WritingProjectFilesRepositoryDep,
    files_storage: WritingProjectFileStorageDep,
) -> None:
    """Milestone 5 Section 30 / 5.3 Part 35 — deletes ONLY this project's
    own row, its reference associations, and (new in 5.3) its OWN file
    tree — the file rows first (so the delete never leaves orphaned
    rows if a later step fails), then the project row, then any binary
    asset bytes on disk, then a final best-effort sweep of the whole
    per-project storage subtree (covers any asset whose row-level
    storage_key was somehow already gone — belt and suspenders, never
    required in the ordinary path). Never touches the referenced
    Documents, their highlights, Notebook entries, or any chat
    conversation — none of those are owned by a WritingProject."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    # Ownership-check via a real read BEFORE mutating anything — delete()
    # below re-checks ownership itself, but the files cleanup needs to
    # know the project exists and is this user's BEFORE it deletes rows.
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    storage_keys = files_repository.delete_all_for_project(project_id_uuid)
    deleted = writing_projects_repository.delete(user.id, project_id_uuid)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    for key in storage_keys:
        files_storage.delete(key)
    files_storage.delete_project(user_id=user.id, project_id=project_id_uuid)


@router.post("/{project_id}/archive", response_model=WritingProjectResponse)
def archive_writing_project(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    """Milestone 5.3 Part 30 — hides the project from the default
    dashboard view without deleting anything; always reversible."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    record = writing_projects_repository.archive(user.id, project_id_uuid)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    return _project_response(record)


@router.post("/{project_id}/restore", response_model=WritingProjectResponse)
def restore_writing_project(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> WritingProjectResponse:
    project_id_uuid = _parse_uuid_or_404(project_id)
    record = writing_projects_repository.restore(user.id, project_id_uuid)
    if record is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    return _project_response(record)


@router.post(
    "/{project_id}/duplicate",
    response_model=WritingProjectResponse,
    status_code=status.HTTP_201_CREATED,
)
def duplicate_writing_project(
    project_id: str,
    request: DuplicateWritingProjectRequest,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    files_repository: WritingProjectFilesRepositoryDep,
    files_storage: WritingProjectFileStorageDep,
) -> WritingProjectResponse:
    """Milestone 5.3 Part 29 — copies project metadata, the full file
    tree (including binary asset BYTES, physically re-saved under the
    new project's own storage subtree — never shared with the source),
    and project-reference associations. Deliberately does NOT duplicate
    Documents, Notebook entries, or Chat conversations (Part 29) — a
    citation key in the copied main.tex still resolves against the
    exact same canonical Document the source project references."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    source = writing_projects_repository.get(user.id, project_id_uuid)
    if source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    new_title = request.title or f"{source.title} (copy)"
    new_record = writing_projects_repository.duplicate_metadata(
        user.id, project_id_uuid, new_title=new_title
    )
    assert new_record is not None

    id_map, binary_copies = files_repository.duplicate_all_for_project(
        project_id_uuid, new_record.id
    )
    for old_storage_key, new_file_id, mime_type in binary_copies:
        data = files_storage.read(old_storage_key)
        new_storage_key = files_storage.save(
            user_id=user.id,
            project_id=new_record.id,
            file_id=new_file_id,
            mime_type=mime_type,
            data=data,
        )
        files_repository.set_binary_storage_key(new_file_id, new_storage_key)

    if source.root_file_id is not None and source.root_file_id in id_map:
        writing_projects_repository.set_root_file_id(
            new_record.id, id_map[source.root_file_id]
        )

    final_record = writing_projects_repository.get(user.id, new_record.id)
    assert final_record is not None
    return _project_response(final_record)


def _bibliographic_fields(record: DocumentRecord) -> dict[str, object]:
    """Every BibliographicMetadataFields value straight from the current
    DocumentRecord — mirrors routes_documents.py's _document_summary
    exactly, so a writing-project reference card shows the identical
    identity Documents/Reader already show."""
    return {
        "document_type": record.document_type,
        "journal_quartile": record.journal_quartile,
        "title": record.title,
        "authors": record.authors,
        "publication_year": record.publication_year,
        "source_venue": record.source_venue,
        "doi": record.doi,
        "source_url": record.source_url,
        "volume": record.volume,
        "issue": record.issue,
        "page_start": record.page_start,
        "page_end": record.page_end,
        "publisher": record.publisher,
        "abstract": record.abstract,
        "keywords": record.keywords,
        "language": record.language,
        "metadata_sources": record.metadata_sources,
        "last_enriched_at": record.last_enriched_at,
        "enrichment_provider": record.enrichment_provider,
        "enrichment_status": record.enrichment_status,
        "has_usable_doi": has_usable_doi(record),
        "citation_key": record.citation_key,
    }


@router.get("/{project_id}/references", response_model=WritingProjectReferencesResponse)
def list_writing_project_references(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    files_repository: WritingProjectFilesRepositoryDep,
    files_storage: WritingProjectFileStorageDep,
) -> WritingProjectReferencesResponse:
    """Milestone 5 Section 3/27 — every reference's bibliographic identity
    is read live from the current Document row (never a copy). `cited`
    and `missing_citation_keys` are computed fresh from the project's
    current main_tex_content on every call — never persisted, so they can
    never drift out of sync with the manuscript."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    refs = writing_projects_repository.list_references(user.id, project_id_uuid)
    assert refs is not None  # project existence already confirmed above

    used_keys = parse_cite_keys(project.main_tex_content)
    reference_responses: list[WritingProjectReferenceResponse] = []
    known_keys: set[str] = set()
    for ref in refs:
        record = documents_repository.get_or_create_citation_key(user.id, ref.document_id)
        if record is None:
            # The Document was deleted after this association was created
            # but before the FK cascade caught up (or a race at request
            # time) — skip rather than fabricate a row for a document
            # that no longer exists.
            continue
        if record.citation_key:
            known_keys.add(record.citation_key)
        reference_responses.append(
            WritingProjectReferenceResponse(
                document_id=record.document_id,
                source_filename=record.source_filename,
                added_at=ref.added_at,
                cited=bool(record.citation_key) and record.citation_key in used_keys,
                **_bibliographic_fields(record),  # type: ignore[arg-type]
            )
        )

    missing = sorted(used_keys - known_keys)
    bibtex_text, _count = _generate_bibliography(
        writing_projects_repository, documents_repository, user.id, project_id_uuid
    )
    # Milestone 5.3 Part 40 — must fold in every OTHER project file too,
    # exactly like the compile endpoint's own source_hash, or "preview is
    # current" would stay (incorrectly) true after editing/uploading a
    # secondary file that the compiled PDF doesn't actually reflect yet.
    extra_files = _collect_extra_files(
        files_repository, files_storage, user.id, project_id_uuid, project.root_file_id
    )
    return WritingProjectReferencesResponse(
        references=reference_responses,
        total=len(reference_responses),
        missing_citation_keys=missing,
        source_hash=compute_source_hash(project.main_tex_content, bibtex_text, extra_files),
    )


@router.post("/{project_id}/references", response_model=AddWritingProjectReferencesResponse)
def add_writing_project_references(
    project_id: str,
    request: AddWritingProjectReferenceRequest,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> AddWritingProjectReferencesResponse:
    """Milestone 5 Section 4/37 — adds one or more Documents as project
    references. Every document_id is ownership-checked individually
    (`WritingProjectsRepository.add_reference`) — a guessed id belonging
    to another user reports "document_not_found", indistinguishable from
    a truly nonexistent id, never leaking whose document it is."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    results = [
        AddWritingProjectReferenceResult(
            document_id=document_id,
            outcome=writing_projects_repository.add_reference(
                user.id, project_id_uuid, document_id
            ),
        )
        for document_id in dict.fromkeys(request.document_ids)  # de-dup, preserve order
    ]
    if all(r.outcome == "project_not_found" for r in results):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    return AddWritingProjectReferencesResponse(results=results)


@router.delete("/{project_id}/references/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_writing_project_reference(
    project_id: str,
    document_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> None:
    """Milestone 5 Section 5 — removes ONLY the association. Never
    deletes the Document, its highlights, or any Notebook entry."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    removed = writing_projects_repository.remove_reference(user.id, project_id_uuid, document_id)
    if not removed:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Reference not found in this project"
        )


def _generate_bibliography(
    writing_projects_repository: WritingProjectsRepository,
    documents_repository: DocumentsRepository,
    user_id: uuid.UUID,
    project_id_uuid: uuid.UUID,
) -> tuple[str, int]:
    refs = writing_projects_repository.list_references(user_id, project_id_uuid)
    if refs is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    items: list[tuple[CitationItem, str]] = []
    for ref in refs:
        record = documents_repository.get_or_create_citation_key(user_id, ref.document_id)
        if record is None or not record.citation_key:
            continue
        items.append((document_to_citation_item(record), record.citation_key))
    bibtex_text = export_bibtex(items)
    return bibtex_text, len(items)


def _collect_extra_files(
    files_repository: WritingProjectFilesRepository,
    files_storage: WritingProjectFileStorage,
    user_id: uuid.UUID,
    project_id_uuid: uuid.UUID,
    root_file_id: uuid.UUID | None,
) -> dict[str, bytes]:
    """Milestone 5.3 Part 17/31 — every project file EXCEPT the root
    file itself (the caller always sends the root's content separately,
    fixed at the compile-service's own hardcoded "main.tex" entry point
    — see LatexCompilerClient.compile's own docstring) and except
    folders (which carry no content). Text files are UTF-8-encoded here;
    binary files are read from disk via WritingProjectFileStorage. Used
    identically by both the compile snapshot and the export ZIP so the
    two can never drift apart on "what counts as a project file".

    Milestone 5.5.1 Part 20/23 — real-ZIP-import testing (a genuine
    Springer Nature journal template, imported with its root .tex file
    inside a subfolder — e.g. "sn-article-template/sn-article.tex" next
    to its own "sn-article-template/sn-jnl.cls") found this silently
    broke every such project: the root always compiles as "main.tex" at
    the compile sandbox's TOP level, but every other file (including
    the root's own former folder-mates) kept its original,
    project-relative path — so "sn-jnl.cls" stayed nested inside
    "sn-article-template/" once compilation moved main.tex out of that
    folder, and `\documentclass{sn-jnl}` (resolved relative to
    main.tex's own directory, same as any real local LaTeX build) could
    no longer find it. "LaTeX Error: File `sn-jnl.cls' not found" is
    the exact real compile failure this produced.

    Fix: every other file's path is rebased relative to the ROOT
    FILE'S OWN directory, not the project's absolute root — so a file
    that was a folder-mate of the root keeps that exact relationship at
    compile time (root's directory effectively becomes the sandbox's
    top level, matching where main.tex now lives). A file living
    OUTSIDE the root's own folder (rare — most templates keep
    everything under one directory) has no well-defined relative
    position once main.tex moves, so it falls back to its original
    project-relative path unchanged, exactly as before this fix —
    still better than guessing, and no worse than prior behavior for
    that specific edge case.
    """
    contents = files_repository.get_all_content(user_id, project_id_uuid)
    if contents is None:
        return {}

    # First pass: find the root's own directory (e.g. "sn-article-template"
    # for a root at "sn-article-template/sn-article.tex", or "" for a
    # root already at the project's top level — the overwhelmingly
    # common case, where this whole rebase is a no-op).
    root_dir = ""
    for content in contents:
        if content.node.id == root_file_id:
            root_dir = content.node.path.rsplit("/", 1)[0] if "/" in content.node.path else ""
            break
    root_prefix = f"{root_dir}/" if root_dir else ""

    extra: dict[str, bytes] = {}
    for content in contents:
        if content.node.id == root_file_id:
            continue
        rebased_path = (
            content.node.path[len(root_prefix) :]
            if root_prefix and content.node.path.startswith(root_prefix)
            else content.node.path
        )
        # Real-browser validation (M5.3 scenario K3) found a genuine
        # silent-corruption bug here: the compiler workdir (and the
        # export ZIP) always reserve the top-level "main.tex" slot for
        # the ACTUAL root's content, written separately by the caller —
        # see LatexCompilerClient.compile's own docstring. Nothing stops
        # a NON-root file from also being named "main.tex" at project
        # root (e.g. the file that WAS root before a Part 15 root
        # reassignment, or any file a user names that way) — including
        # such a file here would silently overwrite the true root
        # content on disk (compiler) or produce a duplicate zip entry
        # (export), compiling/exporting the wrong document with no
        # error surfaced anywhere. That slot is reserved; skip it. This
        # now checks the REBASED path — the same collision is exactly
        # as possible (and exactly as important to guard against) after
        # rebasing as it always was for an already-top-level file.
        if rebased_path == "main.tex":
            continue
        if content.node.kind == "text" and content.content_text is not None:
            extra[rebased_path] = content.content_text.encode("utf-8")
        elif content.node.kind == "binary" and content.storage_key:
            extra[rebased_path] = files_storage.read(content.storage_key)
    return extra


@router.get("/{project_id}/bibliography", response_model=WritingProjectBibliographyResponse)
def get_writing_project_bibliography(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> WritingProjectBibliographyResponse:
    """Milestone 5 Section 12/13 — generated fresh from current
    references via the exact Milestone 4.2 BibTeX engine (app/core/
    bibtex.export_bibtex) — never a second, independently-maintained
    bibliography store."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    bibtex_text, count = _generate_bibliography(
        writing_projects_repository, documents_repository, user.id, project_id_uuid
    )
    return WritingProjectBibliographyResponse(bibtex=bibtex_text, reference_count=count)


@router.get("/{project_id}/export")
def export_writing_project(
    project_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    files_repository: WritingProjectFilesRepositoryDep,
    files_storage: WritingProjectFileStorageDep,
) -> Response:
    """Milestone 5 Section 23/24, extended by 5.3 Part 31 — a portable
    ZIP: the root file is ALWAYS written to "main.tex" at the archive's
    top level (matching the compile snapshot's own convention — Part 15:
    the root document compiles as main.tex regardless of what the user
    actually named/renamed it to in the tree), every other project file
    at its own real relative path (preserving folder structure exactly),
    and references.bib (freshly generated, same as the bibliography
    endpoint). No internal IDs, tokens, user-account data, or
    application metadata — a normal LaTeX environment can build this
    project unmodified."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    bibtex_text, _count = _generate_bibliography(
        writing_projects_repository, documents_repository, user.id, project_id_uuid
    )
    extra_files = _collect_extra_files(
        files_repository, files_storage, user.id, project_id_uuid, project.root_file_id
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("main.tex", project.main_tex_content)
        archive.writestr("references.bib", bibtex_text)
        for rel_path, data in extra_files.items():
            archive.writestr(rel_path, data)
    zip_bytes = buffer.getvalue()

    safe_slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in project.title.lower())[:60]
    filename = f"{safe_slug or 'writing-project'}.zip"
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _diagnostics_to_response(
    diagnostics: "tuple[ClientDiagnostic, ...]",
    extra: list[CompileDiagnosticResponse] | None = None,
) -> list[CompileDiagnosticResponse]:
    result = [
        CompileDiagnosticResponse(severity=d.severity, message=d.message, line=d.line, file=d.file)
        for d in diagnostics
    ]
    if extra:
        result = extra + result
    return result


@router.post("/{project_id}/compile", response_model=CompileWritingProjectResponse)
def compile_writing_project(
    project_id: str,
    user: CurrentUserDep,
    db: DBSessionDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
    files_repository: WritingProjectFilesRepositoryDep,
    files_storage: WritingProjectFileStorageDep,
    latex_compiler_client: LatexCompilerClientDep,
    compile_artifacts_repository: CompileArtifactsRepositoryDep,
    compile_artifact_storage: CompileArtifactStorageDep,
    settings: SettingsDep,
) -> CompileWritingProjectResponse:
    """Milestone 5.1 Part 14 — compiles the project's CURRENT saved
    main_tex_content (never client-supplied source — Part 13/33: the
    frontend is responsible for flushing its pending autosave and
    awaiting a successful save BEFORE calling this endpoint, exactly the
    same "flush -> save -> act" discipline the References panel already
    follows). Orchestrates the isolated latex-compiler service; the main
    backend process itself never executes LaTeX (Part 1's core
    invariant)."""
    # Master kill switch (Settings.latex_compilation_enabled) — 404s
    # exactly like folder_library_enabled's identical convention
    # (routes_documents.py) while off, indistinguishable from the route
    # not existing at all.
    if not settings.latex_compilation_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="LaTeX compilation is disabled")

    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    # Milestone 5.3 Part 16 — "if root missing/corrupt: compile disabled
    # with clear message". In normal operation every project always has
    # a root_file_id (set at creation and by the 0026 migration for
    # every pre-M5.3 project) — this is a defensive guard, never
    # expected to actually trip, matching root_file_id's own
    # "ondelete=SET NULL... never expected to actually go NULL" note.
    if project.root_file_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="This project has no root document set. Choose a root .tex file before compiling.",
        )

    # Part 39, cross-worker since 5.5 Part 23 — cheapest possible
    # rejection first, mirroring POST /conversations/{id}/messages's own
    # rate-limit-before-any-work ordering (routes_conversations.py).
    rate_limit_result = enforce_compile_rate_limit(
        db,
        user_id=user.id,
        max_requests=settings.compile_rate_limit_max_requests,
        window_seconds=settings.compile_rate_limit_window_seconds,
    )
    if not rate_limit_result.allowed:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many compile requests recently. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, round(rate_limit_result.retry_after_seconds)))},
        )

    # Part 9/12 — reject an oversized manuscript before ever contacting
    # the compiler service (that service enforces its own independent
    # limit too — defense in depth, not a substitute).
    if len(project.main_tex_content.encode("utf-8")) > settings.compile_max_main_tex_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"main.tex exceeds {settings.compile_max_main_tex_bytes} bytes",
        )

    # Part 39, cross-worker since 5.5 Part 23 — only one active compile
    # per project at a time.
    claimed = writing_projects_repository.try_claim_compile_lock(
        project_id_uuid, stale_after_seconds=COMPILE_LOCK_STALE_AFTER_SECONDS
    )
    if not claimed:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                "A compile is already running for this project. "
                "Please wait for it to finish."
            ),
        )

    try:
        bibtex_text, _count = _generate_bibliography(
            writing_projects_repository, documents_repository, user.id, project_id_uuid
        )
        # Milestone 5.3 Part 17/40 — every OTHER project file (secondary
        # .tex sources, .cls/.sty, figure/PDF assets) joins the compile
        # snapshot AND the freshness hash; the root file's own content is
        # still sent separately as `main_tex` (Part 15 — it always
        # compiles as "main.tex" regardless of its real name/path).
        extra_files = _collect_extra_files(
            files_repository, files_storage, user.id, project_id_uuid, project.root_file_id
        )
        total_extra_bytes = sum(len(v) for v in extra_files.values())
        if total_extra_bytes > MAX_PROJECT_TOTAL_STORAGE_BYTES:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"Project files exceed {MAX_PROJECT_TOTAL_STORAGE_BYTES} bytes",
            )
        source_hash = compute_source_hash(project.main_tex_content, bibtex_text, extra_files)
        job_id = uuid.uuid4().hex

        outcome = latex_compiler_client.compile(
            job_id=job_id,
            main_tex=project.main_tex_content,
            references_bib=bibtex_text,
            extra_files=extra_files,
        )

        # Part 23 — safe, non-content logging only.
        logger.info(
            "compile job %s project=%s user=%s ok=%s status=%s failure=%s",
            job_id,
            project_id,
            user.id,
            outcome.ok,
            outcome.status,
            outcome.failure,
        )

        if not outcome.ok:
            # Part 11 — "queued/busy behavior rather than crashing the
            # host": every one of these is a structured, honest,
            # non-200-http-error result the frontend can render inline,
            # never a raw 5xx.
            if outcome.failure == "queue_full":
                return CompileWritingProjectResponse(
                    status="busy",
                    diagnostics=[
                        CompileDiagnosticResponse(
                            severity="error",
                            message=(
                                "The compiler is busy with another job. "
                                "Please try again shortly."
                            ),
                        )
                    ],
                    source_hash=source_hash,
                )
            if outcome.failure == "timeout":
                return CompileWritingProjectResponse(
                    status="timeout",
                    diagnostics=[
                        CompileDiagnosticResponse(
                            severity="error", message="Compilation timed out."
                        )
                    ],
                    source_hash=source_hash,
                )
            return CompileWritingProjectResponse(
                status="unavailable",
                diagnostics=[
                    CompileDiagnosticResponse(
                        severity="error",
                        message=(
                            "The compilation service is temporarily unavailable. "
                            "Please try again."
                        ),
                    )
                ],
                source_hash=source_hash,
            )

        if outcome.status == "success" and outcome.pdf_bytes:
            # Milestone 5.5 Part 22 — sweep-then-write, same convention as
            # routes_writing_import.py's own "every route starts by
            # sweeping expired sessions" (no scheduled job, no unbounded
            # accumulation regardless of request volume).
            expired_keys = compile_artifacts_repository.sweep_expired()
            for key in expired_keys:
                compile_artifact_storage.delete(key)
            compile_id_uuid = uuid.uuid4()
            storage_key = compile_artifact_storage.save(
                user_id=user.id, compile_id=compile_id_uuid, pdf_bytes=outcome.pdf_bytes
            )
            compile_artifacts_repository.create(
                compile_id=compile_id_uuid,
                user_id=user.id,
                project_id=project_id_uuid,
                storage_key=storage_key,
                ttl_seconds=settings.compile_artifact_ttl_seconds,
            )
            compile_id = compile_id_uuid.hex
            return CompileWritingProjectResponse(
                status="success",
                diagnostics=_diagnostics_to_response(outcome.diagnostics),
                log_excerpt=outcome.log_excerpt,
                duration_ms=outcome.duration_ms,
                page_count=outcome.page_count,
                compile_id=compile_id,
                pdf_size_bytes=len(outcome.pdf_bytes),
                source_hash=source_hash,
            )

        return CompileWritingProjectResponse(
            status=outcome.status or "error",
            diagnostics=_diagnostics_to_response(outcome.diagnostics),
            log_excerpt=outcome.log_excerpt,
            duration_ms=outcome.duration_ms,
            source_hash=source_hash,
        )
    finally:
        writing_projects_repository.release_compile_lock(project_id_uuid)


@router.get("/{project_id}/compile/{compile_id}/pdf")
def get_compiled_pdf(
    project_id: str,
    compile_id: str,
    user: CurrentUserDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    compile_artifacts_repository: CompileArtifactsRepositoryDep,
    compile_artifact_storage: CompileArtifactStorageDep,
    settings: SettingsDep,
) -> Response:
    """Milestone 5.1 Part 16/17/42, made cross-worker by 5.5 Part 22 — a
    short-lived, ownership-checked fetch of one compile's PDF bytes. A
    guessed/expired/wrong-owner compile_id 404s identically to a
    nonexistent one (Part 42: never leak whether a compile_id exists for
    someone else's project) — and, since the DB row (not process memory)
    is now the source of truth, identically regardless of which of the 2
    uvicorn workers produced the compile vs. is serving this GET."""
    if not settings.latex_compilation_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="LaTeX compilation is disabled")

    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    # Same sweep-before-read convention as the store path above — a
    # request for an artifact that just expired gets an honest 404
    # instead of a race against the next sweep.
    expired_keys = compile_artifacts_repository.sweep_expired()
    for key in expired_keys:
        compile_artifact_storage.delete(key)

    try:
        compile_id_uuid = uuid.UUID(compile_id)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Compiled PDF not found or expired"
        ) from exc

    artifact = compile_artifacts_repository.get(
        user_id=user.id, project_id=project_id_uuid, compile_id=compile_id_uuid
    )
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Compiled PDF not found or expired")

    try:
        pdf_bytes = compile_artifact_storage.read(artifact.storage_key)
    except OSError as exc:
        # The DB row survived but the file didn't (e.g. a manual /data
        # cleanup) — same honest 404, never a raw 500 for a resource this
        # route already documents as short-lived/best-effort.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail="Compiled PDF not found or expired"
        ) from exc

    return Response(content=pdf_bytes, media_type="application/pdf")
