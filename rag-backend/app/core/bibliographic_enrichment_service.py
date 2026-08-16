"""Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness)
§9/§10/§20/§21/§30 — the ONE orchestration entry point that turns a
Crossref lookup (app/core/bibliographic_enrichment.py) into a persisted,
non-destructive change to a document's metadata. Both trigger paths this
milestone adds — the best-effort automatic post-ingest hook
(app/core/document_ingestion_jobs.py's _run(), after the job is already
marked complete) and the explicit user-triggered "Refresh metadata" route
(app/api/routes_documents.py) — call `enrich_document()` and nothing else,
so the two can never drift into different merge/failure-handling behavior.

Failure-safe by construction, matching this codebase's other external-
service orchestration (see app/core/evidence_shadow.py): every branch
below is a plain, checkable EnrichmentRunResult, never a raised exception
for an ordinary "the provider had nothing" outcome. The one exception this
module does NOT catch is a genuine DocumentsRepository/database failure —
those propagate, and it is the CALLER's responsibility to bound that (the
ingestion job's post-completion hook wraps this in try/except so a DB
hiccup during enrichment can never fail an already-succeeded upload; the
user-triggered route lets FastAPI's normal error handling surface it,
matching every other mutating endpoint in this codebase).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from app.config import Settings
from app.core.bibliographic_enrichment import (
    CrossrefProvider,
    EnrichmentFailureReason,
    merge_authoritative_metadata,
)
from app.db.documents_repository import DocumentRecord, DocumentsRepository
from app.ingestion.metadata_extraction import normalize_doi
from app.vectorstore.errors import VectorStoreError
from app.vectorstore.qdrant_client import QdrantVectorStore

logger = logging.getLogger(__name__)

#: Recorded verbatim into Document.enrichment_provider on every attempt —
#: a plain constant, not a config value, since Crossref-only is this
#: milestone's deliberate scope (Section 2: "Crossref first... do not add
#: providers for feature count"). Adding a second provider later means
#: adding a second constant here, not making this one configurable.
PROVIDER_NAME = "crossref"

#: Every value Document.enrichment_status can hold after a genuine lookup
#: attempt — "succeeded" plus CrossrefProvider's own failure vocabulary
#: (kept as the exact same strings so a log/metrics pipeline never needs a
#: second translation table between "what the provider said" and "what we
#: recorded"). Deliberately does NOT include "disabled"/"no_doi"/
#: "not_found_document" — enrich_document() returns those early, before
#: ever calling documents_repository.update_enrichment_status(), so
#: Document.enrichment_status only ever holds a value from this set.
EnrichmentAttemptStatus = EnrichmentFailureReason | Literal["succeeded"]

#: The full set of outcomes enrich_document() can report to a caller,
#: including the three "never even attempted a lookup" cases that are
#: deliberately NOT persisted to Document.enrichment_status (see below).
EnrichmentRunStatus = EnrichmentAttemptStatus | Literal["disabled", "no_doi", "not_found_document"]

#: Milestone 4.1 §30 — the exact set of bibliographic display fields a
#: successful enrichment is allowed to mirror into Qdrant chunk payloads,
#: deliberately identical to the CLI's `refresh-metadata` command's own
#: `_REFRESH_FIELDS` (cli/documents.py) rather than a new list invented
#: for this milestone. Excludes document_type/journal_quartile even
#: though merge_authoritative_metadata can update document_type — those
#: double as VectorStoreFilter fields elsewhere in this codebase, and
#: syncing them was never part of what either the CLI precedent or
#: Section 30 ("do NOT touch... retrieval ranking fields unless
#: explicitly intended") asked for. volume/issue/page_start/page_end/
#: publisher/abstract/language are excluded because ChunkPayload
#: (app/vectorstore/schemas.py) has no such fields to sync in the first
#: place — Qdrant was never storing them.
QDRANT_SYNC_FIELDS = frozenset(
    {"title", "authors", "publication_year", "source_venue", "doi", "source_url"}
)


def has_usable_doi(record: DocumentRecord) -> bool:
    """Whether "Refresh metadata" should even be offered for this document
    (Section 11: "Only show/enable when the document has a usable DOI").
    Re-validates shape rather than trusting `record.doi` is already
    normalized — a handful of documents predate Milestone 4's DOI
    normalization (manually entered before that validation existed) and
    could hold a value that looks DOI-ish but wouldn't actually resolve."""
    if not record.doi:
        return False
    return normalize_doi(record.doi) is not None


