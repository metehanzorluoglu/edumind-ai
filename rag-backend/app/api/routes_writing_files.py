"""Milestone 5.3 (LaTeX Project Workspace & File Management) — the
Writing Project file-tree API. Every route here is ownership-scoped by
`CurrentUserDep` + WritingProjectFilesRepository's own user_id-filtered
lookups (Part 36, release critical) exactly like every other route in
routes_writing.py; a guessed file_id belonging to another user's project
404s identically to a nonexistent one.

Mutation identity is always a database ID (`file_id`/`parent_id`), never
a client-supplied path string (Part 38) — see
app/core/writing_file_validation.py's module docstring for why this
makes path traversal structurally impossible through this API family
(Part 37, release critical), independent of any individual check below.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status

from app.core.reference_mode import detect_reference_mode, propose_edum8_switch
from app.core.security import CurrentUserDep, get_current_user
from app.core.writing_file_validation import kind_for_extension
from app.db.models_writing import (
    MAX_BINARY_FILE_BYTES,
    MAX_FILES_PER_PROJECT,
    MAX_PROJECT_TOTAL_STORAGE_BYTES,
    MAX_TEXT_FILE_CONTENT_CHARS,
)
from app.db.writing_project_files_repository import WritingProjectFileNode
from app.deps import (
    DocumentsRepositoryDep,
    WritingProjectFilesRepositoryDep,
    WritingProjectFileStorageDep,
    WritingProjectsRepositoryDep,
)
from app.schemas.writing_files import (
    CreateFolderRequest,
    CreateTextFileRequest,
    Edum8SwitchProposalResponse,
    GeneratedFileNodeResponse,
    MoveFileRequest,
    ReferenceKeyResponse,
    ReferenceModeResponse,
    RenameFileRequest,
    SetRootFileRequest,
    SwitchToEdum8Request,
    SwitchToEdum8Response,
    UpdateFileContentRequest,
    WritingProjectFileContentResponse,
    WritingProjectFileMutationResponse,
    WritingProjectFileNodeResponse,
    WritingProjectFileTreeResponse,
)

router = APIRouter(
    prefix="/writing-projects", tags=["writing"], dependencies=[Depends(get_current_user)]
)

#: Milestone 5.3 Part 11 — never trust a client-declared Content-Type,
#: same posture as app/services/attachment_storage.py's sniff_mime.
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"
_PDF_MAGIC = b"%PDF-"
_ALLOWED_BINARY_MIMES = frozenset({"image/png", "image/jpeg", "application/pdf"})


def _sniff_binary_mime(data: bytes) -> str | None:
    if data.startswith(_PNG_MAGIC):
        return "image/png"
    if data.startswith(_JPEG_MAGIC):
        return "image/jpeg"
    if data.startswith(_PDF_MAGIC):
        return "application/pdf"
    return None


def _node_response(node: WritingProjectFileNode) -> WritingProjectFileNodeResponse:
    return WritingProjectFileNodeResponse(
        id=str(node.id),
        parent_id=str(node.parent_id) if node.parent_id else None,
        kind=node.kind,  # type: ignore[arg-type]
        name=node.name,
        path=node.path,
        mime_type=node.mime_type,
        size_bytes=node.size_bytes,
        is_root=node.is_root,
    )


def _parse_uuid_or_404(value: str, *, detail: str = "Not found") -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=detail) from exc


#: Maps a repository outcome literal to (status_code, detail) — shared by
#: every create/rename/move/delete route below so the HTTP mapping stays
#: in exactly one place.
_OUTCOME_HTTP: dict[str, tuple[int, str]] = {
    "project_not_found": (status.HTTP_404_NOT_FOUND, "Writing project not found"),
    "file_not_found": (status.HTTP_404_NOT_FOUND, "File not found"),
    "parent_not_found": (status.HTTP_404_NOT_FOUND, "Parent folder not found"),
    "parent_not_a_folder": (status.HTTP_422_UNPROCESSABLE_CONTENT, "Parent is not a folder"),
    "duplicate_name": (status.HTTP_409_CONFLICT, "A file or folder with that name already exists here"),
    "invalid_name": (status.HTTP_422_UNPROCESSABLE_CONTENT, "Invalid file or folder name"),
    "invalid_extension": (status.HTTP_422_UNPROCESSABLE_CONTENT, "File type is not allowed"),
    "file_limit_reached": (
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        f"This project already has the maximum of {MAX_FILES_PER_PROJECT} files",
    ),
    "depth_limit_reached": (status.HTTP_422_UNPROCESSABLE_CONTENT, "Folder nesting is too deep"),
    "cannot_move_into_self_or_descendant": (
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "Cannot move a folder into itself or one of its own subfolders",
    ),
    "cannot_delete_root_file": (
        status.HTTP_409_CONFLICT,
        "Cannot delete the project's current root file — choose a different root file first",
    ),
    "not_a_text_file": (status.HTTP_422_UNPROCESSABLE_CONTENT, "Not a text file"),
    "not_a_tex_file": (status.HTTP_422_UNPROCESSABLE_CONTENT, "Root file must be a .tex text file"),
}


def _raise_for_outcome(outcome: str) -> None:
    mapped = _OUTCOME_HTTP.get(outcome)
    if mapped is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=outcome)
    raise HTTPException(mapped[0], detail=mapped[1])


def _edum8_reference_count(
    user_id: uuid.UUID,
    project_id: uuid.UUID,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> int:
    """Shared by list_files and get_reference_mode — the same "has a
    usable citation" definition every endpoint here already uses (a
    reference without a resolvable citation_key doesn't count)."""
    refs = writing_projects_repository.list_references(user_id, project_id) or []
    count = 0
    for ref in refs:
        record = documents_repository.get_or_create_citation_key(user_id, ref.document_id)
        if record is not None and record.citation_key:
            count += 1
    return count


