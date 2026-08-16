"""Milestone 5 (Academic Writing & LaTeX Foundation) — tests for
WritingProjectsRepository. Same "real repository against a temp on-disk
SQLite DB" convention as test_documents_repository_citation_key.py."""

from __future__ import annotations

import os
import tempfile
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.document_deletion import delete_document_by_id
from app.db.base import Base
from app.db.document_highlights_repository import DocumentHighlightsRepository
from app.db.documents_repository import DocumentsRepository
from app.db.models_auth import User
from app.db.scopes_repository import ScopesRepository
from app.db.writing_projects_repository import WritingProjectsRepository
from app.ingestion.metadata_schema import DocumentMetadata


class _FakeVectorStore:
    """A minimal stand-in for QdrantVectorStore — delete_document_by_id
    only calls delete_document, and this test never ingests real chunks,
    so a no-op counter is sufficient (same minimal-fake convention as
    test_routes_folders.py's own fake)."""

    def delete_document(self, document_id: str, *, user_id: str) -> int:
        return 0


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


def _make_document(db_session: Session, user_id: uuid.UUID, *, title: str = "A Study") -> str:
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
        authors=["Jane Doe"],
        ingested_at=datetime.now(UTC),
    )
    repository.create(user_id=user_id, metadata=metadata, chunk_count=3)
    return document_id


