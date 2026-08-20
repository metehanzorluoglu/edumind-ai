"""Milestone 6.1 — Writing Context Engine: the orchestrator that turns one
WritingContextRequest into one WritingContextPacket. This is the module
every other M6.1 file exists to serve; see the M6.1 report's "Context
Engine Architecture" section for the full design rationale. Read
app/core/writing_context_schemas.py first — every field referenced here is
defined there.

Explicitly reuses, rather than reimplements:
- app/core/reference_mode.py's detect_reference_mode (Part 9 — "Respect
  the bibliography architecture completed in M5.5").
- app/core/retriever.py's Retriever (Part 10 — "reuse the existing
  retrieval infrastructure... do not introduce another vector database").
- app/db/writing_project_files_repository.py's get_all_content (the SAME
  call the compile/export snapshot builders already use — one call, all
  files, already ownership-checked).
- app/db/notebooks_repository.py's list_all_entries_for_user (Notes AND
  Highlights both live in NotebookEntry — see that repository's own
  docstring update).
- app/core/writing_context_budget.py's estimate_tokens/dedup/budget.
- app/core/writing_context_policy.py's classify_intent/POLICY_LAYERS.
- app/core/latex_structure.py / writing_manuscript_graph.py for L2/L3.

Never touches an LLM (Part 14/17/25) — every layer here is either a
direct DB read, a deterministic parse, or an existing-Retriever call.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Protocol

from app.core.latex_structure import find_enclosing_section, offset_to_line, parse_latex_structure
from app.core.reference_mode import ReferenceModeResult, detect_reference_mode
from app.core.retrieval_schemas import RetrievedChunk
from app.core.writing_context_budget import (
    ContextBudgetEnforcer,
    deduplicate_evidence,
    estimate_tokens,
)
from app.core.writing_context_policy import POLICY_LAYERS, classify_intent
from app.core.writing_context_schemas import (
    ContextPolicyName,
    EvidenceItem,
    ProjectStructureContext,
    ReferenceContext,
    SectionContext,
    SelectionContext,
    WritingContextDiagnostics,
    WritingContextPacket,
    WritingContextRequest,
)
from app.core.writing_manuscript_graph import build_manuscript_graph
from app.db.notebooks_repository import NotebooksRepository
from app.db.writing_project_files_repository import (
    WritingProjectFileContent,
    WritingProjectFilesRepository,
)

# Part 6 — bounded surrounding context around a selection/cursor, in
# characters (deterministic and simple to test; the spec explicitly
# allows characters/lines/paragraphs/tokens as the unit as long as it's
# deterministic and tested — characters keep offset math exact and
# trivially unit-testable without a paragraph-boundary heuristic).
_NEARBY_CONTEXT_CHARS = 400

# Part 8/10 — never send more than this many notes/highlights/evidence
# items regardless of how many "relevant" candidates exist; the per-item
# text still goes through the token budget on top of this count cap.
_MAX_NOTES = 5
_MAX_HIGHLIGHTS = 5
_MAX_EVIDENCE_CHUNKS = 5
_EVIDENCE_RETRIEVAL_TOP_K = 8


class WritingContextAuthorizationError(Exception):
    """Raised when the requesting user does not own project_id/
    active_file_id — Part 19: "Project IDs supplied by clients are
    untrusted." Never a generic ValueError, so callers (the API route)
    can map this to 404 specifically, matching this codebase's existing
    "404, not 403" convention for cross-user access attempts."""


class RetrieverLike(Protocol):
    """Structural protocol matching the exact subset of
    app.core.retriever.Retriever's .retrieve(...) this engine actually
    calls (query/user_id/top_k only — this engine never passes
    `filters`, so it's deliberately omitted here rather than typed as
    `object | None`, which Retriever's own narrower `RetrievalFilters |
    None` parameter type would fail Protocol variance against) —
    declared locally so this module (and its tests) never need a real
    Qdrant/embedding stack, only something shaped like one. See
    app/core/scoped_retrieval.py's identical ScopedRetrieverLike for the
    established precedent of this pattern in this codebase."""

    def retrieve(
        self,
        query: str,
        *,
        user_id: str,
        top_k: int = 8,
    ) -> list[RetrievedChunk]: ...  # pragma: no cover - protocol


@dataclass(frozen=True)
class _ProjectSnapshot:
    """Everything read from the database ONCE per context-build call
    (Part 17 — "avoid... re-reading every project file... N+1 database
    queries"): all file contents, the root path, and which files are
    `.tex` vs. any text-kind file. Building this is the only place this
    module touches WritingProjectFilesRepository."""

    files_by_id: dict[str, WritingProjectFileContent]
    files_by_path: dict[str, WritingProjectFileContent]
    root_path: str | None
    tex_paths: list[str]
    # Every text-KIND file (.tex, .bib, .bst, .cls, .sty, .txt, .md) —
    # detect_reference_mode's own contract requires ALL .tex AND .bib
    # files, not just .tex (see its docstring), so this is kept as its
    # own list rather than reusing tex_paths for that call.
    text_paths: list[str]


def _load_project_snapshot(
    files_repo: WritingProjectFilesRepository, *, user_id: uuid.UUID, project_id: uuid.UUID
) -> _ProjectSnapshot | None:
    contents = files_repo.get_all_content(user_id, project_id)
    if contents is None:
        return None
    files_by_id = {str(c.node.id): c for c in contents}
    files_by_path = {c.node.path: c for c in contents}
    root_path = next((c.node.path for c in contents if c.node.is_root), None)
    tex_paths = [c.node.path for c in contents if c.node.path.endswith(".tex")]
    text_paths = [
        c.node.path for c in contents if c.node.kind == "text" and c.content_text is not None
    ]
    return _ProjectSnapshot(
        files_by_id=files_by_id,
        files_by_path=files_by_path,
        root_path=root_path,
        tex_paths=tex_paths,
        text_paths=text_paths,
    )


def _resolve_active_content(
    request: WritingContextRequest, snapshot: _ProjectSnapshot
) -> tuple[WritingProjectFileContent | None, str, str]:
    """Returns (active file record, effective content, freshness tag).
    Part 3's stale-editor-content strategy: the active file's content is
    the client-supplied live buffer WHEN GIVEN (the editor always knows
    its own truer-than-saved state for the one file it has open), else
    the saved DB content. Every OTHER file is always read from saved
    content only — this app's editor model allows exactly one dirty
    file at a time (see the M5.5 investigation summary's "single-
    selected-file editing model"), so there is never an ambiguity about
    which file a client-supplied buffer belongs to."""
    if request.active_file_id is None:
        return None, "", "saved"
    active = snapshot.files_by_id.get(request.active_file_id)
    if active is None:
        return None, "", "saved"
    if request.active_file_unsaved_content is not None:
        return active, request.active_file_unsaved_content, "unsaved_client_buffer"
    return active, active.content_text or "", "saved"


def _build_selection(
    request: WritingContextRequest, active: WritingProjectFileContent, content: str, freshness: str
) -> SelectionContext:
    start = request.selection_start
    end = request.selection_end
    if start is None or end is None or start == end:
        # No real selection — Part 1's L1 still wants a cursor
        # neighborhood even with nothing selected (Scenario/Letter C:
        # "cursor with no selection").
        cursor = request.cursor_position if request.cursor_position is not None else 0
        cursor = max(0, min(cursor, len(content)))
        before = content[max(0, cursor - _NEARBY_CONTEXT_CHARS) : cursor]
        after = content[cursor : cursor + _NEARBY_CONTEXT_CHARS]
        return SelectionContext(
            file_id=str(active.node.id),
            file_path=active.node.path,
            selection_start=cursor,
            selection_end=cursor,
            selected_text="",
            before_text=before,
            after_text=after,
            selected_text_matches_client=request.selected_text in (None, ""),
            content_freshness=freshness,  # type: ignore[arg-type]
        )

    clamped_start = max(0, min(start, len(content)))
    clamped_end = max(clamped_start, min(end, len(content)))
    reconstructed = content[clamped_start:clamped_end]
    matches = (request.selected_text is None) or (request.selected_text == reconstructed)
    before = content[max(0, clamped_start - _NEARBY_CONTEXT_CHARS) : clamped_start]
    after = content[clamped_end : clamped_end + _NEARBY_CONTEXT_CHARS]
    return SelectionContext(
        file_id=str(active.node.id),
        file_path=active.node.path,
        selection_start=clamped_start,
        selection_end=clamped_end,
        selected_text=reconstructed,
        before_text=before,
        after_text=after,
        selected_text_matches_client=matches,
        content_freshness=freshness,  # type: ignore[arg-type]
    )


def _build_section(
    active: WritingProjectFileContent, content: str, anchor_offset: int
) -> SectionContext:
    structure = parse_latex_structure(content)
    line = offset_to_line(content, anchor_offset)
    path = find_enclosing_section(structure, line)
    return SectionContext(
        file_id=str(active.node.id),
        file_path=active.node.path,
        chapter=path.chapter,
        section=path.section,
        subsection=path.subsection,
        subsubsection=path.subsubsection,
    )


def _build_project_structure(
    snapshot: _ProjectSnapshot, active: WritingProjectFileContent | None
) -> ProjectStructureContext:
    tex_files = {
        path: (snapshot.files_by_path[path].content_text or "") for path in snapshot.tex_paths
    }
    graph = build_manuscript_graph(tex_files, root_path=snapshot.root_path)
    ancestors = graph.ancestors_of(active.node.path) if active is not None else []
    return ProjectStructureContext(
        root_path=snapshot.root_path,
        active_file_path=active.node.path if active is not None else None,
        ancestor_paths=ancestors,
        tex_file_count=len(snapshot.tex_paths),
    )


def _notebook_relevance_score(query_terms: set[str], text: str) -> int:
    """Deterministic, LLM-free relevance ranking (Part 14) for
    notes/highlights, which — unlike Document chunks — are never
    embedded in Qdrant (Part 8 doesn't require semantic search, only "a
    retrieval mechanism for relevant ones"). Plain term-overlap count:
    simple, fully deterministic, and good enough to distinguish "this
    note mentions the same words as the request" from "this note is
    about something unrelated," which is the actual bar Part 8 sets."""
    if not query_terms:
        return 0
    text_terms = set(text.lower().split())
    return len(query_terms & text_terms)


def _query_terms(request: WritingContextRequest, selection: SelectionContext | None) -> set[str]:
    combined = request.user_request
    if selection is not None:
        combined = f"{combined} {selection.selected_text}"
    return {t for t in combined.lower().split() if len(t) > 3}


def _build_notes_and_highlights(
    notebooks_repo: NotebooksRepository,
    *,
    user_id: uuid.UUID,
    query_terms: set[str],
) -> tuple[list[EvidenceItem], list[EvidenceItem]]:
    entries = notebooks_repo.list_all_entries_for_user(user_id)
    scored = [(_notebook_relevance_score(query_terms, _entry_text(e)), e) for e in entries]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    notes: list[EvidenceItem] = []
    highlights: list[EvidenceItem] = []
    for score, entry in scored:
        if score <= 0 and query_terms:
            continue  # Part 8 — never send every note/highlight automatically
        text = _entry_text(entry)
        if not text.strip():
            continue
        is_manual = entry.entry_type == "manual"
        item = EvidenceItem(
            kind="user_note" if is_manual else "user_highlight",
            text=text,
            estimated_tokens=estimate_tokens(text),
            note_id=str(entry.id) if is_manual else None,
            highlight_id=str(entry.id) if not is_manual else None,
            document_id=entry.document_id,
            document_title=entry.document_title_snapshot,
            page_number=entry.page_number,
        )
        if is_manual and len(notes) < _MAX_NOTES:
            notes.append(item)
        elif not is_manual and len(highlights) < _MAX_HIGHLIGHTS:
            highlights.append(item)
        if len(notes) >= _MAX_NOTES and len(highlights) >= _MAX_HIGHLIGHTS:
            break
    return notes, highlights


def _entry_text(entry) -> str:  # type: ignore[no-untyped-def]
    if entry.entry_type == "manual":
        return entry.note_text or ""
    parts = [entry.excerpt_snapshot or "", entry.note_text or ""]
    return " ".join(p for p in parts if p).strip()


def _build_reference_context(
    *, root_content: str, root_path: str, tex_files: dict[str, str], edum8_reference_count: int
) -> tuple[ReferenceContext, ReferenceModeResult]:
    result = detect_reference_mode(
        root_path=root_path,
        root_content=root_content,
        text_files=tex_files,
        edum8_reference_count=edum8_reference_count,
    )
    return (
        ReferenceContext(
            mode=result.mode,
            bibliography_source=result.bibliography_source,
            citation_key_source=result.citation_key_source,
            edum8_available=result.edum8_available,
        ),
        result,
    )


def _reference_metadata_items(
    reference_result: ReferenceModeResult, query_terms: set[str]
) -> list[EvidenceItem]:
    """Part 9 — bibliographic METADATA only (title known from the .bib/
    EduM8 entry), stamped `reference_metadata`, NEVER `source_passage`
    (Part 16: a BibTeX entry existing is not evidence the underlying
    paper was read). Ranked by term-overlap relevance when the request's
    own wording distinguishes between entries (e.g. mentions a specific
    citation key or a word from a title) — but, unlike notes/highlights
    (Part 8's stricter "do not send automatically", tested against a
    LARGE personal corpus where irrelevance is the common case), never
    reduced to an empty list purely because a generic reference-seeking
    phrasing ("which of my references...") happens to share no literal
    words with any one entry's title: Part 9 requires this layer to
    "expose the detected bibliography/reference state to later AI
    features" whenever a policy has already decided reference context is
    relevant — the actual bound against "send every reference" is the
    hard `_MAX_HIGHLIGHTS` cap below, not a relevance cliff that would
    make this layer effectively always-empty for ordinary phrasing."""
    scored = [
        (_notebook_relevance_score(query_terms, f"{key} {title}"), key, title)
        for key, title in reference_result.keys
    ]
    scored.sort(key=lambda s: s[0], reverse=True)
    items: list[EvidenceItem] = []
    for _score, key, title in scored[:_MAX_HIGHLIGHTS]:
        text = f"{key}: {title}" if title else key
        items.append(
            EvidenceItem(
                kind="reference_metadata",
                text=text,
                estimated_tokens=estimate_tokens(text),
                reference_key=key,
            )
        )
    return items


def _evidence_items_from_chunks(chunks: list[RetrievedChunk]) -> list[EvidenceItem]:
    items: list[EvidenceItem] = []
    for chunk in chunks[:_MAX_EVIDENCE_CHUNKS]:
        items.append(
            EvidenceItem(
                kind="source_passage",
                text=chunk.text,
                estimated_tokens=estimate_tokens(chunk.text),
                document_id=chunk.document_id,
                document_title=chunk.title,
                page_number=chunk.page_number,
                chunk_id=chunk.chunk_id,
                score=chunk.score,
            )
        )
    return items


def build_writing_context(
    request: WritingContextRequest,
    *,
    user_id: uuid.UUID,
    files_repo: WritingProjectFilesRepository,
    notebooks_repo: NotebooksRepository,
    retriever: RetrieverLike | None,
    edum8_reference_count: int = 0,
) -> WritingContextPacket:
    """The single entry point. Raises WritingContextAuthorizationError if
    project_id doesn't resolve to a project owned by user_id (Part 19) —
    every other error condition (missing active file, empty project,
    no root, unresolved \\input) degrades gracefully into an emptier
    packet, never an exception, per Parts 4/5's "never invent... handle
    missing targets gracefully."""
    build_start = time.perf_counter()
    try:
        project_uuid = uuid.UUID(request.project_id)
    except ValueError as exc:
        raise WritingContextAuthorizationError(
            f"invalid project_id {request.project_id!r}"
        ) from exc

    snapshot = _load_project_snapshot(files_repo, user_id=user_id, project_id=project_uuid)
    if snapshot is None:
        raise WritingContextAuthorizationError(
            f"project {request.project_id!r} not found or not owned by user"
        )

    policy: ContextPolicyName = request.policy_override or classify_intent(
        request.user_request, has_selection=bool(request.selection_start != request.selection_end)
    )
    layers = POLICY_LAYERS[policy]

    active, active_content, freshness = _resolve_active_content(request, snapshot)

    selection: SelectionContext | None = None
    section: SectionContext | None = None
    if active is not None and layers["selection"]:
        selection = _build_selection(request, active, active_content, freshness)
    if active is not None and layers["section"]:
        anchor = (
            selection.selection_start
            if selection is not None and selection.selection_start is not None
            else (request.cursor_position or 0)
        )
        section = _build_section(active, active_content, anchor)

    project_structure = (
        _build_project_structure(snapshot, active) if layers["project_structure"] else None
    )

    query_terms = _query_terms(request, selection)

    notes: list[EvidenceItem] = []
    highlights: list[EvidenceItem] = []
    if layers["notes"] or layers["highlights"]:
        raw_notes, raw_highlights = _build_notes_and_highlights(
            notebooks_repo, user_id=user_id, query_terms=query_terms
        )
        notes = raw_notes if layers["notes"] else []
        highlights = raw_highlights if layers["highlights"] else []

    references: ReferenceContext | None = None
    reference_metadata: list[EvidenceItem] = []
    reference_result: ReferenceModeResult | None = None
    if snapshot.root_path is not None and snapshot.root_path in snapshot.files_by_path:
        text_files = {
            p: (snapshot.files_by_path[p].content_text or "") for p in snapshot.text_paths
        }
        references, reference_result = _build_reference_context(
            root_content=text_files.get(snapshot.root_path, ""),
            root_path=snapshot.root_path,
            tex_files=text_files,
            edum8_reference_count=edum8_reference_count,
        )
        if layers["reference_metadata"] and reference_result is not None:
            reference_metadata = _reference_metadata_items(reference_result, query_terms)

    evidence: list[EvidenceItem] = []
    retrieval_start = time.perf_counter()
    if (
        layers["evidence"]
        and request.include_evidence_retrieval
        and retriever is not None
        and request.user_request.strip()
    ):
        chunks = retriever.retrieve(
            request.user_request, user_id=str(user_id), top_k=_EVIDENCE_RETRIEVAL_TOP_K
        )
        evidence = _evidence_items_from_chunks(chunks)
    retrieval_duration_ms = (time.perf_counter() - retrieval_start) * 1000

    # --- Part 13: deduplicate before budgeting, in priority order ---
    enforcer = ContextBudgetEnforcer()
    selection_items = (
        [
            EvidenceItem(
                kind="manuscript_text",
                text=selection.selected_text
                or (selection.before_text[-1:] + selection.after_text[:1]),
                estimated_tokens=estimate_tokens(selection.selected_text),
            )
        ]
        if selection is not None and selection.selected_text
        else []
    )
    enforcer.add("selection", deduplicate_evidence(selection_items))

    nearby_items = (
        [
            EvidenceItem(
                kind="manuscript_text",
                text=(selection.before_text + selection.after_text),
                estimated_tokens=estimate_tokens(selection.before_text + selection.after_text),
            )
        ]
        if selection is not None and (selection.before_text or selection.after_text)
        else []
    )
    enforcer.add("nearby_text", deduplicate_evidence(nearby_items))

    section_items: list[EvidenceItem] = []
    if section is not None:
        label = " / ".join(
            x
            for x in (section.chapter, section.section, section.subsection, section.subsubsection)
            if x
        )
        if label:
            section_items = [
                EvidenceItem(
                    kind="manuscript_text", text=label, estimated_tokens=estimate_tokens(label)
                )
            ]
    enforcer.add("current_section", deduplicate_evidence(section_items))

    structure_items: list[EvidenceItem] = []
    if project_structure is not None:
        text = (
            f"root={project_structure.root_path} active={project_structure.active_file_path} "
            f"ancestors={project_structure.ancestor_paths}"
        )
        structure_items = [
            EvidenceItem(kind="manuscript_text", text=text, estimated_tokens=estimate_tokens(text))
        ]
    enforcer.add("project_structure", structure_items)

    kept_notes = enforcer.add("notes", deduplicate_evidence(notes))
    kept_highlights = enforcer.add("highlights", deduplicate_evidence(highlights))
    kept_reference_metadata = enforcer.add(
        "reference_metadata", deduplicate_evidence(reference_metadata)
    )
    kept_evidence = enforcer.add("evidence", deduplicate_evidence(evidence))

    budget_report = enforcer.report()

    manuscript_context_tokens = (
        budget_report.category_tokens_included.get("selection", 0)
        + budget_report.category_tokens_included.get("nearby_text", 0)
        + budget_report.category_tokens_included.get("current_section", 0)
        + budget_report.category_tokens_included.get("project_structure", 0)
    )
    build_duration_ms = (time.perf_counter() - build_start) * 1000
    diagnostics = WritingContextDiagnostics(
        policy=policy,
        active_file_id=request.active_file_id,
        selection_present=bool(selection is not None and selection.selected_text),
        manuscript_context_tokens=manuscript_context_tokens,
        notes_count=len(kept_notes),
        highlights_count=len(kept_highlights),
        references_count=len(kept_reference_metadata),
        evidence_chunk_count=len(kept_evidence),
        estimated_total_tokens=budget_report.total_tokens_included,
        context_build_duration_ms=round(build_duration_ms, 3),
        retrieval_duration_ms=round(retrieval_duration_ms, 3),
        llm_calls_made=0,
    )

    return WritingContextPacket(
        policy=policy,
        user_request=request.user_request,
        selection=selection,
        section=section,
        project_structure=project_structure,
        notes=kept_notes,
        highlights=kept_highlights,
        references=references,
        reference_metadata=kept_reference_metadata,
        evidence=kept_evidence,
        budget=budget_report,
        diagnostics=diagnostics,
    )