@router.get("/{project_id}/files", response_model=WritingProjectFileTreeResponse)
def list_files(
    project_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> WritingProjectFileTreeResponse:
    """Part 4/41 — metadata only (no `content_text`/binary bytes) so a
    100-file project's tree loads in one cheap request (Part 47)."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    tree = files_repository.list_tree(user.id, project_id_uuid)
    if tree is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    # Part 3 — references.bib is synthesized fresh here from the exact
    # same live generation the /bibliography and /export endpoints use
    # (app/core/bibtex.export_bibtex over the project's current
    # references), never a stored row (see WritingProjectFile's own
    # docstring).
    reference_count = _edum8_reference_count(
        user.id, project_id_uuid, writing_projects_repository, documents_repository
    )

    return WritingProjectFileTreeResponse(
        files=[_node_response(n) for n in tree.nodes],
        generated=[GeneratedFileNodeResponse(reference_count=reference_count)],
        root_file_id=str(tree.root_file_id) if tree.root_file_id else None,
        total_size_bytes=tree.total_size_bytes,
        file_count=tree.file_count,
        max_files=MAX_FILES_PER_PROJECT,
        max_total_bytes=MAX_PROJECT_TOTAL_STORAGE_BYTES,
    )


@router.get("/{project_id}/reference-mode", response_model=ReferenceModeResponse)
def get_reference_mode(
    project_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
    documents_repository: DocumentsRepositoryDep,
) -> ReferenceModeResponse:
    """Bibliography Source Detection — how this project ACTUALLY manages
    its citations/references, inspected fresh on every call from real
    project content (see app/core/reference_mode.py's own docstring for
    the full detection algorithm and why EDUM8_REFERENCE_LIBRARY is
    never assumed just because references.bib exists)."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")

    all_content = files_repository.get_all_content(user.id, project_id_uuid) or []
    text_files = {
        c.node.path: c.content_text
        for c in all_content
        if c.node.kind == "text" and c.content_text is not None
    }
    root_node = next((c.node for c in all_content if c.node.id == project.root_file_id), None)
    # `project.main_tex_content` is kept write-through synced with the
    # root file's own content_text (see update_text_content's own
    # docstring) — used as the fallback only for the structurally
    # impossible case of a root file row that's somehow missing from
    # `all_content`, never as the primary source.
    root_path = root_node.path if root_node is not None else "main.tex"
    root_content = text_files.get(root_path, project.main_tex_content)

    edum8_reference_count = _edum8_reference_count(
        user.id, project_id_uuid, writing_projects_repository, documents_repository
    )

    result = detect_reference_mode(
        root_path=root_path,
        root_content=root_content,
        text_files=text_files,
        edum8_reference_count=edum8_reference_count,
    )

    switch_proposal = propose_edum8_switch(
        mode=result.mode, root_path=root_path, root_content=root_content
    )
    switch_instructions: str | None = None
    if result.mode != "edum8_library" and switch_proposal is None:
        if result.mode == "imported_bib":
            switch_instructions = (
                f"Connect EduM8 references to this project, then update the "
                f"\\bibliography{{...}} command in {root_path} to "
                f"\\bibliography{{references}}."
            )
        else:
            switch_instructions = (
                f"This project's bibliography lives in {result.bibliography_source} as "
                "manual entries. To use EduM8's Reference Library instead, replace that "
                "content with \\bibliography{references} once your EduM8 references are "
                "ready — EduM8 will not rewrite manual bibliography entries automatically."
            )

    return ReferenceModeResponse(
        mode=result.mode,
        bibliography_source=result.bibliography_source,
        citation_key_source=result.citation_key_source,
        keys=[ReferenceKeyResponse(key=k, title=t) for k, t in result.keys],
        edum8_available=result.edum8_available,
        no_key_source_reason=result.no_key_source_reason,
        edum8_switch_proposal=(
            Edum8SwitchProposalResponse(
                file_path=switch_proposal.file_path,
                find=switch_proposal.find,
                replace=switch_proposal.replace,
            )
            if switch_proposal is not None
            else None
        ),
        edum8_switch_instructions=switch_instructions,
    )


