import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.citation import Citation
from app.core.retrieval_schemas import RetrievedChunk
from app.core.time_utils import utcnow
from app.db.models_conversation_scope import ConversationScopeSettings
from app.db.models_conversations import Conversation, Message, MessageAttachment, MessageSource
from app.db.models_project_knowledge import ProjectKnowledgeItem
from app.db.models_projects import ProjectConversation
from app.db.models_scopes import ConversationDocument, ConversationNote, ProjectAttachment
from app.services.attachment_storage import AttachmentStorage


@dataclass
class ConversationSummary:
    id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime
    message_count: int
    last_message_preview: str | None


@dataclass
class MessageSourceRecord:
    rank: int
    document_id: str | None
    chunk_id: str
    chunk_index: int
    page_number: int
    score: float
    snippet_text: str
    title: str | None
    authors: list[str]
    publication_year: int | None
    source_venue: str | None
    document_type: str
    journal_quartile: str | None
    doi: str | None
    source_url: str | None
    source_filename: str
    scope: str


@dataclass
class MessageAttachmentRecord:
    id: uuid.UUID
    mime: str
    original_filename: str
    size_bytes: int
    page_count: int | None
    page_range_start: int | None
    page_range_end: int | None
    created_at: datetime
    source: str = "upload"
    generation_prompt: str | None = None
    generation_negative_prompt: str | None = None
    generation_seed: int | None = None
    generation_model: str | None = None
    generation_width: int | None = None
    generation_height: int | None = None
    saved_project_id: uuid.UUID | None = None


@dataclass(frozen=True)
class AttachmentForPromotion:
    """Read-shape for app/core/attachment_promotion.py — everything the
    promote/scope-switch flow needs about one attachment: its own
    conversation_id (for chat-scope association; MessageAttachment itself
    has no conversation_id column, only message_id), and
    promoted_document_id (None if never promoted)."""

    id: uuid.UUID
    conversation_id: uuid.UUID
    mime: str
    original_filename: str
    storage_key: str
    promoted_document_id: str | None


@dataclass
class NewAttachment:
    """A validated attachment (see app.services.attachment_storage) ready
    to be persisted — `storage_key` must already point at bytes that have
    actually been written to disk by the caller before this is passed to
    ConversationsRepository.add_attachments; this dataclass only ever
    creates the metadata row."""

    id: uuid.UUID
    mime: str
    original_filename: str
    size_bytes: int
    page_count: int | None
    page_range_start: int | None
    page_range_end: int | None
    storage_key: str
    source: str = "upload"
    generation_prompt: str | None = None
    generation_negative_prompt: str | None = None
    generation_seed: int | None = None
    generation_model: str | None = None
    generation_width: int | None = None
    generation_height: int | None = None
    saved_project_id: uuid.UUID | None = None


@dataclass
class MessageRecord:
    id: uuid.UUID
    conversation_id: uuid.UUID
    role: str
    content: str
    citations: list[object]
    citation_warnings: list[str]
    insufficient_evidence: bool
    created_at: datetime
    sources: list[MessageSourceRecord] = field(default_factory=list)
    attachments: list[MessageAttachmentRecord] = field(default_factory=list)
    transparency: dict[str, object] = field(default_factory=dict)
    status: str = "complete"
    error_message: str | None = None


_PREVIEW_MAX_CHARS = 120


def _preview(text: str) -> str:
    stripped = " ".join(text.split())
    if len(stripped) <= _PREVIEW_MAX_CHARS:
        return stripped
    return stripped[:_PREVIEW_MAX_CHARS].rstrip() + "…"


def _to_message_source_record(row: MessageSource) -> MessageSourceRecord:
    return MessageSourceRecord(
        rank=row.rank,
        document_id=row.document_id,
        chunk_id=row.chunk_id,
        chunk_index=row.chunk_index,
        page_number=row.page_number,
        score=row.score,
        snippet_text=row.snippet_text,
        title=row.title,
        authors=list(row.authors),
        publication_year=row.publication_year,
        source_venue=row.source_venue,
        document_type=row.document_type,
        journal_quartile=row.journal_quartile,
        doi=row.doi,
        source_url=row.source_url,
        source_filename=row.source_filename,
        scope=row.scope,
    )


