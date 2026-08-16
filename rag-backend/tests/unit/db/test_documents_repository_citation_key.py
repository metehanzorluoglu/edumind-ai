"""Milestone 4.2 (Citation & BibTeX Foundation) Section 16/17 — tests for
DocumentsRepository.get_or_create_citation_key: the lazy-generate-once-
and-persist policy that keeps a citation key stable across future
metadata edits. Same "real repository against a temp on-disk SQLite DB"
convention as tests/unit/core/test_bibliographic_enrichment_service.py."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.ingestion.metadata_schema import DocumentMetadata


@pytest.fixture
def db_session() -> Iterator[Session]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
        os.remove(path)


def _make_user(db_session: Session) -> uuid.UUID:
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4()}@example.com")
    db_session.add(user)
    db_session.commit()
    return user.id


def _make_document(
    db_session: Session,
    user_id: uuid.UUID,
    *,
    title: str | None = "A Sample Title",
    authors: list[str] | None = None,
    publication_year: int | None = 2020,
) -> str:
    repository = DocumentsRepository(db_session)
    document_id = str(uuid.uuid4())
    metadata = DocumentMetadata(
        document_id=document_id,
        source_filename="paper.pdf",
        file_format="pdf",
        sha256=uuid.uuid4().hex + uuid.uuid4().hex,
        file_size_bytes=1000,
        page_count=3,
        document_type="journal_article",
        title=title,
        authors=authors or ["Jane Doe"],
        publication_year=publication_year,
        ingested_at=datetime.now(UTC),
    )
    repository.create(user_id=user_id, metadata=metadata, chunk_count=3)
    return document_id


class TestGetOrCreateCitationKey:
    def test_generates_a_key_for_a_document_that_has_none(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="A Study", authors=["Jane Doe"])

        record = repository.get(user_id, document_id)
        assert record is not None
        assert record.citation_key is None

        updated = repository.get_or_create_citation_key(user_id, document_id)
        assert updated is not None
        assert updated.citation_key == "Doe2020Study"

    def test_key_is_persisted_and_reused_on_second_call(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)

        first = repository.get_or_create_citation_key(user_id, document_id)
        second = repository.get_or_create_citation_key(user_id, document_id)
        assert first is not None and second is not None
        assert first.citation_key == second.citation_key

    def test_key_stable_across_a_later_metadata_edit(self, db_session: Session) -> None:
        """Section 16's core guarantee: editing the title AFTER a key has
        already been generated must never change that key."""
        repository = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id, title="Original Title")

        first = repository.get_or_create_citation_key(user_id, document_id)
        assert first is not None
        original_key = first.citation_key

        repository.update_metadata(user_id, document_id, {"title": "Completely Different Title"})
        after_edit = repository.get_or_create_citation_key(user_id, document_id)
        assert after_edit is not None
        assert after_edit.citation_key == original_key

    def test_collision_within_same_user_gets_distinct_keys(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        doc_a = _make_document(db_session, user_id, title="Study", authors=["Jane Doe"])
        doc_b = _make_document(db_session, user_id, title="Study", authors=["Jane Doe"])

        record_a = repository.get_or_create_citation_key(user_id, doc_a)
        record_b = repository.get_or_create_citation_key(user_id, doc_b)
        assert record_a is not None and record_b is not None
        assert record_a.citation_key != record_b.citation_key
        assert record_a.citation_key == "Doe2020Study"
        assert record_b.citation_key == "Doe2020Study2"

    def test_collision_scope_is_per_user_not_global(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        user_a = _make_user(db_session)
        user_b = _make_user(db_session)
        doc_a = _make_document(db_session, user_a, title="Study", authors=["Jane Doe"])
        doc_b = _make_document(db_session, user_b, title="Study", authors=["Jane Doe"])

        record_a = repository.get_or_create_citation_key(user_a, doc_a)
        record_b = repository.get_or_create_citation_key(user_b, doc_b)
        assert record_a is not None and record_b is not None
        # Two different users' documents may legitimately share the same
        # base key — collision scope never crosses ownership boundaries.
        assert record_a.citation_key == "Doe2020Study"
        assert record_b.citation_key == "Doe2020Study"

    def test_returns_none_for_missing_document(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        assert repository.get_or_create_citation_key(user_id, "nonexistent") is None

    def test_returns_none_for_another_users_document(self, db_session: Session) -> None:
        repository = DocumentsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        document_id = _make_document(db_session, owner)
        assert repository.get_or_create_citation_key(other, document_id) is None
