import uuid
from collections.abc import Sequence
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.core.retrieval_schemas import RetrievedChunk, ScopeTierName
from app.ingestion.metadata_schema import DocumentType, JournalQuartile


class Citation(BaseModel):
    source_id: str
    # Frontend/Platform Milestone 3.2.2 Part C — a citation is either a
    # retrieved corpus chunk ("document", the pre-existing and by far the
    # most common case — every field below except source_id/source_kind is
    # populated for these, exactly as before) or a message's own attached
    # file ("attachment" — see build_attachment_citations). Discriminating
    # explicitly rather than inferring from which fields are None keeps the
    # two kinds impossible to confuse even as more optional fields are
    # added later.
    source_kind: Literal["document", "attachment"] = "document"
    # None only for an attachment-kind citation — never a fabricated
    # document_id standing in for "this came from an attachment, not the
    # library" (see build_attachment_citations' docstring).
    document_id: str | None = None
    chunk_id: str | None = None
    # Attachment-kind only: the real, persisted MessageAttachment id (see
    # app/db/models_conversations.py) — how the frontend fetches/displays
    # the actual file (GET .../attachments/{attachment_id}), and how a
    # citation is told apart from an unrelated attachment of the same
    # message that the model did NOT cite.
    attachment_id: str | None = None
    # Attachment-kind only: the attachment's own filename, since it has no
    # `title` in the corpus-document sense.
    display_name: str | None = None
    title: str | None = None
    authors: list[str] = Field(default_factory=list)
    publication_year: int | None = None
    source_venue: str | None = None
    # None only for an attachment-kind citation — a document TYPE is a
    # corpus-document concept (journal article, report, ...) that has no
    # honest equivalent for "the file the user just attached to this
    # message."
    document_type: DocumentType | None = None
    journal_quartile: JournalQuartile = None
    page_start: int | None = None
    page_end: int | None = None
    doi: str | None = None
    source_url: str | None = None
    # None only for an attachment-kind citation — there is no retrieval
    # relevance score for "the model looked at the file you attached,"
    # only for something actually ranked and returned by search.
    score: float | None = None
    # Which retrieval tier found this chunk (see
    # app/core/scoped_retrieval.py) — carried straight from the source
    # RetrievedChunk so the frontend can render "Current Chat"/"Current
    # Project"/"General Corpus" per source card. Meaningless for an
    # attachment (never retrieved from any tier) — left at the default.
    scope: ScopeTierName = "general"


def build_citations(sources: list[RetrievedChunk]) -> list[Citation]:
    """Assigns deterministic S1, S2, ... IDs in the given (already-ranked) order.

    page_start/page_end are both set to the chunk's single page_number: chunks
    are built per-page (see app/ingestion/chunker.py) and never span multiple
    pages, so a single page number is the accurate range, not an approximation."""
    return [
        Citation(
            source_id=f"S{index}",
            document_id=chunk.document_id,
            chunk_id=chunk.chunk_id,
            title=chunk.title,
            authors=chunk.authors,
            publication_year=chunk.publication_year,
            source_venue=chunk.source_venue,
            document_type=chunk.document_type,
            journal_quartile=chunk.journal_quartile,
            page_start=chunk.page_number,
            page_end=chunk.page_number,
            doi=chunk.doi,
            source_url=chunk.source_url,
            score=chunk.score,
            scope=chunk.scope,
        )
        for index, chunk in enumerate(sources, start=1)
    ]


class AttachmentLike(Protocol):
    """Structural type for build_attachment_citations below — matches
    app/db/conversations_repository.py's MessageAttachmentRecord (and
    nothing else there needs to be imported here, which would otherwise be
    circular: that module already imports Citation from this one). `id`
    is typed as the real uuid.UUID (not the looser `object`) because
    mypy checks Protocol data-attribute compatibility invariantly, not
    covariantly — a looser type here would make this Protocol NOT match
    MessageAttachmentRecord's own `id: uuid.UUID`, the opposite of the
    point of this Protocol."""

    id: uuid.UUID
    original_filename: str
    page_range_start: int | None
    page_range_end: int | None


def build_attachment_citations(
    attachments: Sequence[AttachmentLike], *, start_index: int
) -> list[Citation]:
    """Frontend/Platform Milestone 3.2.2 Part C — registers each of a
    message's own attached files as a real, citeable numbered source,
    exactly the way build_citations registers retrieved corpus chunks.

    Root cause this exists to fix: every attachment (image or PDF) is
    vision-routed (see app/api/routes_conversations.py's model-routing
    comment) and shown to the model as raw pixels, never as a numbered
    <source>. The old vision prompts (app/core/vision_prompt_builder.py)
    accordingly told the model attachments could never be cited — but a
    live smoke test during development already showed some vision models
    cite one anyway despite that instruction. Whenever that happened, the
    citation was correctly flagged "unknown" by validate_citations (S1 was
    never in the citations list) and rendered as the literal, confusing
    "[S1 — unavailable]" even when the underlying claim WAS accurately
    grounded in the attachment — a false-negative provenance failure, not
    a real hallucination.

    The fix: give each attachment a real S<n> label (continuing past any
    retrieved corpus citations via `start_index`, so a message with both
    never collides — see app/api/routes_conversations.py's call site) and
    tell the model it MAY cite that label (see build_vision_prompt) —
    turning "the model disobeys an instruction" into "the model correctly
    uses a label it was actually given." `document_id`/`document_type`/
    `score`/`chunk_id` are never fabricated for these — they simply stay
    None (see Citation's own field docs); `attachment_id`/`display_name`
    are what the frontend actually needs to resolve and show the
    citation (fetch via GET .../attachments/{attachment_id}, render as
    `display_name`) instead of a fake corpus-source card.
    """
    return [
        Citation(
            source_id=f"S{index}",
            source_kind="attachment",
            attachment_id=str(attachment.id),
            display_name=attachment.original_filename,
            page_start=attachment.page_range_start,
            page_end=attachment.page_range_end,
        )
        for index, attachment in enumerate(attachments, start=start_index)
    ]