def _to_message_attachment_record(row: MessageAttachment) -> MessageAttachmentRecord:
    return MessageAttachmentRecord(
        id=row.id,
        mime=row.mime,
        original_filename=row.original_filename,
        size_bytes=row.size_bytes,
        page_count=row.page_count,
        page_range_start=row.page_range_start,
        page_range_end=row.page_range_end,
        created_at=row.created_at,
        source=row.source,
        generation_prompt=row.generation_prompt,
        generation_negative_prompt=row.generation_negative_prompt,
        generation_seed=row.generation_seed,
        generation_model=row.generation_model,
        generation_width=row.generation_width,
        generation_height=row.generation_height,
        saved_project_id=row.saved_project_id,
    )


def _to_message_record(
    row: Message, sources: list[MessageSource], attachments: list[MessageAttachment]
) -> MessageRecord:
    return MessageRecord(
        id=row.id,
        conversation_id=row.conversation_id,
        role=row.role,
        content=row.content,
        citations=list(row.citations),
        citation_warnings=list(row.citation_warnings),
        insufficient_evidence=row.insufficient_evidence,
        created_at=row.created_at,
        sources=[_to_message_source_record(s) for s in sorted(sources, key=lambda s: s.rank)],
        attachments=[
            _to_message_attachment_record(a)
            for a in sorted(attachments, key=lambda a: a.created_at)
        ],
        transparency=dict(row.transparency),
        status=row.status,
        error_message=row.error_message,
    )


