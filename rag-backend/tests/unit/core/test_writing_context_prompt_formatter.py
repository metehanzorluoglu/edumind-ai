"""Milestone 6.2 (Context-Aware Ask EduM8) Part 5/40 — the packet
formatter that turns a structured WritingContextPacket into the model-
readable `<writing_context>` text block. Category-delimiter and no-
duplication coverage complementing the live-request-level tests in
tests/unit/api/test_writing_context_live_integration.py."""

from __future__ import annotations

from app.core.writing_context_prompt_formatter import format_writing_context_block
from app.core.writing_context_schemas import (
    ContextBudgetReport,
    EvidenceItem,
    ProjectStructureContext,
    SectionContext,
    SelectionContext,
    WritingContextDiagnostics,
    WritingContextPacket,
)


def _empty_budget() -> ContextBudgetReport:
    return ContextBudgetReport(
        category_limits={},
        category_tokens_included={},
        category_tokens_omitted={},
        total_token_budget=6000,
        total_tokens_included=0,
    )


def _diagnostics(policy: str = "local_edit") -> WritingContextDiagnostics:
    return WritingContextDiagnostics(
        policy=policy,  # type: ignore[arg-type]
        active_file_id="file-1",
        selection_present=True,
        manuscript_context_tokens=10,
        notes_count=0,
        highlights_count=0,
        references_count=0,
        evidence_chunk_count=0,
        estimated_total_tokens=10,
        context_build_duration_ms=1.0,
        retrieval_duration_ms=0.0,
    )


def _base_packet(**overrides: object) -> WritingContextPacket:
    base: dict[str, object] = {
        "policy": "local_edit",
        "user_request": "Fix the grammar.",
        "selection": None,
        "section": None,
        "project_structure": None,
        "notes": [],
        "highlights": [],
        "references": None,
        "reference_metadata": [],
        "evidence": [],
        "budget": _empty_budget(),
        "diagnostics": _diagnostics(),
    }
    base.update(overrides)
    return WritingContextPacket(**base)  # type: ignore[arg-type]


class TestSelectionSection:
    def test_selected_text_appears_under_its_own_header(self) -> None:
        packet = _base_packet(
            selection=SelectionContext(
                file_id="f1",
                file_path="main.tex",
                selection_start=0,
                selection_end=10,
                selected_text="Some claim.",
                before_text="",
                after_text="",
            )
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "SELECTED MANUSCRIPT TEXT" in block
        assert "Some claim." in block

    def test_nearby_text_appears_under_its_own_header_distinct_from_selection(self) -> None:
        packet = _base_packet(
            selection=SelectionContext(
                file_id="f1",
                file_path="main.tex",
                selection_start=5,
                selection_end=15,
                selected_text="Selected bit.",
                before_text="Before context.",
                after_text="After context.",
            )
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "SURROUNDING MANUSCRIPT CONTEXT" in block
        assert "Before context." in block
        assert "After context." in block

    def test_unsaved_buffer_freshness_noted(self) -> None:
        packet = _base_packet(
            selection=SelectionContext(
                file_id="f1",
                file_path="main.tex",
                selection_start=0,
                selection_end=5,
                selected_text="Text.",
                content_freshness="unsaved_client_buffer",
            )
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "not-yet-saved" in block


class TestStructureSection:
    def test_structure_header_present_with_section_path(self) -> None:
        packet = _base_packet(
            section=SectionContext(
                file_id="f1",
                file_path="Discussion.tex",
                section="Discussion",
                subsection="Teacher Agency",
            ),
            project_structure=ProjectStructureContext(
                root_path="main.tex", active_file_path="Discussion.tex"
            ),
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "MANUSCRIPT STRUCTURE" in block
        assert "Discussion > Teacher Agency" in block
        assert "main.tex" in block


class TestNotesHighlightsReferenceMetadata:
    def test_notes_highlights_and_reference_metadata_each_get_their_own_header(self) -> None:
        packet = _base_packet(
            notes=[EvidenceItem(kind="user_note", text="A private note.", estimated_tokens=5)],
            highlights=[
                EvidenceItem(
                    kind="user_highlight",
                    text="A highlighted excerpt.",
                    estimated_tokens=5,
                    document_title="Some Paper",
                    page_number=4,
                )
            ],
            reference_metadata=[
                EvidenceItem(
                    kind="reference_metadata",
                    text="bib1: A Paper",
                    estimated_tokens=5,
                    reference_key="bib1",
                )
            ],
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "RESEARCHER NOTES" in block
        assert "A private note." in block
        assert "RESEARCHER HIGHLIGHTS" in block
        assert "A highlighted excerpt." in block
        assert "Some Paper" in block and "p. 4" in block
        assert "REFERENCE METADATA" in block
        assert "bib1: A Paper" in block

    def test_reference_metadata_never_labeled_as_evidence(self) -> None:
        packet = _base_packet(
            reference_metadata=[
                EvidenceItem(
                    kind="reference_metadata",
                    text="bib7: A Distant Paper",
                    estimated_tokens=5,
                    reference_key="bib7",
                )
            ],
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "NOT source evidence" in block


class TestEmptyPacket:
    def test_returns_none_when_nothing_to_show(self) -> None:
        packet = _base_packet()
        assert format_writing_context_block(packet) is None


class TestEvidenceExcludedFromThisBlock:
    def test_source_passage_evidence_never_appears_in_writing_context_block(self) -> None:
        """Part 5/14 — real retrieved-passage evidence flows through the
        existing numbered <source> pipeline, never through this block
        (see the module's own docstring)."""
        packet = _base_packet(
            selection=SelectionContext(
                file_id="f1",
                file_path="main.tex",
                selection_start=0,
                selection_end=5,
                selected_text="Text.",
            ),
            evidence=[
                EvidenceItem(
                    kind="source_passage",
                    text="A retrieved passage.",
                    estimated_tokens=5,
                    document_id="doc-1",
                )
            ],
        )
        block = format_writing_context_block(packet)
        assert block is not None
        assert "A retrieved passage." not in block
