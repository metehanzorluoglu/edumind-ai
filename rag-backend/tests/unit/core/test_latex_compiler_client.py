"""Milestone 5.1 Part 14 — tests for app/core/latex_compiler_client.py.
Same fake-HttpPoster convention as tests/unit/core/test_evidence_client.py
— no real network call."""

from __future__ import annotations

import base64

import httpx

from app.core.latex_compiler_client import LatexCompilerClient


class _FakeHttpPoster:
    def __init__(self, *, response: httpx.Response | None = None, raises: Exception | None = None):
        self._response = response
        self._raises = raises
        self.calls: list[dict[str, object]] = []

    def post(self, url: str, *, json, timeout: float) -> httpx.Response:
        self.calls.append({"url": url, "json": json, "timeout": timeout})
        if self._raises is not None:
            raise self._raises
        assert self._response is not None
        return self._response


def _ok_response(**overrides) -> httpx.Response:
    body = {
        "status": "success",
        "diagnostics": [],
        "log_excerpt": "clean",
        "duration_ms": 123.4,
        "pdf_base64": base64.b64encode(b"%PDF-fake").decode("ascii"),
        "pdf_size_bytes": len(b"%PDF-fake"),
        "page_count": 1,
    }
    body.update(overrides)
    return httpx.Response(200, json=body)


