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

from app.db.documents_repository import DocumentsRepository
from app.db.scopes_repository import (
    ConversationDocumentRecord,
    ProjectDocumentRecord,
    ScopesRepository,
)
from app.vectorstore.qdrant_client import QdrantVectorStore


class InvalidDocumentIdsError(Exception):
    """Raised by add_conversation_documents()/replace_conversation_documents()
    (Milestone 2: conversation document scope) when one or more requested
    document_ids don't exist, or exist but aren't owned by the caller —
    mapped to HTTP 404 by the route layer. Deliberately all-or-nothing:
    every id is validated BEFORE any association is created or removed, so
    a bulk request can never partially apply (see the milestone's "never
    trust document IDs supplied by the frontend" requirement — a caller
    can never learn *which* of several IDs exists vs. belongs to another
    user by observing a partial success)."""

    def __init__(self, invalid_ids: list[str]) -> None:
        super().__init__(f"Document ID(s) not found: {invalid_ids}")
        self.invalid_ids = invalid_ids


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


def add_conversation_documents(
    *,
    conversation_id: uuid.UUID,
    document_ids: list[str],
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    documents_repository: DocumentsRepository,
    vector_store: QdrantVectorStore,
) -> list[ConversationDocumentRecord] | None:
    """Bulk add (Milestone 2: conversation document scope) — adds every id
    in `document_ids` to this conversation's chat-scope selection in one
    call, built entirely on top of add_document_to_conversation (never a
    parallel bulk-specific SQL/Qdrant path): every id is validated (exists
    AND owned by `user_id`) BEFORE anything is written — see
    InvalidDocumentIdsError — so a request naming even one bad id changes
    nothing. Duplicate ids within `document_ids` are de-duplicated first
    (order-preserving), and re-adding a document already in scope is a
    no-op (add_document_to_conversation's own idempotency) — so this is
    safe to call repeatedly, e.g. from a multi-select UI that always
    re-sends its full current picks.

    Returns None if `conversation_id` doesn't exist / isn't owned by
    `user_id`. Returns the conversation's full current document list
    (not just the newly-added ones) on success, matching what a caller
    would get from immediately calling GET .../documents afterward."""
    existing = scopes_repository.list_conversation_documents(user_id, conversation_id)
    if existing is None:
        return None

    unique_ids = list(dict.fromkeys(document_ids))
    invalid_ids = [
        doc_id for doc_id in unique_ids if documents_repository.get(user_id, doc_id) is None
    ]
    if invalid_ids:
        raise InvalidDocumentIdsError(invalid_ids)

    for document_id in unique_ids:
        add_document_to_conversation(
            conversation_id=conversation_id,
            document_id=document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )

    result = scopes_repository.list_conversation_documents(user_id, conversation_id)
    assert result is not None  # conversation ownership already confirmed above
    return result


def replace_conversation_documents(
    *,
    conversation_id: uuid.UUID,
    document_ids: list[str],
    user_id: uuid.UUID,
    scopes_repository: ScopesRepository,
    documents_repository: DocumentsRepository,
    vector_store: QdrantVectorStore,
) -> list[ConversationDocumentRecord] | None:
    """Bulk replace (Milestone 2) — makes `document_ids` the conversation's
    *entire* chat-scope selection: documents currently associated but not
    in `document_ids` are removed, documents in `document_ids` but not yet
    associated are added, and documents in both are left untouched (no
    remove-then-re-add churn, no redundant Qdrant resync for a document
    whose association isn't actually changing). `document_ids=[]` clears
    the selection entirely — there is deliberately no separate "clear"
    endpoint; this is what it maps to.

    Same validation contract as add_conversation_documents: every id is
    checked (exists AND owned) before anything is written, so a bad id
    never partially applies. Returns None if the conversation doesn't
    exist / isn't owned by `user_id`."""
    existing = scopes_repository.list_conversation_documents(user_id, conversation_id)
    if existing is None:
        return None

    unique_ids = list(dict.fromkeys(document_ids))
    invalid_ids = [
        doc_id for doc_id in unique_ids if documents_repository.get(user_id, doc_id) is None
    ]
    if invalid_ids:
        raise InvalidDocumentIdsError(invalid_ids)

    current_ids = {record.document_id for record in existing}
    desired_ids = set(unique_ids)

    for document_id in current_ids - desired_ids:
        remove_document_from_conversation(
            conversation_id=conversation_id,
            document_id=document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )
    for document_id in desired_ids - current_ids:
        add_document_to_conversation(
            conversation_id=conversation_id,
            document_id=document_id,
            user_id=user_id,
            scopes_repository=scopes_repository,
            vector_store=vector_store,
        )

    result = scopes_repository.list_conversation_documents(user_id, conversation_id)
    assert result is not None  # conversation ownership already confirmed above
    return result


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
