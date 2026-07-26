"""Turns a chat attachment (see MessageAttachment in
app/db/models_conversations.py) into a real, searchable Document, and lets
that resulting document's scope be switched afterward — the "Analyze once /
Chat / Project / General corpus" states a chat attachment can move between.
`promote_attachment` and `switch_attachment_scope` deliberately share one
"set scope" primitive (`_apply_attachment_scope`) so calling promote()
again with a different scope behaves identically to switch(): there is
exactly one notion of "this attachment's current scope", not two competing
ones.

Designed so a future chat-composer attachment picker ("Add to this chat" /
"Add to this Project" / "Add to my general corpus") can call
promote_attachment directly, unmodified, the very first time a user picks a
scope for a freshly-uploaded attachment — this module doesn't assume
promotion only ever happens after the fact from a Project Corpus page.
"""

import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.core.document_ingestion import ingest_or_reuse_document
from app.core.document_scoping import (
    add_document_to_conversation,
    remove_document_from_conversation,
    sync_qdrant_scope,
)
from app.core.embedding_provider import EmbeddingProvider
from app.db.conversations_repository import ConversationsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.scopes_repository import ScopesRepository
from app.ingestion.metadata_schema import DocumentType, JournalQuartile
from app.services.attachment_storage import AttachmentStorage
from app.vectorstore.qdrant_client import QdrantVectorStore

AttachmentScope = Literal["chat", "project", "general"]

_INGESTIBLE_MIME = "application/pdf"


class AttachmentNotPromotableError(Exception):
    """Raised for a non-PDF attachment (images have no OCR loader — see
    app/ingestion/loaders/dispatch.py — so there is nothing to chunk or
    embed yet)."""


@dataclass(frozen=True)
class PromotionResult:
    attachment_id: uuid.UUID
    document_id: str
    scope: AttachmentScope
    project_id: str | None
    source_filename: str
    document_type: str
    reused: bool


def _apply_attachment_scope(
    *,
    attachment_conversation_id: uuid.UUID,
    attachment_id: uuid.UUID,
    document_id: str,
    scope: AttachmentScope,
    project_id: uuid.UUID | None,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> None:
    """Clears this attachment's own prior placement (its conversation's
    chat-scope association, and every project it was previously promoted
    into), then applies the newly requested one — "move", not "add",
    semantics, so a promoted attachment always has exactly one current
    scope. Never touches a ProjectDocument/ConversationDocument association
    the caller created independently through the plain document-scope
    endpoints (Prompt 1) — only state this attachment's own promotion
    created."""
    remove_document_from_conversation(
        conversation_id=attachment_conversation_id,
        document_id=document_id,
        user_id=user_id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )
    for existing_project_id in scopes_repository.list_project_ids_for_attachment(
        user_id, attachment_id
    ):
        scopes_repository.remove_project_attachment(user_id, existing_project_id, attachment_id)

    if scope == "chat":
        add_document_to_conversation(
            conversation_id=attachment_conversation_id,
            document_id=document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )
    elif scope == "project":
        assert project_id is not None
        scopes_repository.add_project_attachment(user_id, project_id, attachment_id, document_id)
        sync_qdrant_scope(
            document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )
    else:
        # "general": clearing above already leaves it scope-less, which is
        # exactly general-corpus-only visibility (see ChunkPayload's
        # scope_type default).
        sync_qdrant_scope(
            document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )


def promote_attachment(
    *,
    attachment_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: AttachmentScope,
    project_id: uuid.UUID | None,
    document_type: DocumentType,
    journal_quartile: JournalQuartile = None,
    title: str | None = None,
    authors: list[str] | None = None,
    publication_year: int | None = None,
    source_venue: str | None = None,
    doi: str | None = None,
    source_url: str | None = None,
    conversations_repository: ConversationsRepository,
    documents_repository: DocumentsRepository,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
    embedding_provider: EmbeddingProvider,
    attachment_storage: AttachmentStorage,
) -> PromotionResult | None:
    """Ingests attachment_id's bytes into a real searchable Document (or
    reuses an existing one with the same content — never duplicates
    vectors) the first time it's called for a given attachment; every
    subsequent call (including with a different `scope`) just re-applies
    scope placement via the same primitive switch_attachment_scope uses.
    Returns None if the attachment doesn't exist or isn't user_id's (404 in
    the route). Raises AttachmentNotPromotableError for a non-PDF mime
    (422 in the route)."""
    attachment = conversations_repository.get_attachment_for_promotion(user_id, attachment_id)
    if attachment is None:
        return None
    if attachment.mime != _INGESTIBLE_MIME:
        raise AttachmentNotPromotableError(
            f"Attachments of type '{attachment.mime}' cannot be promoted to a searchable "
            "document yet (only PDF is supported)."
        )

    if attachment.promoted_document_id is not None:
        document_record = documents_repository.get(user_id, attachment.promoted_document_id)
        assert document_record is not None
        reused = True
    else:
        data = attachment_storage.read(attachment.storage_key)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp_file:
            tmp_file.write(data)
            tmp_path = Path(tmp_file.name)
        try:
            document_record, reused = ingest_or_reuse_document(
                tmp_path,
                document_type=document_type,
                documents_repository=documents_repository,
                embedding_provider=embedding_provider,
                vector_store=vector_store,
                user_id=user_id,
                journal_quartile=journal_quartile,
                title=title,
                authors=authors,
                publication_year=publication_year,
                source_venue=source_venue,
                doi=doi,
                source_url=source_url,
                original_filename=attachment.original_filename,
            )
        finally:
            tmp_path.unlink(missing_ok=True)
        conversations_repository.set_attachment_promoted_document_id(
            attachment_id, document_record.document_id
        )

    _apply_attachment_scope(
        attachment_conversation_id=attachment.conversation_id,
        attachment_id=attachment_id,
        document_id=document_record.document_id,
        scope=scope,
        project_id=project_id,
        user_id=user_id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )

    return PromotionResult(
        attachment_id=attachment_id,
        document_id=document_record.document_id,
        scope=scope,
        project_id=str(project_id) if project_id else None,
        source_filename=document_record.source_filename,
        document_type=document_record.document_type,
        reused=reused,
    )


def switch_attachment_scope(
    *,
    attachment_id: uuid.UUID,
    user_id: uuid.UUID,
    scope: AttachmentScope,
    project_id: uuid.UUID | None,
    conversations_repository: ConversationsRepository,
    documents_repository: DocumentsRepository,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> PromotionResult | None:
    """Moves an already-promoted attachment's document to a new scope.
    Returns None if the attachment doesn't exist, isn't user_id's, or has
    never been promoted (nothing to switch — 404 in the route)."""
    attachment = conversations_repository.get_attachment_for_promotion(user_id, attachment_id)
    if attachment is None or attachment.promoted_document_id is None:
        return None

    document_record = documents_repository.get(user_id, attachment.promoted_document_id)
    assert document_record is not None

    _apply_attachment_scope(
        attachment_conversation_id=attachment.conversation_id,
        attachment_id=attachment_id,
        document_id=document_record.document_id,
        scope=scope,
        project_id=project_id,
        user_id=user_id,
        scopes_repository=scopes_repository,
        vector_store=vector_store,
    )

    return PromotionResult(
        attachment_id=attachment_id,
        document_id=document_record.document_id,
        scope=scope,
        project_id=str(project_id) if project_id else None,
        source_filename=document_record.source_filename,
        document_type=document_record.document_type,
        reused=True,
    )
