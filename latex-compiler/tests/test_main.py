"""Milestone 5.1 Part 50 — FastAPI request/response cycle tests using an
injected fake `compile_fn` (see app/main.py's `create_app(compile_fn=...)`
seam) — never spawns pdflatex, so this suite runs in any Python
environment, matching evidence-service/tests' identical seam pattern."""

import base64

import pytest
from fastapi.testclient import TestClient

from app.compiler import CompileOutcome, InverseSearchOutcome
from app.concurrency import JobTimeoutError, QueueFullError
from app.config import Settings
from app.main import create_app
from app.schemas import Diagnostic


def make_client(
    compile_fn=None, *, settings: Settings | None = None, inverse_search_fn=None
) -> TestClient:
    async def _default_compile_fn(**kwargs):
        raise AssertionError("compile_fn not configured for this test")

    app = create_app(
        settings=settings or Settings(),
        compile_fn=compile_fn or _default_compile_fn,
        inverse_search_fn=inverse_search_fn,
    )
    return TestClient(app)


def test_health_endpoint_always_200():
    async def never_called(**kwargs):
        raise AssertionError("should not be called")

    client = make_client(never_called)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_successful_compile_returns_pdf_base64():
    async def fake_compile(*, main_tex, references_bib, settings, extra_files=None):
        return CompileOutcome(status="success", pdf_bytes=b"%PDF-fake", duration_ms=123.4)

    client = make_client(fake_compile)
    resp = client.post(
        "/compile", json={"job_id": "j1", "main_tex": "\\documentclass{article}", "references_bib": ""}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"
    assert body["pdf_base64"] is not None
    assert body["pdf_size_bytes"] == len(b"%PDF-fake")


def test_compile_error_returns_diagnostics():
    async def fake_compile(*, main_tex, references_bib, settings, extra_files=None):
        return CompileOutcome(
            status="error",
            diagnostics=[Diagnostic(severity="error", message="Undefined control sequence")],
        )

    client = make_client(fake_compile)
    resp = client.post(
        "/compile", json={"job_id": "j2", "main_tex": "bad", "references_bib": ""}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "error"
    assert body["pdf_base64"] is None
    assert len(body["diagnostics"]) == 1


def test_main_tex_too_large_rejected_with_400():
    async def never_called(**kwargs):
        raise AssertionError("should not reach the executor")

    settings = Settings(max_main_tex_bytes=10)
    client = make_client(never_called, settings=settings)
    resp = client.post(
        "/compile",
        json={"job_id": "j3", "main_tex": "x" * 100, "references_bib": ""},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "main_tex_too_large"


def test_references_bib_too_large_rejected_with_400():
    async def never_called(**kwargs):
        raise AssertionError("should not reach the executor")

    settings = Settings(max_references_bib_bytes=10)
    client = make_client(never_called, settings=settings)
    resp = client.post(
        "/compile",
        json={"job_id": "j4", "main_tex": "ok", "references_bib": "x" * 100},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "references_bib_too_large"


def test_queue_full_maps_to_503():
    async def fake_compile(*, main_tex, references_bib, settings, extra_files=None):
        raise QueueFullError("full")

    # The executor itself is real (BoundedJobExecutor); to force a
    # QueueFullError deterministically we monkeypatch the executor's
    # `run` method directly rather than racing real concurrency.
    app_settings = Settings()
    client = make_client(fake_compile, settings=app_settings)

    async def raise_queue_full(fn, *, timeout_seconds):
        raise QueueFullError("queue full: 4 already waiting")

    client.app.state.compiler.executor.run = raise_queue_full  # type: ignore[method-assign]

    resp = client.post(
        "/compile", json={"job_id": "j5", "main_tex": "ok", "references_bib": ""}
    )
    assert resp.status_code == 503
    assert resp.json()["error"] == "queue_full"


def test_job_timeout_maps_to_200_with_timeout_status():
    async def fake_compile(*, main_tex, references_bib, settings, extra_files=None):
        raise JobTimeoutError("too slow")

    client = make_client(fake_compile)

    async def raise_timeout(fn, *, timeout_seconds):
        raise JobTimeoutError("job exceeded budget")

    client.app.state.compiler.executor.run = raise_timeout  # type: ignore[method-assign]

    resp = client.post(
        "/compile", json={"job_id": "j6", "main_tex": "ok", "references_bib": ""}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "timeout"
    assert body["pdf_base64"] is None


def test_job_id_required():
    async def never_called(**kwargs):
        raise AssertionError("should not be called")

    client = make_client(never_called)
    resp = client.post("/compile", json={"job_id": "", "main_tex": "ok", "references_bib": ""})
    assert resp.status_code == 422  # pydantic min_length=1 validation


# --- SyncTeX implementation: /inverse-search ------------------------------


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def test_inverse_search_resolves_to_source_relative_file_and_line():
    async def fake_inverse_search(*, synctex_bytes, page, x, y, settings):
        assert synctex_bytes == b"fake-synctex-bytes"
        assert page == 1
        assert x == 100.0
        assert y == 150.0
        return InverseSearchOutcome(resolved=True, file="sections/intro.tex", line=4)

    client = make_client(inverse_search_fn=fake_inverse_search)
    resp = client.post(
        "/inverse-search",
        json={
            "synctex_base64": _b64(b"fake-synctex-bytes"),
            "page": 1,
            "x": 100.0,
            "y": 150.0,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"resolved": True, "file": "sections/intro.tex", "line": 4}


def test_inverse_search_declines_rather_than_guesses():
    async def fake_inverse_search(*, synctex_bytes, page, x, y, settings):
        return InverseSearchOutcome(resolved=False)

    client = make_client(inverse_search_fn=fake_inverse_search)
    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": _b64(b"x"), "page": 1, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 200
    assert resp.json() == {"resolved": False, "file": None, "line": None}


def test_inverse_search_rejects_invalid_base64_with_400():
    client = make_client()
    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": "not-valid-base64!!!", "page": 1, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "invalid_synctex_encoding"


def test_inverse_search_rejects_oversized_synctex_with_400():
    settings = Settings(max_synctex_bytes=10)
    client = make_client(settings=settings)
    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": _b64(b"x" * 1000), "page": 1, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 400
    assert resp.json()["error"] == "synctex_too_large"


def test_inverse_search_rejects_non_positive_page_with_422():
    client = make_client()
    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": _b64(b"x"), "page": 0, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 422  # pydantic ge=1 validation


def test_inverse_search_queue_full_maps_to_503():
    client = make_client(inverse_search_fn=lambda **kwargs: None)

    async def raise_queue_full(fn, *, timeout_seconds):
        raise QueueFullError("queue full: 4 already waiting")

    client.app.state.compiler.executor.run = raise_queue_full  # type: ignore[method-assign]

    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": _b64(b"x"), "page": 1, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 503
    assert resp.json()["error"] == "queue_full"


def test_inverse_search_timeout_declines_rather_than_5xx():
    client = make_client(inverse_search_fn=lambda **kwargs: None)

    async def raise_timeout(fn, *, timeout_seconds):
        raise JobTimeoutError("job exceeded budget")

    client.app.state.compiler.executor.run = raise_timeout  # type: ignore[method-assign]

    resp = client.post(
        "/inverse-search",
        json={"synctex_base64": _b64(b"x"), "page": 1, "x": 0.0, "y": 0.0},
    )
    assert resp.status_code == 200
    assert resp.json() == {"resolved": False, "file": None, "line": None}
