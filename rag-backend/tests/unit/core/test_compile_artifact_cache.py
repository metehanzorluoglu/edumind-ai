import time
import uuid

from app.core.compile_artifact_cache import CompileArtifactCache


def test_store_and_get_roundtrip():
    cache = CompileArtifactCache(ttl_seconds=60)
    user_id, project_id = uuid.uuid4(), uuid.uuid4()
    compile_id = cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"%PDF-1")
    assert cache.get(user_id=user_id, project_id=project_id, compile_id=compile_id) == b"%PDF-1"


def test_get_returns_none_for_unknown_compile_id():
    cache = CompileArtifactCache(ttl_seconds=60)
    assert cache.get(user_id=uuid.uuid4(), project_id=uuid.uuid4(), compile_id="nope") is None


def test_get_returns_none_for_wrong_user_ownership():
    cache = CompileArtifactCache(ttl_seconds=60)
    project_id = uuid.uuid4()
    compile_id = cache.store(user_id=uuid.uuid4(), project_id=project_id, pdf_bytes=b"%PDF")
    wrong_user = uuid.uuid4()
    assert cache.get(user_id=wrong_user, project_id=project_id, compile_id=compile_id) is None


def test_get_returns_none_for_wrong_project():
    cache = CompileArtifactCache(ttl_seconds=60)
    user_id = uuid.uuid4()
    compile_id = cache.store(user_id=user_id, project_id=uuid.uuid4(), pdf_bytes=b"%PDF")
    wrong_project = uuid.uuid4()
    assert cache.get(user_id=user_id, project_id=wrong_project, compile_id=compile_id) is None


def test_entry_expires_after_ttl():
    cache = CompileArtifactCache(ttl_seconds=0.05)
    user_id, project_id = uuid.uuid4(), uuid.uuid4()
    compile_id = cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"%PDF")
    time.sleep(0.1)
    assert cache.get(user_id=user_id, project_id=project_id, compile_id=compile_id) is None


def test_evicts_oldest_when_over_capacity():
    cache = CompileArtifactCache(ttl_seconds=600, max_entries=2)
    user_id, project_id = uuid.uuid4(), uuid.uuid4()
    id1 = cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"1")
    time.sleep(0.01)
    id2 = cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"2")
    time.sleep(0.01)
    id3 = cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"3")

    # Oldest (id1) evicted; the two most recent survive.
    assert cache.get(user_id=user_id, project_id=project_id, compile_id=id1) is None
    assert cache.get(user_id=user_id, project_id=project_id, compile_id=id2) == b"2"
    assert cache.get(user_id=user_id, project_id=project_id, compile_id=id3) == b"3"


def test_each_store_returns_a_unique_id():
    cache = CompileArtifactCache(ttl_seconds=60)
    user_id, project_id = uuid.uuid4(), uuid.uuid4()
    ids = {
        cache.store(user_id=user_id, project_id=project_id, pdf_bytes=b"x") for _ in range(20)
    }
    assert len(ids) == 20
