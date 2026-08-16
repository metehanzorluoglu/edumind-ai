"""SQL-backed, per-user document metadata store — see app/db/models_documents.py
for why this fully replaces the old JSON duplicate registry rather than
sitting alongside it. Used by the API (app/api/routes_documents.py), the CLI
(cli/documents.py), and app/core/document_deletion.py; nothing else should
read or write the `documents` table directly.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import String, cast, func, or_, select
from sqlalchemy.orm import Session

from app.db.models_documents import Document
from app.db.models_folders import Folder
from app.ingestion.metadata_schema import DocumentMetadata


@dataclass(frozen=True)
class DocumentRecord:
    """Read-shape returned to callers — a plain dataclass, not the ORM
    entity itself, so callers never accidentally mutate/flush a row through
    an object they only asked to read."""

    document_id: str
    user_id: uuid.UUID
    folder_id: uuid.UUID | None
    sha256: str
    source_filename: str
    title: str | None
    authors: list[str]
    publication_year: int | None
    source_venue: str | None
    doi: str | None
    source_url: str | None
    document_type: str
    journal_quartile: str | None
    chunk_count: int
    page_count: int
    file_format: str
    ingested_at: datetime
    storage_key: str | None
    original_mime_type: str | None
    original_file_size_bytes: int | None
    # Milestone 4 — see Document's own docstring for the "unknown means
    # unknown" / provenance reasoning behind each of these.
    volume: str | None
    issue: str | None
    page_start: int | None
    page_end: int | None
    publisher: str | None
    abstract: str | None
    keywords: list[str]
    language: str | None
    metadata_sources: dict[str, str]
    # Milestone 4.1 — see Document's own docstring for why these are
    # separate from `metadata_sources` (no per-field provenance to track;
    # this is a single "when/by what/how did it go" record of the most
    # recent Crossref lookup attempt, not a bibliographic field itself).
    last_enriched_at: datetime | None
    enrichment_provider: str | None
    enrichment_status: str | None
    # Milestone 4.2 (Citation & BibTeX Foundation) — see Document.
    # citation_key's own docstring. None until get_or_create_citation_key
    # lazily backfills it.
    citation_key: str | None = None
    # Frontend/Platform Milestone 3.2.1 Part D — populated only by
    # search_for_user() below (a LEFT JOIN against folders), None
    # everywhere else. Optional/defaulted so every existing caller of
    # _to_record()/list_for_user()/list_in_folder() is unaffected.
    folder_name: str | None = None

    @property
    def original_file_available(self) -> bool:
        """Frontend/Platform Milestone 3.2.1: DELIBERATELY NOT what
        response-building code should use anymore — this only reflects
        whether `storage_key` was ever set, not whether the physical file
        still exists (see this milestone's report: a misconfigured
        storage root can leave `storage_key` set forever while the bytes
        it points at are gone). Kept for cheap non-response-facing checks
        that only care "did this document ever get a stored original"
        (there are none in this codebase today). Every route that reports
        `original_file_available` in an API response MUST instead call
        routes_documents.py's `_original_file_available(record,
        document_file_storage)`, which adds the real existence check."""
        return self.storage_key is not None


def _to_record(row: Document, *, folder_name: str | None = None) -> DocumentRecord:
    return DocumentRecord(
        document_id=row.document_id,
        user_id=row.user_id,
        folder_id=row.folder_id,
        sha256=row.sha256,
        source_filename=row.source_filename,
        title=row.title,
        authors=list(row.authors),
        publication_year=row.publication_year,
        source_venue=row.source_venue,
        doi=row.doi,
        source_url=row.source_url,
        document_type=row.document_type,
        journal_quartile=row.journal_quartile,
        chunk_count=row.chunk_count,
        page_count=row.page_count,
        file_format=row.file_format,
        ingested_at=row.ingested_at,
        storage_key=row.storage_key,
        original_mime_type=row.original_mime_type,
        original_file_size_bytes=row.original_file_size_bytes,
        volume=row.volume,
        issue=row.issue,
        page_start=row.page_start,
        page_end=row.page_end,
        publisher=row.publisher,
        abstract=row.abstract,
        keywords=list(row.keywords),
        language=row.language,
        metadata_sources=dict(row.metadata_sources),
        last_enriched_at=row.last_enriched_at,
        enrichment_provider=row.enrichment_provider,
        enrichment_status=row.enrichment_status,
        citation_key=row.citation_key,
        folder_name=folder_name,
    )


class DocumentsRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def contains_sha256(self, user_id: uuid.UUID, sha256: str) -> bool:
        """Duplicate check — scoped per-user: two different users uploading
        byte-identical files are independent owners, not a collision."""
        stmt = select(Document.document_id).where(
            Document.user_id == user_id, Document.sha256 == sha256
        )
        return self._db.execute(stmt).first() is not None

    def get_by_sha256(self, user_id: uuid.UUID, sha256: str) -> DocumentRecord | None:
        """Same lookup as contains_sha256, but returns the full existing
        record — used by app/core/document_ingestion.py's
        ingest_or_reuse_document to reuse an already-ingested document
        instead of erroring (the "do not duplicate uploads" rule for the
        new scope-aware upload paths). POST /documents' own duplicate
        check keeps using contains_sha256 + a hard 409; this method is
        additive, not a replacement."""
        row = self._db.execute(
            select(Document).where(Document.user_id == user_id, Document.sha256 == sha256)
        ).scalar_one_or_none()
        return _to_record(row) if row is not None else None

    def find_by_doi(
        self, user_id: uuid.UUID, doi: str, *, exclude_document_id: str | None = None
    ) -> DocumentRecord | None:
        """Milestone 4.1 §23/§24 — exact-DOI duplicate awareness, scoped
        per-user exactly like contains_sha256/get_by_sha256 above: two
        different users citing the same published work are independent
        owners, not a collision. `doi` must already be normalized (see
        app/ingestion/metadata_extraction.py's normalize_doi) — this does
        a plain equality match, never a fuzzy one (fuzzy bibliographic
        matching is Section 26's separate, deferred concern).

        Returns the OLDEST matching document (by ingested_at) when more
        than one somehow shares a DOI — deterministic, and matches the
        product framing ("this may already be in your library") of
        pointing at the pre-existing reference, not an arbitrary one.

        `exclude_document_id`: lets a caller checking "does a DOI I just
        assigned via enrichment collide with something else this user
        owns" skip the document being enriched itself, which trivially
        always matches its own DOI."""
        conditions = [Document.user_id == user_id, Document.doi == doi]
        if exclude_document_id is not None:
            conditions.append(Document.document_id != exclude_document_id)
        row = self._db.execute(
            select(Document).where(*conditions).order_by(Document.ingested_at.asc()).limit(1)
        ).scalar_one_or_none()
        return _to_record(row) if row is not None else None

    def create(
        self,
        *,
        user_id: uuid.UUID,
        metadata: DocumentMetadata,
        chunk_count: int,
        folder_id: uuid.UUID | None = None,
        storage_key: str | None = None,
        original_mime_type: str | None = None,
        original_file_size_bytes: int | None = None,
    ) -> DocumentRecord:
        # folder_id is deliberately not part of DocumentMetadata (see
        # app/ingestion/metadata_schema.py) — it's Milestone 1's
        # organizational placement, computed and validated by the caller
        # (see app/api/routes_documents.py's post_document, which resolves
        # and ownership-checks it BEFORE the slow background ingestion job
        # even starts), not something the ingestion/parsing pipeline itself
        # knows or cares about. Every pre-existing call site (CLI ingest,
        # ingest_or_reuse_document for project uploads) omits it and gets
        # the same "unfiled/root" placement documents have always had.
        row = Document(
            document_id=metadata.document_id,
            user_id=user_id,
            folder_id=folder_id,
            sha256=metadata.sha256,
            source_filename=metadata.source_filename,
            title=metadata.title,
            authors=metadata.authors,
            publication_year=metadata.publication_year,
            source_venue=metadata.source_venue,
            doi=metadata.doi,
            source_url=metadata.source_url,
            document_type=metadata.document_type,
            journal_quartile=metadata.journal_quartile,
            volume=metadata.volume,
            issue=metadata.issue,
            page_start=metadata.page_start,
            page_end=metadata.page_end,
            publisher=metadata.publisher,
            abstract=metadata.abstract,
            keywords=metadata.keywords,
            language=metadata.language,
            metadata_sources=metadata.metadata_sources,
            chunk_count=chunk_count,
            page_count=metadata.page_count,
            file_format=metadata.file_format,
            ingested_at=metadata.ingested_at,
            storage_key=storage_key,
            original_mime_type=original_mime_type,
            original_file_size_bytes=original_file_size_bytes,
        )
        self._db.add(row)
        self._db.commit()
        return _to_record(row)

    def get(self, user_id: uuid.UUID, document_id: str) -> DocumentRecord | None:
        """Returns None for a document that doesn't exist *or* belongs to a
        different user — deliberately indistinguishable, so callers (see
        DELETE /documents/{id}) can 404 without ever confirming or denying
        that a given ID belongs to someone else."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        return _to_record(row)

    def list_for_user(
        self, user_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[DocumentRecord], int]:
        total = self._db.execute(
            select(func.count()).select_from(Document).where(Document.user_id == user_id)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document)
                .where(Document.user_id == user_id)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        return [_to_record(row) for row in rows], total

    def list_in_folder(
        self,
        user_id: uuid.UUID,
        folder_id: uuid.UUID | None,
        *,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[DocumentRecord], int]:
        """Same shape as list_for_user, filtered to one folder instead of
        the whole corpus — `folder_id=None` means root/unfiled (backs GET
        /folders/contents' "what's directly in this folder" listing, see
        app/api/routes_folders.py). SQLAlchemy compiles
        `Document.folder_id == None` to `IS NULL`, so root-level documents
        are matched correctly rather than being excluded the way a naive
        `= NULL` SQL comparison would."""
        conditions = (Document.user_id == user_id, Document.folder_id == folder_id)
        total = self._db.execute(
            select(func.count()).select_from(Document).where(*conditions)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document)
                .where(*conditions)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .scalars()
            .all()
        )
        return [_to_record(row) for row in rows], total

    def search_for_user(
        self, user_id: uuid.UUID, q: str, *, limit: int = 20, offset: int = 0
    ) -> tuple[list[DocumentRecord], int]:
        """Frontend/Platform Milestone 3.2.1 Part D — LIBRARY search, not
        semantic corpus retrieval: a plain case-insensitive substring match,
        across every folder (never scoped to "whichever folder happens to
        be open" — see this milestone's report on why "search my whole
        library" is the expected mental model here). Deliberately does NOT
        touch Qdrant/embeddings/chunks — that's GET /search's job (app/api/
        routes_search.py), a fundamentally different feature this one is
        not a replacement for.

        Milestone 4 Section 7: extended beyond title/filename to also match
        author, year, journal/venue, and DOI — the fields a reviewing user
        actually remembers a reference by ("that Forrester paper", "the
        2019 one"). `authors` is a JSON column; `cast(..., String)` matches
        against its serialized text form (e.g. `["Jane Doe", "John
        Smith"]`) rather than a real per-element search — imprecise at the
        margins (a search for `"oe\", \"j"` could spuriously match across
        two different names) but a reasonable, honest trade-off for a
        plain substring search with no dedicated full-text index, and it
        never fabricates a match that isn't actually present in the raw
        text. `publication_year` is matched as its string form so
        searching "2019" works without the caller needing to know it's
        numeric.

        LEFT JOINs folders once, server-side, so each result can show
        where it lives (`folder_name`, None for root) without the caller
        making a second round trip per result — see DocumentRecord.
        folder_name's own docstring for why that field defaults to None
        everywhere else."""
        needle = f"%{q.strip()}%"
        conditions = (
            Document.user_id == user_id,
            or_(
                Document.title.ilike(needle),
                Document.source_filename.ilike(needle),
                Document.source_venue.ilike(needle),
                Document.doi.ilike(needle),
                cast(Document.authors, String).ilike(needle),
                cast(Document.publication_year, String).ilike(needle),
            ),
        )
        total = self._db.execute(
            select(func.count()).select_from(Document).where(*conditions)
        ).scalar_one()

        rows = (
            self._db.execute(
                select(Document, Folder.name)
                .outerjoin(Folder, Document.folder_id == Folder.id)
                .where(*conditions)
                .order_by(Document.ingested_at.desc())
                .limit(limit)
                .offset(offset)
            )
            .all()
        )
        return [_to_record(row[0], folder_name=row[1]) for row in rows], total

    def move_to_folder(
        self, user_id: uuid.UUID, document_id: str, folder_id: uuid.UUID | None
    ) -> DocumentRecord | None:
        """Reassigns which folder a document is filed under (None = move to
        root) — a single-column SQL UPDATE, never touching Qdrant: see
        app/db/models_documents.py's `folder_id` docstring for why this is
        deliberately safe (no re-parse, no re-embed, no chunk/vector
        rewrite). Caller (see app/api/routes_documents.py) is responsible
        for verifying `folder_id` belongs to this same user before calling
        this — this method itself only re-verifies the *document's*
        ownership, matching update_metadata()'s existing contract."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        row.folder_id = folder_id
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    # Every column update_metadata() is allowed to touch — both the
    # original six bibliographic fields (used by `python -m cli.documents
    # refresh-metadata`) and Milestone 4's edit endpoint (routes_documents.py),
    # its second and now primary caller now that this is HTTP-reachable.
    # Deliberately an explicit allowlist rather than trusting every caller's
    # own input validation: `updates` used to only ever come from a
    # hand-typed CLI script; now that a request body can shape it, a stray
    # key (or a future field added elsewhere in `Document` without updating
    # this allowlist) must fail loudly here rather than silently letting an
    # HTTP caller overwrite something like `sha256`, `chunk_count`, or
    # `ingested_at` that this method was never meant to touch.
    #
    # `document_type`/`journal_quartile` ARE included — Milestone 4 Section
    # 3 lists "document/reference type" as a canonical, user-correctable
    # bibliographic field, and both are otherwise-inert SQL columns from
    # this method's point of view (see this class's own module docstring:
    # nothing here touches Qdrant). Yes, both also happen to double as
    # VectorStoreFilter fields for retrieval filtering elsewhere in this
    # codebase — but a metadata edit deliberately never calls
    # QdrantVectorStore.update_chunk_metadata (Milestone 4's explicit "no
    # Qdrant mutation" constraint), so Qdrant's copy of these fields simply
    # stays whatever it was at ingestion time, and retrieval filtering
    # behavior is provably unaffected by any edit made through this method.
    METADATA_FIELDS = frozenset(
        {
            "title",
            "authors",
            "publication_year",
            "source_venue",
            "doi",
            "source_url",
            "document_type",
            "journal_quartile",
            "volume",
            "issue",
            "page_start",
            "page_end",
            "publisher",
            "abstract",
            "keywords",
            "language",
            "metadata_sources",
        }
    )

    def update_metadata(
        self, user_id: uuid.UUID, document_id: str, updates: dict[str, object]
    ) -> DocumentRecord | None:
        """Payload-only field update — never touches sha256/chunk_count/
        ingested_at/storage_key or any other non-bibliographic column (see
        METADATA_FIELDS above for the exact allowed set, and its own
        comment for why `document_type`/`journal_quartile` ARE included
        despite also being retrieval-filter fields elsewhere).
        Returns None if no row belonging to this user exists with this
        document_id (see get()'s docstring on why that's indistinguishable
        from 'exists but owned by someone else').

        Raises ValueError if `updates` contains a key outside
        METADATA_FIELDS — a programmer error at the call site (every
        caller today is either the CLI's hardcoded field list or
        Milestone 4's edit endpoint, which builds `updates` from a
        Pydantic request schema that only ever declares these same
        fields), never a condition a real user's input can trigger."""
        unknown_fields = set(updates) - self.METADATA_FIELDS
        if unknown_fields:
            raise ValueError(f"update_metadata() cannot touch field(s): {sorted(unknown_fields)}")
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        for field, value in updates.items():
            setattr(row, field, value)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def update_enrichment_status(
        self,
        user_id: uuid.UUID,
        document_id: str,
        *,
        enriched_at: datetime,
        provider: str,
        status: str,
    ) -> DocumentRecord | None:
        """Milestone 4.1 §21 — records the outcome of a Crossref lookup
        attempt (success, not-found, timeout, etc.) independent of
        update_metadata() above: this is called on EVERY attempt,
        including ones that changed no bibliographic field at all (e.g.
        the provider had nothing new to offer, or the lookup failed) —
        see app/core/bibliographic_enrichment_service.py. Deliberately a
        separate method rather than routing through update_metadata()'s
        METADATA_FIELDS allowlist: these three columns are enrichment
        bookkeeping, not user-editable bibliographic fields, and must
        never be reachable through PATCH /documents/{id}/metadata."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        row.last_enriched_at = enriched_at
        row.enrichment_provider = provider
        row.enrichment_status = status
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def get_or_create_citation_key(
        self, user_id: uuid.UUID, document_id: str
    ) -> DocumentRecord | None:
        """Milestone 4.2 (Citation & BibTeX Foundation) Section 16/17 —
        the ONE place a citation_key is ever generated. If the row already
        has one (the common case for any document that's had a citation/
        BibTeX request before), returns it completely untouched — this is
        what makes a key STABLE: a later metadata edit never routes
        through here again, so a key already pasted into someone's
        manuscript never changes. Only a row that has NEVER had a key
        (every document ingested before this milestone, or a brand new
        upload's very first citation/BibTeX request) gets one generated
        here, deterministically from its current metadata via
        app/core/citation_key.py, resolved against every OTHER key this
        SAME USER already has (collision scope is per-user, matching every
        other per-user uniqueness rule in this codebase — e.g.
        uq_documents_user_sha256) — then persisted immediately so every
        subsequent call is the cheap "already has one" path.

        Returns None if no row belonging to this user exists with this
        document_id (see get()'s docstring)."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return None
        if row.citation_key:
            return _to_record(row)

        # Local import: citation_item/citation_key live in app/core, which
        # already depends on this module's DocumentRecord — importing at
        # module level here would be circular.
        from app.core.citation_item import document_to_citation_item
        from app.core.citation_key import base_citation_key, resolve_citation_key

        existing_keys = {
            key
            for (key,) in self._db.execute(
                select(Document.citation_key).where(
                    Document.user_id == user_id,
                    Document.citation_key.is_not(None),
                    Document.document_id != document_id,
                )
            ).all()
        }
        item = document_to_citation_item(_to_record(row))
        row.citation_key = resolve_citation_key(base_citation_key(item), existing_keys)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)

    def delete(self, user_id: uuid.UUID, document_id: str) -> bool:
        """Returns True if a row belonging to this user was actually
        deleted. Never deletes (or reveals the existence of) another user's
        row with the same document_id — see get()'s docstring."""
        row = self._db.get(Document, document_id)
        if row is None or row.user_id != user_id:
            return False
        self._db.delete(row)
        self._db.commit()
        return True