class TestCreateGetUpdateDelete:
    def test_create_and_get(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        record = repo.create(
            user_id=user_id, title="My Paper", description="A draft", main_tex_content="\\tex"
        )
        fetched = repo.get(user_id, record.id)
        assert fetched is not None
        assert fetched.title == "My Paper"
        assert fetched.main_tex_content == "\\tex"

    def test_get_returns_none_for_nonexistent(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        assert repo.get(user_id, uuid.uuid4()) is None

    def test_get_returns_none_for_another_users_project(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        record = repo.create(user_id=owner, title="P", description=None, main_tex_content="x")
        assert repo.get(other, record.id) is None

    def test_list_for_user_orders_most_recently_updated_first(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        first = repo.create(user_id=user_id, title="First", description=None, main_tex_content="x")
        repo.create(user_id=user_id, title="Second", description=None, main_tex_content="x")
        repo.update(user_id, first.id, {"title": "First (edited)"})
        summaries = repo.list_for_user(user_id)
        assert summaries[0].title == "First (edited)"

    def test_list_for_user_never_includes_another_users_projects(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        repo.create(user_id=owner, title="Owner's", description=None, main_tex_content="x")
        assert repo.list_for_user(other) == []

    def test_update_only_touches_fields_present(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        record = repo.create(
            user_id=user_id, title="Original", description="desc", main_tex_content="x"
        )
        updated = repo.update(user_id, record.id, {"main_tex_content": "\\new"})
        assert updated is not None
        assert updated.title == "Original"
        assert updated.description == "desc"
        assert updated.main_tex_content == "\\new"

    def test_update_returns_none_for_another_users_project(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        record = repo.create(user_id=owner, title="P", description=None, main_tex_content="x")
        assert repo.update(other, record.id, {"title": "Hijacked"}) is None

    def test_delete_removes_project(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        record = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        assert repo.delete(user_id, record.id) is True
        assert repo.get(user_id, record.id) is None

    def test_delete_removes_its_own_reference_associations(self, db_session: Session) -> None:
        """No ORM relationship() cascade is defined between WritingProject
        and WritingProjectDocument, and SQLite does not enforce declared
        FK ondelete actions in this app — without WritingProjectsRepository
        .delete()'s own explicit cleanup, this would leave an orphaned
        writing_project_documents row pointing at a deleted project_id."""
        from app.db.models_writing import WritingProjectDocument

        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        record = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        repo.add_reference(user_id, record.id, document_id)

        assert repo.delete(user_id, record.id) is True

        leftover = db_session.query(WritingProjectDocument).filter_by(
            writing_project_id=record.id
        ).all()
        assert leftover == []

    def test_delete_returns_false_for_another_users_project(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        record = repo.create(user_id=owner, title="P", description=None, main_tex_content="x")
        assert repo.delete(other, record.id) is False
        assert repo.get(owner, record.id) is not None


class TestReferences:
    def test_add_reference_success(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        outcome = repo.add_reference(user_id, project.id, document_id)
        assert outcome == "added"
        refs = repo.list_references(user_id, project.id)
        assert refs is not None
        assert len(refs) == 1
        assert refs[0].document_id == document_id

    def test_add_reference_is_idempotent(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        repo.add_reference(user_id, project.id, document_id)
        outcome = repo.add_reference(user_id, project.id, document_id)
        assert outcome == "already_present"
        refs = repo.list_references(user_id, project.id)
        assert refs is not None
        assert len(refs) == 1

    def test_add_reference_reports_project_not_found(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        document_id = _make_document(db_session, user_id)
        outcome = repo.add_reference(user_id, uuid.uuid4(), document_id)
        assert outcome == "project_not_found"

    def test_add_reference_rejects_another_users_document(self, db_session: Session) -> None:
        """Milestone 5 Section 37 — a guessed document_id belonging to
        another user must never be addable, and the outcome must not
        reveal whether that id exists at all."""
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        attacker = _make_user(db_session)
        project = repo.create(user_id=attacker, title="P", description=None, main_tex_content="x")
        owners_document = _make_document(db_session, owner)
        outcome = repo.add_reference(attacker, project.id, owners_document)
        assert outcome == "document_not_found"
        refs = repo.list_references(attacker, project.id)
        assert refs == []

    def test_add_reference_indistinguishable_for_truly_missing_document(
        self, db_session: Session
    ) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        outcome = repo.add_reference(user_id, project.id, "nonexistent-document-id")
        assert outcome == "document_not_found"

    def test_add_reference_respects_limit(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import app.db.writing_projects_repository as module

        monkeypatch.setattr(module, "MAX_REFERENCES_PER_PROJECT", 1)
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        doc_a = _make_document(db_session, user_id, title="A")
        doc_b = _make_document(db_session, user_id, title="B")
        assert repo.add_reference(user_id, project.id, doc_a) == "added"
        assert repo.add_reference(user_id, project.id, doc_b) == "limit_reached"

    def test_remove_reference_deletes_only_the_association(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        repo.add_reference(user_id, project.id, document_id)

        assert repo.remove_reference(user_id, project.id, document_id) is True

        refs = repo.list_references(user_id, project.id)
        assert refs == []
        # The Document itself must still exist — only the association was removed.
        documents_repo = DocumentsRepository(db_session)
        assert documents_repo.get(user_id, document_id) is not None

    def test_remove_reference_returns_false_when_not_present(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(user_id=user_id, title="P", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        assert repo.remove_reference(user_id, project.id, document_id) is False

    def test_document_can_belong_to_multiple_projects(self, db_session: Session) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        project_a = repo.create(user_id=user_id, title="A", description=None, main_tex_content="x")
        project_b = repo.create(user_id=user_id, title="B", description=None, main_tex_content="x")
        document_id = _make_document(db_session, user_id)
        assert repo.add_reference(user_id, project_a.id, document_id) == "added"
        assert repo.add_reference(user_id, project_b.id, document_id) == "added"
        assert len(repo.list_references(user_id, project_a.id) or []) == 1
        assert len(repo.list_references(user_id, project_b.id) or []) == 1

    def test_deleting_document_removes_reference_but_not_the_project(
        self, db_session: Session
    ) -> None:
        """Milestone 5 Section 29 — deleting a referenced Document must
        never cascade-delete the WritingProject; the manuscript source
        must survive untouched.

        Exercises the real app.core.document_deletion.delete_document_by_id
        service, not DocumentsRepository.delete() directly — SQLite never
        enforces the declared FK ondelete=CASCADE in this app (see
        WritingProjectsRepository.delete_references_for_document's
        docstring), so the association cleanup only happens via that
        service's explicit call. Calling repo.delete() directly here would
        prove nothing about the real deletion path used by the API/CLI."""
        repo = WritingProjectsRepository(db_session)
        documents_repo = DocumentsRepository(db_session)
        user_id = _make_user(db_session)
        project = repo.create(
            user_id=user_id,
            title="P",
            description=None,
            main_tex_content="\\cite{SomeKey}",
        )
        document_id = _make_document(db_session, user_id)
        repo.add_reference(user_id, project.id, document_id)

        result = delete_document_by_id(
            document_id,
            user_id=user_id,
            vector_store=_FakeVectorStore(),  # type: ignore[arg-type]
            documents_repository=documents_repo,
            scopes_repository=ScopesRepository(db_session),
            document_highlights_repository=DocumentHighlightsRepository(db_session),
            writing_projects_repository=repo,
        )
        assert result is not None

        # The project itself and its exact manuscript source survive.
        survivor = repo.get(user_id, project.id)
        assert survivor is not None
        assert survivor.main_tex_content == "\\cite{SomeKey}"
        # The reference association is gone (explicit cleanup, not FK cascade).
        refs = repo.list_references(user_id, project.id)
        assert refs == []

    def test_list_references_returns_none_for_nonexistent_project(
        self, db_session: Session
    ) -> None:
        repo = WritingProjectsRepository(db_session)
        user_id = _make_user(db_session)
        assert repo.list_references(user_id, uuid.uuid4()) is None

    def test_list_references_returns_none_for_another_users_project(
        self, db_session: Session
    ) -> None:
        repo = WritingProjectsRepository(db_session)
        owner = _make_user(db_session)
        other = _make_user(db_session)
        project = repo.create(user_id=owner, title="P", description=None, main_tex_content="x")
        assert repo.list_references(other, project.id) is None
