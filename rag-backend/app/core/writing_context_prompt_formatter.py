"""Milestone 6.2 (Context-Aware Ask EduM8) Part 5 — the LAST point a
WritingContextPacket (M6.1, app/core/writing_context_schemas.py) is ever
allowed to remain structured before becoming plain text. Every caller up
to and including app/api/routes_conversations.py passes the packet as a
real Pydantic object; this module is the one place that flattens it, and
only into clearly labeled sections — never one undifferentiated blob a
model has to infer categories from (Part 5: "Do not make the model infer
these categories from an anonymous blob").

Deliberately mirrors app/core/project_context.py's own established
pattern (a plain formatted string, wrapped in its own XML-ish block by
the prompt builder) rather than inventing a new prompt-block convention.
`format_writing_context_block`'s output is threaded through as its own
`<writing_context>` block (see prompt_builder.py's build_chat_prompt),
structurally separate from both `<project_context>` (Project Memory —
unrelated feature, unchanged) and the numbered `<source id="S...">`
evidence blocks (Part 14: research evidence provenance is not manuscript
context) — real retrieved-passage evidence for a Writing turn continues
to flow through the EXISTING RagService/citation pipeline unchanged, not
through this module, so a source in the model's answer is always a real,
independently retrieved+cited RetrievedChunk, never something silently
smuggled in here.
"""

from __future__ import annotations

from app.core.writing_context_schemas import EvidenceItem, WritingContextPacket

_SELECTION_HEADER = "SELECTED MANUSCRIPT TEXT"
_NEARBY_HEADER = "SURROUNDING MANUSCRIPT CONTEXT"
_STRUCTURE_HEADER = "MANUSCRIPT STRUCTURE"
_NOTES_HEADER = "RESEARCHER NOTES"
_HIGHLIGHTS_HEADER = "RESEARCHER HIGHLIGHTS"
_REFERENCE_METADATA_HEADER = "REFERENCE METADATA (bibliographic details only — NOT source evidence)"


def _format_evidence_list(items: list[EvidenceItem]) -> list[str]:
    """Formats each item as one bulleted line with its provenance
    (document title / page / citation key, whichever apply) parenthesized
    — never just the raw text, so a note/highlight/reference-metadata
    line always carries where it came from. Callers only invoke this
    with a non-empty list (each call site is itself gated on `if
    packet.<layer>:`), so no empty-list fallback is needed here."""
    lines: list[str] = []
    for item in items:
        provenance_bits = []
        if item.document_title:
            provenance_bits.append(item.document_title)
        if item.page_number is not None:
            provenance_bits.append(f"p. {item.page_number}")
        if item.reference_key:
            provenance_bits.append(f"key: {item.reference_key}")
        provenance = f" ({', '.join(provenance_bits)})" if provenance_bits else ""
        lines.append(f"- {item.text}{provenance}")
    return lines


def format_writing_context_block(packet: WritingContextPacket) -> str | None:
    """Returns None (never an empty-but-present block) when the packet
    has nothing at all to show — a request whose policy pulled zero
    layers (shouldn't normally happen, since selection/section are
    almost always present, but a defensive empty-project case is
    possible) must not add a hollow `<writing_context></writing_context>`
    wrapper to the prompt for no reason.

    SOURCE EVIDENCE (packet.evidence) is intentionally NOT included
    here — see the module docstring: real retrieved-passage evidence
    for the live answer flows through the existing RagService/citation
    pipeline (numbered <source> blocks), not through this text block,
    so every citation the model can make is always a real, independently
    retrieved chunk. `packet.evidence` itself remains populated only for
    the M6.1 /context inspection endpoint's own diagnostic purposes."""
    sections: list[str] = []

    if packet.selection is not None and packet.selection.selected_text:
        freshness_note = (
            " (from the researcher's current, not-yet-saved edits)"
            if packet.selection.content_freshness == "unsaved_client_buffer"
            else ""
        )
        sections.append(f'{_SELECTION_HEADER}{freshness_note}:\n"{packet.selection.selected_text}"')
        nearby_parts = []
        if packet.selection.before_text.strip():
            nearby_parts.append(f"...{packet.selection.before_text.strip()}")
        if packet.selection.after_text.strip():
            nearby_parts.append(f"{packet.selection.after_text.strip()}...")
        if nearby_parts:
            sections.append(f"{_NEARBY_HEADER}:\n" + "\n".join(nearby_parts))
    elif packet.selection is not None:
        # No real selection — just cursor neighborhood (Letter C).
        nearby_parts = []
        if packet.selection.before_text.strip():
            nearby_parts.append(f"...{packet.selection.before_text.strip()}")
        if packet.selection.after_text.strip():
            nearby_parts.append(f"{packet.selection.after_text.strip()}...")
        if nearby_parts:
            sections.append(
                f"{_NEARBY_HEADER} (cursor position, no active selection):\n"
                + "\n".join(nearby_parts)
            )

    if packet.section is not None:
        path_parts = [
            x
            for x in (
                packet.section.chapter,
                packet.section.section,
                packet.section.subsection,
                packet.section.subsubsection,
            )
            if x
        ]
        if path_parts or packet.section.file_path:
            structure_lines = [f"Active file: {packet.section.file_path}"]
            if path_parts:
                structure_lines.append("Section: " + " > ".join(path_parts))
            if packet.project_structure is not None and packet.project_structure.root_path:
                structure_lines.append(f"Root document: {packet.project_structure.root_path}")
            sections.append(f"{_STRUCTURE_HEADER}:\n" + "\n".join(structure_lines))
    elif packet.project_structure is not None and packet.project_structure.root_path:
        sections.append(
            f"{_STRUCTURE_HEADER}:\nActive file: {packet.project_structure.active_file_path}\n"
            f"Root document: {packet.project_structure.root_path}"
        )

    if packet.notes:
        sections.append(f"{_NOTES_HEADER}:\n" + "\n".join(_format_evidence_list(packet.notes)))

    if packet.highlights:
        sections.append(
            f"{_HIGHLIGHTS_HEADER}:\n" + "\n".join(_format_evidence_list(packet.highlights))
        )

    if packet.reference_metadata:
        sections.append(
            f"{_REFERENCE_METADATA_HEADER}:\n"
            + "\n".join(_format_evidence_list(packet.reference_metadata))
        )

    if not sections:
        return None
    return "\n\n".join(sections)