@dataclass(frozen=True)
class EnrichmentRunResult:
    """What enrich_document() reports back to both call sites (the
    post-ingest background hook and the user-triggered refresh route) —
    everything a caller needs to log, to build Section 12's "Updated N
    fields; M manual fields preserved" summary, and to decide what to tell
    the user, without either call site needing to know
    merge_authoritative_metadata's internals."""

    ok: bool
    status: EnrichmentRunStatus
    fields_updated: tuple[str, ...] = field(default_factory=tuple)
    manual_fields_preserved: int = 0
    #: True only when the metadata update itself succeeded but the
    #: best-effort Qdrant payload mirror (Section 30) failed — SQL is
    #: still the source of truth and is never rolled back for this
    #: (Section 31: "do not lose the user's correction").
    qdrant_sync_failed: bool = False


def enrich_document(
    *,
    user_id: uuid.UUID,
    document_id: str,
    documents_repository: DocumentsRepository,
    provider: CrossrefProvider,
    settings: Settings,
    vector_store: QdrantVectorStore | None = None,
) -> EnrichmentRunResult:
    """The single enrichment code path (Section 9/10's "one core
    enrichment function, two triggers"). Ownership-scoped throughout via
    `user_id` — DocumentsRepository.get()/update_metadata()/
    update_enrichment_status() all already refuse to touch a document
    belonging to a different user, so this never needs its own separate
    ownership check.

    `vector_store` is optional and best-effort ONLY (Section 30/31): pass
    None to skip Qdrant sync entirely (e.g. a caller that doesn't have one
    handy, or a test that only cares about the SQL side) — this never
    treats a missing vector_store as an error.
    """
    if not settings.bibliographic_enrichment_enabled:
        return EnrichmentRunResult(ok=False, status="disabled")

    record = documents_repository.get(user_id, document_id)
    if record is None:
        return EnrichmentRunResult(ok=False, status="not_found_document")

    if not has_usable_doi(record):
        return EnrichmentRunResult(ok=False, status="no_doi")
    assert record.doi is not None  # guaranteed by has_usable_doi() above

    outcome = provider.lookup_by_doi(record.doi)
    enriched_at = datetime.now(UTC)

    if not outcome.ok or outcome.work is None:
        failure: EnrichmentAttemptStatus = outcome.failure or "unknown_error"
        documents_repository.update_enrichment_status(
            user_id,
            document_id,
            enriched_at=enriched_at,
            provider=PROVIDER_NAME,
            status=failure,
        )
        logger.info("Enrichment lookup for document %s failed: %s", document_id, failure)
        return EnrichmentRunResult(ok=False, status=failure)

    current_values: dict[str, object] = {
        "title": record.title,
        "authors": record.authors,
        "publication_year": record.publication_year,
        "source_venue": record.source_venue,
        "volume": record.volume,
        "issue": record.issue,
        "page_start": record.page_start,
        "page_end": record.page_end,
        "publisher": record.publisher,
        "source_url": record.source_url,
        "abstract": record.abstract,
        "language": record.language,
        "document_type": record.document_type,
    }
    merge_result = merge_authoritative_metadata(
        current_values=current_values,
        current_sources=record.metadata_sources,
        work=outcome.work,
    )

    if merge_result.field_updates:
        updates: dict[str, object] = dict(merge_result.field_updates)
        updates["metadata_sources"] = {
            **record.metadata_sources,
            **merge_result.provenance_updates,
        }
        documents_repository.update_metadata(user_id, document_id, updates)

    documents_repository.update_enrichment_status(
        user_id,
        document_id,
        enriched_at=enriched_at,
        provider=PROVIDER_NAME,
        status="succeeded",
    )

    qdrant_sync_failed = False
    if merge_result.field_updates and vector_store is not None:
        qdrant_updates = {
            field_name: value
            for field_name, value in merge_result.field_updates.items()
            if field_name in QDRANT_SYNC_FIELDS
        }
        if qdrant_updates:
            try:
                vector_store.update_chunk_metadata(
                    document_id, user_id=str(user_id), updates=qdrant_updates
                )
            except VectorStoreError:
                # Section 31: SQL already committed above and stays the
                # source of truth — a stale Qdrant payload is a display-
                # only citation-freshness gap (see _message_response's own
                # SQL-overlay fallback in routes_conversations.py), never
                # a reason to lose or roll back the user's/provider's
                # correction.
                qdrant_sync_failed = True
                logger.warning(
                    "Qdrant metadata sync failed for document %s after enrichment", document_id
                )

    logger.info(
        "Enrichment succeeded for document %s: %d field(s) updated, %d manual field(s) preserved",
        document_id,
        len(merge_result.field_updates),
        merge_result.manual_fields_preserved,
    )
    return EnrichmentRunResult(
        ok=True,
        status="succeeded",
        fields_updated=tuple(sorted(merge_result.field_updates)),
        manual_fields_preserved=merge_result.manual_fields_preserved,
        qdrant_sync_failed=qdrant_sync_failed,
    )
