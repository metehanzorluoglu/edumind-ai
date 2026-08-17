"""Milestone 5.1 Part 14/16 — the backend's HTTP client for the standalone
latex-compiler service (see latex-compiler/ at the repo root — a wholly
separate container, never imported directly, never reachable from the
browser). Mirrors app/core/evidence_client.py's shape exactly (injectable
HTTP client, one typed outcome that is never raised — see the note on
why below) — that module's own docstring explains the general pattern
this repeats for a second internal service.

Unlike EvidenceClient (whose failures must be completely invisible —
shadow mode), a compile failure here IS user-visible (Part 22: useful
diagnostics), so CompileClientOutcome carries enough detail for the
route to build a real error response, while still never raising for an
ordinary "the service said no/timed out/was busy" outcome — the route
layer decides HTTP status codes, this client only reports what
happened."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol

import httpx

FailureReason = Literal[
    "queue_full",
    "timeout",
    "unavailable",
    "invalid_request",
    "malformed_response",
    "unknown_error",
]


@dataclass(frozen=True)
class Diagnostic:
    severity: Literal["error", "warning"]
    message: str
    line: int | None = None
    # Milestone 5.5 Part 14 — passthrough of the compiler service's own
    # Diagnostic.file (see latex-compiler/app/log_sanitizer.py).
    file: str | None = None


@dataclass(frozen=True)
class CompileClientOutcome:
    ok: bool
    status: Literal["success", "error", "timeout"] | None = None
    diagnostics: tuple[Diagnostic, ...] = field(default_factory=tuple)
    log_excerpt: str = ""
    duration_ms: float = 0.0
    pdf_bytes: bytes | None = None
    page_count: int | None = None
    failure: FailureReason | None = None


class _HttpPoster(Protocol):
    def post(
        self, url: str, *, json: Mapping[str, object], timeout: float
    ) -> httpx.Response: ...


class LatexCompilerClient:
    """One instance per process (see app/deps.py::get_latex_compiler_client),
    matching EvidenceClient/OllamaLLMProvider's convention."""

    def __init__(
        self,
        *,
        base_url: str,
        timeout_seconds: float = 50.0,
        client: _HttpPoster | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds
        self._client: _HttpPoster = (
            client if client is not None else httpx.Client(timeout=timeout_seconds)
        )

    def compile(
        self,
        *,
        job_id: str,
        main_tex: str,
        references_bib: str,
        extra_files: "Mapping[str, bytes] | None" = None,
    ) -> CompileClientOutcome:
        """Never raises: every failure mode (connection refused, timeout,
        4xx/5xx, malformed JSON) is caught and returned as
        CompileClientOutcome(ok=False, failure=...).

        Milestone 5.3 Part 17 — `extra_files` (relative path -> raw
        bytes) is base64-encoded here before it ever goes over the wire
        — the compiler service's CompileRequest.extra_files field is
        `dict[str, str]` (see latex-compiler/app/schemas.py's own
        docstring for why this single encoding is used regardless of
        whether the underlying file is text or binary)."""
        import base64

        encoded_extra_files = {
            path: base64.b64encode(data).decode("ascii") for path, data in (extra_files or {}).items()
        }
        payload = {
            "job_id": job_id,
            "main_tex": main_tex,
            "references_bib": references_bib,
            "extra_files": encoded_extra_files,
        }
        try:
            response = self._client.post(
                f"{self._base_url}/compile", json=payload, timeout=self._timeout_seconds
            )
        except httpx.TimeoutException:
            return CompileClientOutcome(ok=False, failure="timeout")
        except httpx.ConnectError:
            return CompileClientOutcome(ok=False, failure="unavailable")
        except httpx.HTTPError:
            return CompileClientOutcome(ok=False, failure="unknown_error")

        if response.status_code == 503:
            return CompileClientOutcome(ok=False, failure="queue_full")
        if response.status_code == 400:
            return CompileClientOutcome(ok=False, failure="invalid_request")
        if response.status_code != 200:
            return CompileClientOutcome(ok=False, failure="unknown_error")

        try:
            body = response.json()
            diagnostics = tuple(
                Diagnostic(
                    severity=item["severity"],
                    message=item["message"],
                    line=item.get("line"),
                    file=item.get("file"),
                )
                for item in body.get("diagnostics", [])
            )
            pdf_bytes = None
            if body.get("pdf_base64"):
                import base64

                pdf_bytes = base64.b64decode(body["pdf_base64"])
            return CompileClientOutcome(
                ok=True,
                status=body["status"],
                diagnostics=diagnostics,
                log_excerpt=body.get("log_excerpt", ""),
                duration_ms=body.get("duration_ms", 0.0),
                pdf_bytes=pdf_bytes,
                page_count=body.get("page_count"),
            )
        except (KeyError, ValueError, TypeError):
            return CompileClientOutcome(ok=False, failure="malformed_response")
