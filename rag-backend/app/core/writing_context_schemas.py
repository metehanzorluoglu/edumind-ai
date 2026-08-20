"""Milestone 6.1 (Writing Context Engine) — the structured request/packet
contract. Kept as plain Pydantic models (no ORM/DB coupling) so the
engine, its tests, and the eventual model-adapter boundary all share one
definition of "what Writing context looks like" — Part 15's "CONTEXT MUST
REMAIN STRUCTURED UNTIL THE FINAL MODEL-ADAPTER BOUNDARY."

Provenance (Part 16) is a closed set — every piece of evidence this
engine ever returns is stamped with exactly one of these five kinds, so a
later feature (M6.2+) can never present bibliography metadata as though
it were a passage actually read from a paper.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

ProvenanceKind = Literal[
    "manuscript_text",
    "user_note",
    "user_highlight",
    "reference_metadata",
    "source_passage",
]

ContextPolicyName = Literal[
    "local_edit",
    "explanation",
    "manuscript_question",
    "reference_question",
    "cross_source_synthesis",
]


class WritingContextRequest(BaseModel):
    """One inbound request for Writing context — Part 3's contract.
    `selected_text` is accepted but is NEVER trusted as canonical (Part
    3: "Do NOT trust client-provided selected text as canonical
    manuscript content") — the engine always recomputes the actual
    selection substring from `selection_start`/`selection_end` against
    real file content (see writing_context_engine.resolve_active_file_content),
    and only uses the caller's `selected_text` to detect/report a
    mismatch (Part 3/16's honesty requirement), never as the source of
    truth itself."""

    project_id: str
    active_file_id: str | None = None
    cursor_position: int | None = None
    selection_start: int | None = None
    selection_end: int | None = None
    selected_text: str | None = None
    user_request: str = ""
    # Part 3 — "Handle unsaved editor state honestly." When the caller
    # (the Writing editor, which always knows its own live buffer) has
    # unsaved keystrokes newer than the last autosave, it MAY include
    # that buffer here. Only ever applies to `active_file_id` — every
    # OTHER file in the project (by construction of this app's
    # single-active-file editing model) can only be read from its saved
    # content, since it isn't the one currently open for editing.
    active_file_unsaved_content: str | None = None
    # Part 14 — an explicit override for testing/inspection; when None,
    # the engine classifies `user_request` itself (see
    # writing_context_policy.classify_intent).
    policy_override: ContextPolicyName | None = None
    include_evidence_retrieval: bool = True


class EvidenceItem(BaseModel):
    """One provenance-stamped piece of context (Part 16). `text` is the
    actual content included in the packet — already budget-truncated
    and deduplicated by the time it appears here (Part 13)."""

    kind: ProvenanceKind
    text: str
    estimated_tokens: int
    # Provenance identifiers — populated only for the kinds where they
    # apply; every other field stays None rather than an empty string,
    # so "no page number available" is never confused with "page 0".
    note_id: str | None = None
    highlight_id: str | None = None
    document_id: str | None = None
    document_title: str | None = None
    page_number: int | None = None
    reference_key: str | None = None  # BibTeX citation key, when known
    chunk_id: str | None = None
    score: float | None = None


class SelectionContext(BaseModel):
    file_id: str
    file_path: str
    selection_start: int | None = None
    selection_end: int | None = None
    selected_text: str = ""
    # Bounded surrounding text (Part 6) — text BEFORE/AFTER the
    # selection, kept structurally distinct so a later model prompt can
    # unambiguously mark "THIS IS WHAT THE USER SELECTED" rather than
    # asking a model to infer it from one undifferentiated blob.
    before_text: str = ""
    after_text: str = ""
    # Part 3 — honesty about whether `selected_text` is exactly what the
    # engine recomputed from real content at the given offsets.
    selected_text_matches_client: bool = True
    content_freshness: Literal["saved", "unsaved_client_buffer"] = "saved"


class SectionContext(BaseModel):
    file_id: str
    file_path: str
    chapter: str | None = None
    section: str | None = None
    subsection: str | None = None
    subsubsection: str | None = None
    line_start: int | None = None
    line_end: int | None = None


class ProjectStructureContext(BaseModel):
    root_path: str | None = None
    active_file_path: str | None = None
    # Direct \input/\include ancestors of the active file (Part 5's
    # worked example: "main.tex -> Discussion.tex" — the ONE relevant
    # relationship, never the full file list).
    ancestor_paths: list[str] = Field(default_factory=list)
    tex_file_count: int = 0


class ReferenceContext(BaseModel):
    mode: str | None = None  # ReferenceMode from app/core/reference_mode.py, as a string
    bibliography_source: str | None = None
    citation_key_source: str | None = None
    edum8_available: bool = False


class ContextBudgetReport(BaseModel):
    """Part 11's required transparency: what was requested, what
    actually made it into the packet, and what was cut for budget
    reasons — per category, plus a total."""

    category_limits: dict[str, int]
    category_tokens_included: dict[str, int]
    category_tokens_omitted: dict[str, int]
    total_token_budget: int
    total_tokens_included: int


class WritingContextDiagnostics(BaseModel):
    """Part 20's observability contract — safe to log (IDs/counts/token
    sizes only, never manuscript text or evidence text)."""

    policy: ContextPolicyName
    active_file_id: str | None
    selection_present: bool
    manuscript_context_tokens: int
    notes_count: int
    highlights_count: int
    references_count: int
    evidence_chunk_count: int
    estimated_total_tokens: int
    context_build_duration_ms: float
    retrieval_duration_ms: float
    llm_calls_made: int = 0  # Part 14/17 — must always be 0 in M6.1


class WritingContextPacket(BaseModel):
    """The full structured result (Part 15). Layers absent for this
    request/policy are simply empty (empty list / None), never
    populated with placeholder content."""

    policy: ContextPolicyName
    user_request: str
    selection: SelectionContext | None = None
    section: SectionContext | None = None
    project_structure: ProjectStructureContext | None = None
    notes: list[EvidenceItem] = Field(default_factory=list)
    highlights: list[EvidenceItem] = Field(default_factory=list)
    references: ReferenceContext | None = None
    reference_metadata: list[EvidenceItem] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    budget: ContextBudgetReport
    diagnostics: WritingContextDiagnostics