class TestSuccess:
    def test_successful_compile_decodes_pdf_bytes(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = LatexCompilerClient(base_url="http://latex-compiler:8200", client=fake)
        outcome = client.compile(job_id="j1", main_tex="tex", references_bib="bib")
        assert outcome.ok is True
        assert outcome.status == "success"
        assert outcome.pdf_bytes == b"%PDF-fake"
        assert outcome.duration_ms == 123.4
        assert outcome.page_count == 1

    def test_request_body_shape(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = LatexCompilerClient(base_url="http://latex-compiler:8200", client=fake)
        client.compile(job_id="j1", main_tex="\\section{A}", references_bib="@article{X}")
        assert fake.calls[0]["url"] == "http://latex-compiler:8200/compile"
        assert fake.calls[0]["json"] == {
            "job_id": "j1",
            "main_tex": "\\section{A}",
            "references_bib": "@article{X}",
            # Milestone 5.3 Part 17 — always present, base64-encoded,
            # empty when no extra_files are passed (see compile()'s own
            # docstring for why this single encoding is used).
            "extra_files": {},
        }

    def test_error_status_has_diagnostics_no_pdf(self) -> None:
        fake = _FakeHttpPoster(
            response=_ok_response(
                status="error",
                pdf_base64=None,
                diagnostics=[
                    {"severity": "error", "message": "Undefined control sequence", "line": 5}
                ],
            )
        )
        client = LatexCompilerClient(base_url="http://latex-compiler:8200", client=fake)
        outcome = client.compile(job_id="j2", main_tex="bad", references_bib="")
        assert outcome.ok is True
        assert outcome.status == "error"
        assert outcome.pdf_bytes is None
        assert len(outcome.diagnostics) == 1
        assert outcome.diagnostics[0].line == 5

    def test_base_url_trailing_slash_stripped(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = LatexCompilerClient(base_url="http://latex-compiler:8200/", client=fake)
        client.compile(job_id="j1", main_tex="x", references_bib="")
        assert fake.calls[0]["url"] == "http://latex-compiler:8200/compile"

    def test_synctex_bytes_decoded_when_present(self) -> None:
        fake = _FakeHttpPoster(
            response=_ok_response(synctex_base64=base64.b64encode(b"fake-synctex").decode("ascii"))
        )
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j1", main_tex="x", references_bib="")
        assert outcome.synctex_bytes == b"fake-synctex"

    def test_synctex_bytes_none_when_absent(self) -> None:
        fake = _FakeHttpPoster(response=_ok_response())
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j1", main_tex="x", references_bib="")
        assert outcome.synctex_bytes is None


class TestFailureMapping:
    def test_503_maps_to_queue_full(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(503, json={"error": "queue_full"}))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "queue_full"

    def test_400_maps_to_invalid_request(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(400, json={"error": "main_tex_too_large"}))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "invalid_request"

    def test_unexpected_status_maps_to_unknown_error(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(500, json={}))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "unknown_error"

    def test_timeout_exception_maps_to_timeout_failure(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.TimeoutException("slow"))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "timeout"

    def test_connect_error_maps_to_unavailable(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.ConnectError("refused"))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "unavailable"

    def test_malformed_json_body_maps_to_malformed_response(self) -> None:
        # Missing required fields the client's parser expects to be
        # present in a well-formed body is fine (they have defaults) —
        # this specifically breaks on a body that's valid JSON but not
        # the expected shape (e.g. diagnostics entries missing "message").
        fake2 = _FakeHttpPoster(
            response=httpx.Response(
                200, json={"status": "success", "diagnostics": [{"severity": "error"}]}
            )
        )
        client = LatexCompilerClient(base_url="http://x", client=fake2)
        outcome = client.compile(job_id="j", main_tex="x", references_bib="")
        assert outcome.ok is False
        assert outcome.failure == "malformed_response"

    def test_never_raises_on_any_failure_mode(self) -> None:
        for exc in (httpx.TimeoutException("x"), httpx.ConnectError("x"), httpx.HTTPError("x")):
            fake = _FakeHttpPoster(raises=exc)
            client = LatexCompilerClient(base_url="http://x", client=fake)
            outcome = client.compile(job_id="j", main_tex="x", references_bib="")
            assert outcome.ok is False


class TestInverseSearch:
    def test_resolved_result_decoded(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(200, json={"resolved": True, "file": "main.tex", "line": 4})
        )
        client = LatexCompilerClient(base_url="http://latex-compiler:8200", client=fake)
        outcome = client.inverse_search(synctex_bytes=b"fake", page=1, x=10.0, y=20.0)
        assert outcome.ok is True
        assert outcome.resolved is True
        assert outcome.file == "main.tex"
        assert outcome.line == 4
        assert fake.calls[0]["url"] == "http://latex-compiler:8200/inverse-search"
        assert fake.calls[0]["json"] == {
            "synctex_base64": base64.b64encode(b"fake").decode("ascii"),
            "page": 1,
            "x": 10.0,
            "y": 20.0,
        }

    def test_unresolved_result_decoded(self) -> None:
        fake = _FakeHttpPoster(
            response=httpx.Response(200, json={"resolved": False, "file": None, "line": None})
        )
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.inverse_search(synctex_bytes=b"fake", page=1, x=0.0, y=0.0)
        assert outcome.ok is True
        assert outcome.resolved is False
        assert outcome.file is None
        assert outcome.line is None

    def test_503_maps_to_queue_full(self) -> None:
        fake = _FakeHttpPoster(response=httpx.Response(503, json={"error": "queue_full"}))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.inverse_search(synctex_bytes=b"fake", page=1, x=0.0, y=0.0)
        assert outcome.ok is False
        assert outcome.failure == "queue_full"

    def test_timeout_exception_maps_to_timeout_failure(self) -> None:
        fake = _FakeHttpPoster(raises=httpx.TimeoutException("slow"))
        client = LatexCompilerClient(base_url="http://x", client=fake)
        outcome = client.inverse_search(synctex_bytes=b"fake", page=1, x=0.0, y=0.0)
        assert outcome.ok is False
        assert outcome.failure == "timeout"

    def test_never_raises_on_any_failure_mode(self) -> None:
        for exc in (httpx.TimeoutException("x"), httpx.ConnectError("x"), httpx.HTTPError("x")):
            fake = _FakeHttpPoster(raises=exc)
            client = LatexCompilerClient(base_url="http://x", client=fake)
            outcome = client.inverse_search(synctex_bytes=b"fake", page=1, x=0.0, y=0.0)
            assert outcome.ok is False