@router.post("/{project_id}/reference-mode/switch-to-edum8", response_model=SwitchToEdum8Response)
def switch_to_edum8_references(
    project_id: str,
    request: SwitchToEdum8Request,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    writing_projects_repository: WritingProjectsRepositoryDep,
) -> SwitchToEdum8Response:
    """Applies EXACTLY the substitution the GET endpoint proposed —
    never a general "switch to EduM8" action. Re-verifies `find` is
    still present in the root file's CURRENT content first (409 if not
    — the file changed since the proposal was shown, never silently
    applied against stale text) and only ever touches the root file the
    proposal named (422 if the project's root file has since changed).
    Never deletes the old `.bib` file — it simply stops being
    referenced."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    project = writing_projects_repository.get(user.id, project_id_uuid)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Writing project not found")
    if project.root_file_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Project has no root file set"
        )

    node = files_repository.get_node(user.id, project_id_uuid, project.root_file_id)
    if node is None or node.path != request.file_path:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Target file has changed — refresh and try again",
        )

    content = files_repository.get_content(user.id, project_id_uuid, project.root_file_id)
    if content is None or content.content_text is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Not a text file")

    if request.find not in content.content_text:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="This file has changed since the proposed change was shown — refresh and try again",
        )

    new_content = content.content_text.replace(request.find, request.replace, 1)
    outcome = files_repository.update_text_content(
        user.id, project_id_uuid, project.root_file_id, new_content
    )
    if outcome != "ok":
        _raise_for_outcome(outcome)
    updated_node = files_repository.get_node(user.id, project_id_uuid, project.root_file_id)
    assert updated_node is not None
    return SwitchToEdum8Response(file=_node_response(updated_node))


@router.post("/{project_id}/files/folders", response_model=WritingProjectFileMutationResponse)
def create_folder(
    project_id: str,
    request: CreateFolderRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    project_id_uuid = _parse_uuid_or_404(project_id)
    parent_uuid = _parse_uuid_or_404(request.parent_id) if request.parent_id else None
    outcome, node = files_repository.create_folder(
        user.id, project_id_uuid, parent_id=parent_uuid, name=request.name
    )
    if outcome != "ok" or node is None:
        _raise_for_outcome(outcome)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.post("/{project_id}/files/text", response_model=WritingProjectFileMutationResponse)
def create_text_file(
    project_id: str,
    request: CreateTextFileRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    if len(request.content_text.encode("utf-8")) > MAX_TEXT_FILE_CONTENT_CHARS:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Text file exceeds {MAX_TEXT_FILE_CONTENT_CHARS} bytes",
        )
    project_id_uuid = _parse_uuid_or_404(project_id)
    parent_uuid = _parse_uuid_or_404(request.parent_id) if request.parent_id else None
    outcome, node = files_repository.create_text_file(
        user.id,
        project_id_uuid,
        parent_id=parent_uuid,
        name=request.name,
        content_text=request.content_text,
    )
    if outcome != "ok" or node is None:
        _raise_for_outcome(outcome)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.post("/{project_id}/files/upload", response_model=WritingProjectFileMutationResponse)
def upload_file(
    project_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    storage: WritingProjectFileStorageDep,
    file: UploadFile = File(...),
    parent_id: str | None = Form(default=None),
    name: str | None = Form(default=None),
) -> WritingProjectFileMutationResponse:
    """Part 10/11 — a safe, bounded project-asset upload. `name` defaults
    to the uploaded file's own declared filename but is always
    RE-VALIDATED here exactly like a create-file request name (Part 11:
    "never trust client MIME alone" applies just as much to the client's
    declared filename)."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    parent_uuid = _parse_uuid_or_404(parent_id) if parent_id else None
    declared_name = name or file.filename or ""

    kind = kind_for_extension(declared_name)
    if kind is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, detail="File type is not allowed"
        )

    data = file.file.read(MAX_BINARY_FILE_BYTES + 1)
    if len(data) > MAX_BINARY_FILE_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"File exceeds {MAX_BINARY_FILE_BYTES} bytes",
        )
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail="File is empty")

    if kind == "text":
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Text file must be UTF-8"
            ) from exc
        if len(data) > MAX_TEXT_FILE_CONTENT_CHARS:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"Text file exceeds {MAX_TEXT_FILE_CONTENT_CHARS} bytes",
            )
        outcome = files_repository.precheck_create(
            user.id, project_id_uuid, parent_id=parent_uuid, name=declared_name
        )
        if outcome != "ok":
            _raise_for_outcome(outcome)
        outcome2, node = files_repository.create_text_file(
            user.id, project_id_uuid, parent_id=parent_uuid, name=declared_name, content_text=text
        )
        if outcome2 != "ok" or node is None:
            _raise_for_outcome(outcome2)
        assert node is not None
        return WritingProjectFileMutationResponse(file=_node_response(node))

    # Binary — Part 11: never trust the client's declared Content-Type or
    # extension for the actual bytes, only the file's own signature.
    sniffed = _sniff_binary_mime(data)
    if sniffed is None or sniffed not in _ALLOWED_BINARY_MIMES:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="File content does not match an allowed image/PDF signature",
        )

    total_bytes = files_repository.total_project_bytes(project_id_uuid)
    if total_bytes + len(data) > MAX_PROJECT_TOTAL_STORAGE_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"This project would exceed its {MAX_PROJECT_TOTAL_STORAGE_BYTES}-byte storage limit",
        )

    outcome = files_repository.precheck_create(
        user.id, project_id_uuid, parent_id=parent_uuid, name=declared_name
    )
    if outcome != "ok":
        _raise_for_outcome(outcome)

    file_id = uuid.uuid4()
    storage_key = storage.save(
        user_id=user.id, project_id=project_id_uuid, file_id=file_id, mime_type=sniffed, data=data
    )
    outcome2, node = files_repository.commit_create_binary_file(
        user.id,
        project_id_uuid,
        file_id=file_id,
        parent_id=parent_uuid,
        name=declared_name,
        mime_type=sniffed,
        size_bytes=len(data),
        storage_key=storage_key,
    )
    if outcome2 != "ok" or node is None:
        # A genuine race (two concurrent uploads with the same name) —
        # clean up the now-orphaned disk bytes rather than leaking them.
        storage.delete(storage_key)
        _raise_for_outcome(outcome2)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.get("/{project_id}/files/{file_id}", response_model=WritingProjectFileContentResponse)
