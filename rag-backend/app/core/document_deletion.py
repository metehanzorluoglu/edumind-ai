"""Shared document-deletion service.

Used by both `DELETE /documents/{document_id}` (app/api/routes_documents.py)
and `python -m cli.documents remove` (cli/documents.py) — exactly one place
knows how to fully remove a document, so the API and CLI can never drift
apart on what "delete" actually does.

Ownership is checked first, against the SQL `documents` table (the
authoritative per-user record — see app/db/documents_repository.py), before
anything in Qdrant is touched. A document that doesn't exist *or* belongs to
a different user is indistinguishable here — both return None, which
callers map to a 404 that never confirms or denies another user's data.

Ordering after that is deliberate: Qdrant chunks are deleted first, and the
SQL row is only removed after that succeeds. If Qdrant deletion raises,
nothing has changed yet (the SQL row is untouched, chunks are still there)
— a partial failure never leaves a document *looking* deleted while its
chunks are still searchable, or vice versa.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from app.db.document_highlights_repository import DocumentHighlightsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.scopes_repository import ScopesRepository
from app.services.document_file_storage import DocumentFileStorage
from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)


@dataclass
class DocumentDeletionResult:
    document_id: str
    source_filename: str
    deleted_chunks: int


def delete_document_by_id(
    document_id: str,
    *,
    user_id: uuid.UUID,
    vector_store: QdrantVectorStore,
    documents_repository: DocumentsRepository,
    scopes_repository: ScopesRepository,
    document_highlights_repository: DocumentHighlightsRepository,
    document_file_storage: DocumentFileStorage | None = None,
) -> DocumentDeletionResult | None:
    """Returns None if no document with this ID exists *for this user* —
    callers map that to a 404 (API) or a clear "not found" message (CLI).
    Raises VectorStoreError (propagated, not swallowed) if Qdrant deletion
    itself fails; the API's global exception handler turns that into a
    clean 500, and no partial state is left behind (see module docstring).

    Also removes (contextual-research-scopes milestone) every
    ConversationDocument/ProjectDocument association row pointing at this
    document, right before the SQL documents row itself is removed — see
    ScopesRepository.delete_associations_for_document's docstring for why
    this can't be left to a declared FK cascade in this app. Also removes
    (Frontend Milestone 3 — Document Reader) every DocumentHighlight row
    anchored to this document, same reasoning — see
    DocumentHighlightsRepository.delete_for_document's docstring. Also
    deletes (Frontend Milestone 3.1) the document's original stored file,
    if one exists — `document_file_storage` is optional only so existing
    callers/tests that never persisted a file (or don't care about it) can
    omit it without constructing a real storage instance; every real
    caller (routes_documents.py, cli/documents.py) passes one.

    Deliberately does NOT touch `notebook_entries` — a NotebookEntry
    survives its source document's deletion by design (M3.1 Notebook spec
    §5: it shows "Source unavailable" rather than disappearing). This is
    an intentional asymmetry with `document_highlights` above, not an
    oversight — see NotebookEntry's docstring.
    """
    record = documents_repository.get(user_id, document_id)
    if record is None:
        return None

    deleted_chunks = vector_store.delete_document(document_id, user_id=str(user_id))
    scopes_repository.delete_associations_for_document(document_id)
    document_highlights_repository.delete_for_document(document_id)
    documents_repository.delete(user_id, document_id)
    if document_file_storage is not None and record.storage_key is not None:
        document_file_storage.delete(record.storage_key)

    # Never logs source_filename or any other document content — only the
    # ID and a count, consistent with this project's "no sensitive data in
    # logs" convention (see cli/reporting.py, cli/privacy_scan.py).
    logger.info("Deleted document %s: %d chunk(s) removed", document_id, deleted_chunks)

    return DocumentDeletionResult(
        document_id=document_id,
        source_filename=record.source_filename,
        deleted_chunks=deleted_chunks,
    )
