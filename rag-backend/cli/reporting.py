"""Shared ingestion-report data model and JSON/Markdown writers.

Reports never include extracted document text — only counts and metadata —
per milestone 8 §4 ("Do not include full copyrighted document text in logs
or reports")."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

FinalResult = Literal[
    "ingested",
    "duplicate",
    "skipped",
    "failed_validation",
    "failed_extraction",
    "failed_embedding",
    "failed_storage",
]

FAILURE_RESULTS: frozenset[FinalResult] = frozenset(
    {"failed_validation", "failed_extraction", "failed_embedding", "failed_storage"}
)


@dataclass
class DocumentReport:
    filename: str
    result: FinalResult
    duration_seconds: float
    checksum: str | None = None
    file_type: str | None = None
    character_count: int | None = None
    page_count: int | None = None
    chunk_count: int | None = None
    embedding_status: str = "not_attempted"
    upsert_status: str = "not_attempted"
    document_id: str | None = None
    detail: str | None = None

    @property
    def is_failure(self) -> bool:
        return self.result in FAILURE_RESULTS


@dataclass
class IngestionSummary:
    started_at: datetime
    finished_at: datetime
    dry_run: bool
    source_path: str
    documents: list[DocumentReport] = field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for doc in self.documents:
            counts[doc.result] = counts.get(doc.result, 0) + 1
        return counts

    @property
    def duration_seconds(self) -> float:
        return (self.finished_at - self.started_at).total_seconds()

    def to_json_dict(self) -> dict[str, object]:
        return {
            "started_at": self.started_at.isoformat(),
            "finished_at": self.finished_at.isoformat(),
            "duration_seconds": self.duration_seconds,
            "dry_run": self.dry_run,
            "source_path": self.source_path,
            "counts": self.counts,
            "documents": [asdict(doc) for doc in self.documents],
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Ingestion report — {self.started_at.isoformat()}",
            "",
            f"- Source path: `{self.source_path}`",
            f"- Dry run: {self.dry_run}",
            f"- Duration: {self.duration_seconds:.2f}s",
            f"- Documents processed: {len(self.documents)}",
            "",
            "## Summary",
            "",
            "| Result | Count |",
            "| --- | --- |",
        ]
        for result, count in sorted(self.counts.items()):
            lines.append(f"| {result} | {count} |")

        lines += [
            "",
            "## Documents",
            "",
            "| Filename | Result | Chunks | Pages | Duration (s) | Detail |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for doc in self.documents:
            detail = (doc.detail or "").replace("|", "\\|").replace("\n", " ")
            lines.append(
                f"| {doc.filename} | {doc.result} | {doc.chunk_count or ''} | "
                f"{doc.page_count or ''} | {doc.duration_seconds:.2f} | {detail} |"
            )

        failures = [doc for doc in self.documents if doc.is_failure]
        if failures:
            lines += ["", "## Failures", ""]
            for doc in failures:
                lines.append(f"- **{doc.filename}** ({doc.result}): {doc.detail or 'no detail'}")

        return "\n".join(lines) + "\n"


def write_reports(summary: IngestionSummary, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = summary.started_at.strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"ingestion-{timestamp}.json"
    md_path = reports_dir / f"ingestion-{timestamp}.md"

    json_path.write_text(json.dumps(summary.to_json_dict(), indent=2), encoding="utf-8")
    md_path.write_text(summary.to_markdown(), encoding="utf-8")

    return json_path, md_path


def utcnow() -> datetime:
    return datetime.now(UTC)