def get_file_content(
    project_id: str,
    file_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileContentResponse:
    """Part 39/47 — an explicit, separate fetch (never bundled into the
    tree listing) — opening a file is a deliberate user action, not
    something that should cost N extra requests when merely BROWSING the
    tree (Part 47's "no N+1 content fetches" is about the tree view, not
    this route)."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    content = files_repository.get_content(user.id, project_id_uuid, file_id_uuid)
    if content is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="File not found")
    return WritingProjectFileContentResponse(
        file=_node_response(content.node), content_text=content.content_text
    )


@router.get("/{project_id}/files/{file_id}/content")
def get_binary_file_content(
    project_id: str,
    file_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    storage: WritingProjectFileStorageDep,
) -> Response:
    """Part 21 — the raw bytes for a binary asset's preview pane. Never
    trusts the DB's mime_type blindly for anything security-sensitive —
    it was already sniffed from real content at upload time (upload_file
    above), so re-serving it here is safe."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    content = files_repository.get_content(user.id, project_id_uuid, file_id_uuid)
    if content is None or content.node.kind != "binary" or not content.storage_key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="File not found")
    data = storage.read(content.storage_key)
    return Response(content=data, media_type=content.node.mime_type or "application/octet-stream")


@router.patch("/{project_id}/files/{file_id}", response_model=WritingProjectFileMutationResponse)
def update_file(
    project_id: str,
    file_id: str,
    request: UpdateFileContentRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    """Part 13/39 — the autosave endpoint for whichever project text file
    is currently active in the editor (the exact same debounced-PATCH
    discipline as PATCH /writing-projects/{id}'s own main_tex_content
    field — never per-keystroke)."""
    if len(request.content_text.encode("utf-8")) > MAX_TEXT_FILE_CONTENT_CHARS:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Text file exceeds {MAX_TEXT_FILE_CONTENT_CHARS} bytes",
        )
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    outcome = files_repository.update_text_content(
        user.id, project_id_uuid, file_id_uuid, request.content_text
    )
    if outcome != "ok":
        _raise_for_outcome(outcome)
    node = files_repository.get_node(user.id, project_id_uuid, file_id_uuid)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.post(
    "/{project_id}/files/{file_id}/rename", response_model=WritingProjectFileMutationResponse
)
def rename_file(
    project_id: str,
    file_id: str,
    request: RenameFileRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    outcome = files_repository.rename(user.id, project_id_uuid, file_id_uuid, request.name)
    if outcome != "ok":
        _raise_for_outcome(outcome)
    node = files_repository.get_node(user.id, project_id_uuid, file_id_uuid)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.post("/{project_id}/files/{file_id}/move", response_model=WritingProjectFileMutationResponse)
def move_file(
    project_id: str,
    file_id: str,
    request: MoveFileRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    new_parent_uuid = _parse_uuid_or_404(request.new_parent_id) if request.new_parent_id else None
    outcome = files_repository.move(
        user.id, project_id_uuid, file_id_uuid, new_parent_id=new_parent_uuid
    )
    if outcome != "ok":
        _raise_for_outcome(outcome)
    node = files_repository.get_node(user.id, project_id_uuid, file_id_uuid)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))