class ConversationsRepository:
    """All methods are scoped to a given `user_id` and return `None`/`False`
    for a conversation that doesn't exist *or* belongs to a different user —
    deliberately indistinguishable, matching DocumentsRepository's "404, not
    403" convention (see app/db/documents_repository.py)."""

    def __init__(self, db: Session, attachment_storage: AttachmentStorage) -> None:
        self._db = db
        self._attachment_storage = attachment_storage

    def create(self, *, user_id: uuid.UUID) -> Conversation:
        conversation = Conversation(user_id=user_id)
        self._db.add(conversation)
        self._db.commit()
        self._db.refresh(conversation)
        return conversation

    def get(self, user_id: uuid.UUID, conversation_id: uuid.UUID) -> Conversation | None:
        stmt = select(Conversation).where(
            Conversation.id == conversation_id, Conversation.user_id == user_id
        )
        return self._db.execute(stmt).scalar_one_or_none()

    def list_for_user(
        self, user_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[ConversationSummary], int]:
        total = self._db.execute(
            select(func.count()).select_from(Conversation).where(Conversation.user_id == user_id)
        ).scalar_one()

        stmt = (
            select(Conversation)
            .where(Conversation.user_id == user_id)
            .order_by(Conversation.updated_at.desc())
            .limit(limit)
            .offset(offset)
        )
        conversations = list(self._db.execute(stmt).scalars().all())

        summaries = []
        for conversation in conversations:
            count = self._db.execute(
                select(func.count())
                .select_from(Message)
                .where(Message.conversation_id == conversation.id)
            ).scalar_one()
            last_message = self._db.execute(
                select(Message)
                .where(Message.conversation_id == conversation.id)
                .order_by(Message.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()
            summaries.append(
                ConversationSummary(
                    id=conversation.id,
                    title=conversation.title,
                    created_at=conversation.created_at,
                    updated_at=conversation.updated_at,
                    message_count=count,
                    last_message_preview=_preview(last_message.content) if last_message else None,
                )
            )
        return summaries, total

    def rename(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID, title: str
    ) -> Conversation | None:
        conversation = self.get(user_id, conversation_id)
        if conversation is None:
            return None
        conversation.title = title
        conversation.title_is_custom = True
        self._db.commit()
        self._db.refresh(conversation)
        return conversation

    def delete(self, user_id: uuid.UUID, conversation_id: uuid.UUID) -> bool:
        """Deletes the conversation, its ProjectConversation association
        rows (see app/db/projects_repository.py's ProjectsRepository.delete
        for why this is done explicitly here rather than left to
        ondelete=CASCADE) — never the projects those associations pointed
        at — every attachment belonging to one of its messages, both
        the on-disk file (no DB-level cascade can reach the filesystem
        either way) and its metadata row, and (contextual-research-scopes
        milestone) its ConversationDocument/ConversationNote association
        rows plus any ProjectAttachment row "promoting" one of its
        attachments — never the documents/projects those associations
        pointed at. Also (Project Memory) nulls out `conversation_id` on
        any ProjectKnowledgeItem generated from this conversation — never
        deletes those rows, since a knowledge item is designed to outlive
        its source conversation. Also (research workspace) deletes this
        conversation's ConversationScopeSettings row — a scope toggle bar
        has no meaning independent of its conversation."""
        conversation = self.get(user_id, conversation_id)
        if conversation is None:
            return False

        message_ids = (
            self._db.execute(
                select(Message.id).where(Message.conversation_id == conversation_id)
            )
            .scalars()
            .all()
        )
        if message_ids:
            attachments = list(
                self._db.execute(
                    select(MessageAttachment).where(
                        MessageAttachment.message_id.in_(message_ids)
                    )
                )
                .scalars()
                .all()
            )
            attachment_ids = [attachment.id for attachment in attachments]
            if attachment_ids:
                self._db.execute(
                    delete(ProjectAttachment).where(
                        ProjectAttachment.message_attachment_id.in_(attachment_ids)
                    )
                )
            for attachment in attachments:
                self._attachment_storage.delete(attachment.storage_key)
            self._db.execute(
                delete(MessageAttachment).where(MessageAttachment.message_id.in_(message_ids))
            )

        self._db.execute(
            delete(ProjectConversation).where(
                ProjectConversation.conversation_id == conversation_id
            )
        )
        self._db.execute(
            delete(ConversationDocument).where(
                ConversationDocument.conversation_id == conversation_id
            )
        )
        self._db.execute(
            delete(ConversationNote).where(ConversationNote.conversation_id == conversation_id)
        )
        self._db.execute(
            update(ProjectKnowledgeItem)
            .where(ProjectKnowledgeItem.conversation_id == conversation_id)
            .values(conversation_id=None)
        )
        self._db.execute(
            delete(ConversationScopeSettings).where(
                ConversationScopeSettings.conversation_id == conversation_id
            )
        )
        self._db.delete(conversation)
        self._db.commit()
        return True

    def get_messages(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> list[MessageRecord] | None:
        conversation = self.get(user_id, conversation_id)
        if conversation is None:
            return None
        messages = list(
            self._db.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at.asc())
            )
            .scalars()
            .all()
        )
        if not messages:
            return []
        message_ids = [m.id for m in messages]
        sources = list(
            self._db.execute(
                select(MessageSource).where(MessageSource.message_id.in_(message_ids))
            )
            .scalars()
            .all()
        )
        sources_by_message: dict[uuid.UUID, list[MessageSource]] = {}
        for source in sources:
            sources_by_message.setdefault(source.message_id, []).append(source)

        attachments = list(
            self._db.execute(
                select(MessageAttachment).where(MessageAttachment.message_id.in_(message_ids))
            )
            .scalars()
            .all()
        )
        attachments_by_message: dict[uuid.UUID, list[MessageAttachment]] = {}
        for attachment in attachments:
            attachments_by_message.setdefault(attachment.message_id, []).append(attachment)

        return [
            _to_message_record(
                m, sources_by_message.get(m.id, []), attachments_by_message.get(m.id, [])
            )
            for m in messages
        ]

    def get_message(self, message_id: uuid.UUID) -> MessageRecord | None:
        """Single-message counterpart to get_messages — used by the SSE
        endpoint (see app/api/routes_conversations.py) to read the
        authoritative final row for a generation, whether this request's
        own background worker just finished or it's reading one an
        earlier request/reconnect already completed. Deliberately takes no
        `user_id` (unlike get_messages/get): ownership is always checked
        by the caller via the conversation lookup that already happened
        earlier in the same request — see _handle_conversation_message.

        `populate_existing=True` is required, not cosmetic: this same
        session's identity map may already hold *this exact row* from
        earlier in the same request (e.g. create_pending_assistant_message
        or reset_assistant_message_for_retry, both called before the
        background worker — see generation_manager.py — writes the real
        content via its own, separate session/connection). Without it,
        SQLAlchemy's default identity-map behavior would silently hand
        back the stale pre-generation copy (empty content, status
        'generating') instead of re-reading what the worker actually
        committed."""
        message = self._db.get(Message, message_id, populate_existing=True)
        if message is None:
            return None
        sources = list(
            self._db.execute(
                select(MessageSource).where(MessageSource.message_id == message_id)
            )
            .scalars()
            .all()
        )
        return _to_message_record(message, sources, [])

    def get_attachment_content_info(
        self,
        user_id: uuid.UUID,
        conversation_id: uuid.UUID,
        message_id: uuid.UUID,
        attachment_id: uuid.UUID,
    ) -> tuple[str, str, int | None] | None:
        """Returns (storage_key, mime, page_count) for GET
        .../attachments/{attachment_id} and its .../preview variant
        (milestones V3, V4) to actually serve the file's bytes back — None
        if the whole chain conversation -> message -> attachment doesn't
        match exactly, or the conversation isn't `user_id`'s, which the
        route maps to a 404 (never distinguishing "doesn't exist" from
        "belongs to someone else", same convention as everywhere else in
        this repository). Deliberately the only place storage_key ever
        leaves this repository — every other attachment-facing accessor
        returns MessageAttachmentRecord, which omits it (see that
        dataclass's docs)."""
        if self.get(user_id, conversation_id) is None:
            return None
        row = self._db.execute(
            select(MessageAttachment)
            .join(Message, Message.id == MessageAttachment.message_id)
            .where(
                MessageAttachment.id == attachment_id,
                MessageAttachment.message_id == message_id,
                Message.conversation_id == conversation_id,
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return row.storage_key, row.mime, row.page_count

    def get_attachment_for_promotion(
        self, user_id: uuid.UUID, attachment_id: uuid.UUID
    ) -> AttachmentForPromotion | None:
        """Looks up an attachment directly by id — unlike
        get_attachment_content_info above, no conversation_id/message_id is
        required in the path (POST /attachments/{id}/promote and
        PATCH /attachments/{id}/scope are top-level routes), so ownership
        is the direct MessageAttachment.user_id column check; the join to
        Message exists only to resolve conversation_id for the caller."""
        row = self._db.execute(
            select(MessageAttachment, Message.conversation_id)
            .join(Message, Message.id == MessageAttachment.message_id)
            .where(MessageAttachment.id == attachment_id, MessageAttachment.user_id == user_id)
        ).first()
        if row is None:
            return None
        attachment, conversation_id = row
        return AttachmentForPromotion(
            id=attachment.id,
            conversation_id=conversation_id,
            mime=attachment.mime,
            original_filename=attachment.original_filename,
            storage_key=attachment.storage_key,
            promoted_document_id=attachment.promoted_document_id,
        )

    def set_attachment_promoted_document_id(
        self, attachment_id: uuid.UUID, document_id: str
    ) -> None:
        """Records that this attachment has been ingested into document_id
        (see app/core/attachment_promotion.py). Callers are expected to
        have already resolved the attachment via
        get_attachment_for_promotion in the same request, so no ownership
        re-check happens here."""
        row = self._db.get(MessageAttachment, attachment_id)
        assert row is not None
        row.promoted_document_id = document_id
        self._db.commit()

    def list_attachments_for_message(self, message_id: uuid.UUID) -> list[MessageAttachmentRecord]:
        rows = list(
            self._db.execute(
                select(MessageAttachment).where(MessageAttachment.message_id == message_id)
            )
            .scalars()
            .all()
        )
        return [_to_message_attachment_record(a) for a in sorted(rows, key=lambda a: a.created_at)]

    def add_attachments(
        self, message_id: uuid.UUID, user_id: uuid.UUID, attachments: list[NewAttachment]
    ) -> list[MessageAttachmentRecord]:
        rows = [
            MessageAttachment(
                id=attachment.id,
                message_id=message_id,
                user_id=user_id,
                mime=attachment.mime,
                original_filename=attachment.original_filename,
                size_bytes=attachment.size_bytes,
                page_count=attachment.page_count,
                page_range_start=attachment.page_range_start,
                page_range_end=attachment.page_range_end,
                storage_key=attachment.storage_key,
                source=attachment.source,
                generation_prompt=attachment.generation_prompt,
                generation_negative_prompt=attachment.generation_negative_prompt,
                generation_seed=attachment.generation_seed,
                generation_model=attachment.generation_model,
                generation_width=attachment.generation_width,
                generation_height=attachment.generation_height,
                saved_project_id=attachment.saved_project_id,
            )
            for attachment in attachments
        ]
        self._db.add_all(rows)
        self._db.commit()
        for row in rows:
            self._db.refresh(row)
        return [_to_message_attachment_record(row) for row in rows]

    def add_generated_image_message(
        self,
        user_id: uuid.UUID,
        conversation_id: uuid.UUID,
        *,
        content: str,
        attachments: list[NewAttachment],
    ) -> MessageRecord | None:
        """Creates a standalone message (role="assistant") holding one
        image-generation batch's resulting attachments (see
        app/core/image_generation_service.py) — never runs the LLM, has no
        citations/sources/transparency, and is never paired with a pending
        user question the way a normal chat turn is (the frontend detects
        this by `attachments` being non-empty on an assistant message, an
        invariant no other code path produces — see chat/[id].tsx's
        pairMessages). Returns None if `conversation_id` doesn't exist or
        doesn't belong to `user_id` — same 404-not-403 convention as every
        other method here."""
        if self.get(user_id, conversation_id) is None:
            return None
        message = Message(
            conversation_id=conversation_id,
            role="assistant",
            content=content,
        )
        self._db.add(message)
        self._db.flush()  # assigns message.id, needed by the attachment rows below
        rows = [
            MessageAttachment(
                id=attachment.id,
                message_id=message.id,
                user_id=user_id,
                mime=attachment.mime,
                original_filename=attachment.original_filename,
                size_bytes=attachment.size_bytes,
                page_count=attachment.page_count,
                page_range_start=attachment.page_range_start,
                page_range_end=attachment.page_range_end,
                storage_key=attachment.storage_key,
                source=attachment.source,
                generation_prompt=attachment.generation_prompt,
                generation_negative_prompt=attachment.generation_negative_prompt,
                generation_seed=attachment.generation_seed,
                generation_model=attachment.generation_model,
                generation_width=attachment.generation_width,
                generation_height=attachment.generation_height,
                saved_project_id=attachment.saved_project_id,
            )
            for attachment in attachments
        ]
        self._db.add_all(rows)
        self._touch(conversation_id)
        self._db.commit()
        self._db.refresh(message)
        for row in rows:
            self._db.refresh(row)
        return _to_message_record(message, [], rows)

    def set_attachment_saved_project(
        self, user_id: uuid.UUID, attachment_id: uuid.UUID, project_id: uuid.UUID | None
    ) -> MessageAttachmentRecord | None:
        """Sets or clears (`project_id=None`) which of the caller's Projects
        a generated image is saved to (see MessageAttachment.saved_project_id's
        docs) — a simple gallery bookmark, never RAG scope placement. Caller
        (routes_attachments.py) is responsible for verifying `project_id`
        itself belongs to `user_id` before calling this; this method only
        re-checks that the attachment does."""
        row = self._db.execute(
            select(MessageAttachment).where(
                MessageAttachment.id == attachment_id, MessageAttachment.user_id == user_id
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        row.saved_project_id = project_id
        self._db.commit()
        self._db.refresh(row)
        return _to_message_attachment_record(row)

    def add_user_message(
        self, conversation_id: uuid.UUID, content: str, *, client_message_id: str | None = None
    ) -> Message:
        """Inserts a new user message, unless `client_message_id` matches one
        already stored for this conversation — a retry (double-click, lost
        response, explicit Retry after a failed generation) then returns the
        original row instead of inserting a duplicate. `content` is ignored
        on a replay match; the first write for a given id always wins."""
        if client_message_id is not None:
            existing = self._db.execute(
                select(Message).where(
                    Message.conversation_id == conversation_id,
                    Message.client_message_id == client_message_id,
                )
            ).scalar_one_or_none()
            if existing is not None:
                return existing

        message = Message(
            conversation_id=conversation_id,
            role="user",
            content=content,
            client_message_id=client_message_id,
        )
        self._db.add(message)
        self._touch(conversation_id)
        self._db.commit()
        self._db.refresh(message)
        return message

    def _write_sources(self, message_id: uuid.UUID, sources: list[RetrievedChunk]) -> None:
        for rank, chunk in enumerate(sources, start=1):
            self._db.add(
                MessageSource(
                    message_id=message_id,
                    rank=rank,
                    document_id=chunk.document_id,
                    chunk_id=chunk.chunk_id,
                    chunk_index=chunk.chunk_index,
                    page_number=chunk.page_number,
                    score=chunk.score,
                    # The full retrieved chunk text, not a character-capped
                    # excerpt: a chunk is already bounded (~3000 chars max,
                    # see app/ingestion/chunker.py's DEFAULT_CHUNK_SIZE_CHARS)
                    # and `snippet_text` is a Text column with no length
                    # limit — any further truncation here would just be data
                    # loss the frontend can never recover after a refresh.
                    # Visual "collapse to a few lines" truncation belongs in
                    # the frontend only (see SourceCard.tsx).
                    snippet_text=chunk.text.strip(),
                    title=chunk.title,
                    authors=chunk.authors,
                    publication_year=chunk.publication_year,
                    source_venue=chunk.source_venue,
                    document_type=chunk.document_type,
                    journal_quartile=chunk.journal_quartile,
                    doi=chunk.doi,
                    source_url=chunk.source_url,
                    source_filename=chunk.source_filename,
                    scope=chunk.scope,
                )
            )

    def add_assistant_message(
        self,
        conversation_id: uuid.UUID,
        *,
        content: str,
        citations: list[Citation],
        citation_warnings: list[str],
        insufficient_evidence: bool,
        sources: list[RetrievedChunk],
        transparency: dict[str, object] | None = None,
    ) -> Message:
        message = Message(
            conversation_id=conversation_id,
            role="assistant",
            content=content,
            citations=[c.model_dump(mode="json") for c in citations],
            citation_warnings=citation_warnings,
            insufficient_evidence=insufficient_evidence,
            transparency=transparency or {},
            status="complete",
        )
        self._db.add(message)
        self._db.flush()  # assigns message.id, needed by the source rows below
        self._write_sources(message.id, sources)
        self._touch(conversation_id)
        self._db.commit()
        self._db.refresh(message)
        return message

    def create_pending_assistant_message(
        self, conversation_id: uuid.UUID, *, parent_message_id: uuid.UUID
    ) -> Message:
        """Inserts an empty assistant row in status='generating' *before* any
        token has been produced — see app/core/generation_manager.py. This is
        what makes persistence independent of the client connection: the row
        (and, as the background worker progresses, its content) exists in the
        database regardless of whether any SSE client is still attached."""
        message = Message(
            conversation_id=conversation_id,
            role="assistant",
            content="",
            status="generating",
            parent_message_id=parent_message_id,
            generation_started_at=utcnow(),
        )
        self._db.add(message)
        self._touch(conversation_id)
        self._db.commit()
        self._db.refresh(message)
        return message

    def get_assistant_reply_for_user_message(self, user_message_id: uuid.UUID) -> Message | None:
        """The assistant row already generating/generated for this user
        message, if any — how a retry (same client_message_id) or a
        reconnect after a dropped connection finds "is there already
        something here" instead of starting a second, duplicate
        generation. At most one such row should ever exist per user
        message by construction (see _handle_conversation_message).

        `populate_existing=True` for the same reason as get_message: this
        session may already hold this exact row in its identity map from
        earlier in the same request (e.g. it was the one that created the
        pending row in the first place), and the status this call cares
        about most (did it move past 'generating'?) is precisely the kind
        of change only ever made by a *different* session — the
        background worker's own (see app/core/generation_manager.py)."""
        return (
            self._db.execute(
                select(Message)
                .where(Message.parent_message_id == user_message_id, Message.role == "assistant")
                .order_by(Message.created_at.desc())
                .execution_options(populate_existing=True)
            )
            .scalars()
            .first()
        )

    def reset_assistant_message_for_retry(self, message_id: uuid.UUID) -> Message:
        """Re-arms an existing assistant row (status in error/cancelled/
        interrupted) for a fresh generation attempt, in place — a retry
        never creates a second assistant message for the same question
        (see the module's "no duplicate messages" requirement)."""
        message = self._db.get(Message, message_id)
        assert message is not None
        message.content = ""
        message.status = "generating"
        message.error_message = None
        message.citations = []
        message.citation_warnings = []
        message.insufficient_evidence = False
        message.transparency = {}
        message.generation_started_at = utcnow()
        self._db.execute(delete(MessageSource).where(MessageSource.message_id == message_id))
        self._db.commit()
        self._db.refresh(message)
        return message

    def update_assistant_message(
        self,
        message_id: uuid.UUID,
        *,
        content: str,
        status: str,
        citations: list[Citation] | None = None,
        citation_warnings: list[str] | None = None,
        insufficient_evidence: bool = False,
        sources: list[RetrievedChunk] | None = None,
        transparency: dict[str, object] | None = None,
        error_message: str | None = None,
    ) -> None:
        """Finalizes a pending assistant row from the background worker
        thread (see app/core/generation_manager.py) — called with its own,
        independent DB session, never the request-scoped one, since the
        worker outlives the request that started it."""
        message = self._db.get(Message, message_id)
        if message is None:
            return
        message.content = content
        message.status = status
        message.error_message = error_message
        if citations is not None:
            message.citations = [c.model_dump(mode="json") for c in citations]
        if citation_warnings is not None:
            message.citation_warnings = citation_warnings
        message.insufficient_evidence = insufficient_evidence
        if transparency is not None:
            message.transparency = transparency
        if sources is not None:
            self._db.execute(delete(MessageSource).where(MessageSource.message_id == message_id))
            self._write_sources(message_id, sources)
        self._touch(message.conversation_id)
        self._db.commit()

    def maybe_set_auto_title(self, conversation_id: uuid.UUID, title: str) -> None:
        conversation = self._db.get(Conversation, conversation_id)
        if conversation is None or conversation.title_is_custom:
            return
        conversation.title = title
        self._db.commit()

    def _touch(self, conversation_id: uuid.UUID) -> None:
        # updated_at drives GET /conversations' sort order — a new message
        # (either role) must bump it, same as ChatGPT-style "most recently
        # active thread first" ordering. onupdate=func.now() only fires when
        # the row is actually included in an UPDATE, so set this directly
        # rather than relying on some other column happening to change too.
        conversation = self._db.get(Conversation, conversation_id)
        if conversation is not None:
            conversation.updated_at = utcnow()


def sweep_stale_generating_messages(db: Session) -> int:
    """Run once at application startup (see app/main.py). A message can only
    ever be genuinely 'generating' while the process that started its
    background worker (see app/core/generation_manager.py) is still alive —
    the in-memory registry backing that worker never survives a process
    restart. Any row still marked 'generating' when a *new* process starts
    is therefore unambiguously orphaned by a prior unclean shutdown (a
    deploy, a crash, an OOM-kill), not a live generation — flipped to
    'interrupted' so the UI shows a clear, honest status instead of a
    spinner that can never resolve. Returns the number of rows swept, for
    startup logging."""
    result = db.execute(
        update(Message).where(Message.status == "generating").values(status="interrupted")
    )
    db.commit()
    return result.rowcount or 0
