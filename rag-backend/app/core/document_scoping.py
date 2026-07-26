"""Shared document<->scope association service. Used by both
POST/DELETE /conversations/{id}/documents (app/api/routes_conversations.py)
and POST/DELETE /projects/{id}/documents (app/api/routes_projects.py) —
exactly one place knows how to add/remove a document<->conversation or
document<->project association and keep Qdrant's denormalized scope
payload in sync with the SQL association tables (the source of truth for
*which* scopes reference a document), so the two routers can never drift
apart on what "associate a document" actually does.

Ordering is deliberate: the SQL association row is created/removed FIRST
(idempotent — see ScopesRepository's get-or-create pattern — and cannot
fail once ownership is already verified there), and the Qdrant payload
sync happens after. If the Qdrant call raises, the SQL row already
reflects the caller's intent and is safely re-syncable: a retry of the
same request finds the existing SQL association and simply re-attempts
the Qdrant write, rather than risking a Qdrant-tagged-but-SQL-untracked
association that no DELETE endpoint could ever find again.

Never duplicates a document's vectors or its documents/Qdrant rows — an
association here only ever adds/removes a pointer, and the Qdrant resync
is always a payload-only set_payload recomputed from the full current SQL
association state (never an incremental append/remove on the Qdrant side).
"""

import uuid

from app.db.scopes_repository import (
    ConversationDocumentRecord,
    ProjectDocumentRecord,
    ScopesRepository,
)
from app.vectorstore.qdrant_client import QdrantVectorStore


def sync_qdrant_scope(
    document_id: str,
    *,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> None:
    conversation_ids = scopes_repository.list_conversation_ids_for_document(user_id, document_id)
    project_ids = scopes_repository.list_project_ids_for_document(user_id, document_id)
    vector_store.update_scope_associations(
        document_id,
        user_id=str(user_id),
        conversation_ids=conversation_ids,
        project_ids=project_ids,
    )


def add_document_to_conversation(
    *,
    conversation_id: uuid.UUID,
    document_id: str,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> ConversationDocumentRecord | None:
    record = scopes_repository.add_conversation_document(user_id, conversation_id, document_id)
    if record is None:
        return None
    sync_qdrant_scope(
        document_id, user_id=user_id, scopes_repository=scopes_repository, vector_store=vector_store
    )
    return record


def remove_document_from_conversation(
    *,
    conversation_id: uuid.UUID,
    document_id: str,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> bool:
    removed = scopes_repository.remove_conversation_document(user_id, conversation_id, document_id)
    if not removed:
        return False
    sync_qdrant_scope(
        document_id, user_id=user_id, scopes_repository=scopes_repository, vector_store=vector_store
    )
    return True


def add_document_to_project(
    *,
    project_id: uuid.UUID,
    document_id: str,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> ProjectDocumentRecord | None:
    record = scopes_repository.add_project_document(user_id, project_id, document_id)
    if record is None:
        return None
    sync_qdrant_scope(
        document_id, user_id=user_id, scopes_repository=scopes_repository, vector_store=vector_store
    )
    return record


def remove_document_from_project(
    *,
    project_id: uuid.UUID,
    document_id: str,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> bool:
    removed = scopes_repository.remove_project_document(user_id, project_id, document_id)
    if not removed:
        return False
    sync_qdrant_scope(
        document_id, user_id=user_id, scopes_repository=scopes_repository, vector_store=vector_store
    )
    return True


def remove_attachment_from_project(
    *,
    project_id: uuid.UUID,
    message_attachment_id: uuid.UUID,
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    vector_store: QdrantVectorStore,
) -> bool:
    """Removes a promoted attachment's project association (never the
    attachment or the underlying document itself, which may still be
    reachable through another scope) — same "association first, then
    Qdrant resync" ordering as remove_document_from_project."""
    attachments = scopes_repository.list_project_attachments(user_id, project_id)
    if attachments is None:
        return False
    document_id = next(
        (a.document_id for a in attachments if a.message_attachment_id == message_attachment_id),
        None,
    )
    removed = scopes_repository.remove_project_attachment(
        user_id, project_id, message_attachment_id
    )
    if not removed:
        return False
    if document_id:
        sync_qdrant_scope(
            document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )
    return True