@router.delete("/{project_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(
    project_id: str,
    file_id: str,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
    storage: WritingProjectFileStorageDep,
) -> None:
    """Part 9/16/35 — a folder delete is always recursive; the current
    root file (or a folder containing it) can never be deleted without
    reassigning the root first (Part 16). Disk bytes for any deleted
    binary descendants are removed only AFTER the DB commit succeeds."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(file_id)
    outcome, storage_keys = files_repository.delete(user.id, project_id_uuid, file_id_uuid)
    if outcome != "ok":
        _raise_for_outcome(outcome)
    for key in storage_keys:
        storage.delete(key)


@router.put("/{project_id}/root-file", response_model=WritingProjectFileMutationResponse)
def set_root_file(
    project_id: str,
    request: SetRootFileRequest,
    user: CurrentUserDep,
    files_repository: WritingProjectFilesRepositoryDep,
) -> WritingProjectFileMutationResponse:
    """Part 15 — the user chooses a different `.tex` file as the
    project's root/main document."""
    project_id_uuid = _parse_uuid_or_404(project_id)
    file_id_uuid = _parse_uuid_or_404(request.file_id)
    outcome = files_repository.set_root(user.id, project_id_uuid, file_id_uuid)
    if outcome != "ok":
        _raise_for_outcome(outcome)
    node = files_repository.get_node(user.id, project_id_uuid, file_id_uuid)
    assert node is not None
    return WritingProjectFileMutationResponse(file=_node_response(node))
