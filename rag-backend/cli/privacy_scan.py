"""Local-only privacy / corpus-safety scanner (milestone 8 §14).

Usage:
    python -m cli.privacy_scan --path data/raw

Scans plain-text-readable files under --path for patterns that MIGHT
indicate sensitive content (emails, SSN-shaped numbers, phone numbers,
credential/API-key-shaped strings, private-key blocks, and known
prompt-injection / hidden-instruction phrasing). It never sends anything
anywhere — everything happens in-process, no network calls — and it never
deletes, modifies, or redacts source files. Findings are for HUMAN REVIEW
ONLY.

Matched values are masked in every report (only a few characters shown)
so the report itself never becomes a second copy of the sensitive data.

IMPORTANT — what this tool cannot do:
Pattern matching cannot reliably detect private interview transcripts,
unpublished confidential documents, or copyrighted material used without
lawful access — those require a human who knows the corpus's provenance,
not a text pattern. A clean scan is NOT proof of de-identification or
copyright clearance. Student-ID detection here is a narrow heuristic
(a number near words like "student id"/"student #") and will miss
district-specific ID formats it wasn't written for — treat every scan as
a floor, not a guarantee.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

from cli.reporting import utcnow

TEXT_LIKE_EXTENSIONS = frozenset({".txt", ".md", ".markdown", ".html", ".htm"})
# .pdf/.docx are intentionally excluded: extracting them requires the same
# heavyweight loaders as ingestion, which is more machinery than a "scan
# before you commit to ingesting" tool should need. Scan the source text
# files you're about to hand to --metadata, not compiled binaries.

_EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_SSN_PATTERN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_PHONE_PATTERN = re.compile(r"\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")
_PRIVATE_KEY_PATTERN = re.compile(r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")
_AWS_KEY_PATTERN = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
_GENERIC_CREDENTIAL_PATTERN = re.compile(
    r"\b(api[_-]?key|secret|password|token|access[_-]?key)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-/+]{12,}",
    re.IGNORECASE,
)
_BEARER_TOKEN_PATTERN = re.compile(r"\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*")
_STUDENT_ID_PATTERN = re.compile(r"\bstudent\s*(id|#|number)\b\D{0,10}(\d{4,12})", re.IGNORECASE)

_PROMPT_INJECTION_PHRASES = [
    "ignore all previous instructions",
    "ignore previous instructions",
    "ignore all prior instructions",
    "disregard the above",
    "disregard previous instructions",
    "disregard all previous instructions",
    "system override",
    "you are no longer bound by",
    "reveal your system prompt",
    "reveal the system prompt",
    "reveal the full text of your system prompt",
    "do not mention this instruction",
    "this instruction takes precedence",
    "new instructions:",
    "jailbreak",
]

CATEGORY_DESCRIPTIONS = {
    "email_address": "Email address",
    "possible_ssn": "SSN-shaped number (###-##-####)",
    "possible_phone_number": "Phone-number-shaped sequence",
    "possible_private_key_block": "PEM private-key header",
    "possible_credential": "API-key/secret/password/token-shaped string",
    "possible_student_id": 'Number near "student id"/"student #"',
    "possible_prompt_injection": "Known hidden-instruction / prompt-injection phrasing",
}


@dataclass
class Finding:
    file: str
    line_number: int
    category: str
    masked_match: str


@dataclass
class ScanReport:
    generated_at: str
    scanned_path: str
    files_scanned: int
    findings: list[Finding] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at,
            "scanned_path": self.scanned_path,
            "files_scanned": self.files_scanned,
            "finding_count": len(self.findings),
            "findings": [asdict(f) for f in self.findings],
            "disclaimer": (
                "Pattern matching only. Does not guarantee de-identification or copyright "
                "clearance. Cannot detect private interview transcripts, unpublished "
                "confidential documents, or unlawfully-used copyrighted material — those "
                "require human review of the corpus's provenance."
            ),
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Privacy / corpus-safety scan — {self.generated_at}",
            "",
            f"- Scanned path: `{self.scanned_path}`",
            f"- Files scanned: {self.files_scanned}",
            f"- Findings: {len(self.findings)}",
            "",
            "**This is pattern matching only — it does not guarantee de-identification or "
            "copyright clearance, and it cannot detect private interview transcripts, "
            "unpublished confidential documents, or unlawfully-used copyrighted material. "
            "Those require a human who knows the corpus's provenance. Review every finding "
            "below yourself; nothing was deleted or modified.**",
            "",
        ]
        if not self.findings:
            lines.append(
                "No pattern matches found. This does NOT mean the corpus is safe to "
                "ingest — see the categories above that this tool cannot check."
            )
            return "\n".join(lines) + "\n"

        lines += ["| File | Line | Category | Masked match |", "| --- | --- | --- | --- |"]
        for f in self.findings:
            description = CATEGORY_DESCRIPTIONS.get(f.category, f.category)
            lines.append(f"| {f.file} | {f.line_number} | {description} | `{f.masked_match}` |")

        return "\n".join(lines) + "\n"


def _mask(value: str) -> str:
    value = value.strip()
    if len(value) <= 6:
        return "*" * len(value)
    return f"{value[:3]}…{value[-2:]} ({len(value)} chars)"


def scan_text(text: str, *, filename: str) -> list[Finding]:
    findings: list[Finding] = []

    for line_number, line in enumerate(text.splitlines(), start=1):
        for match in _EMAIL_PATTERN.finditer(line):
            findings.append(Finding(filename, line_number, "email_address", _mask(match.group())))
        for match in _SSN_PATTERN.finditer(line):
            findings.append(Finding(filename, line_number, "possible_ssn", _mask(match.group())))
        for match in _PHONE_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_phone_number", _mask(match.group()))
            )
        for match in _PRIVATE_KEY_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_private_key_block", _mask(match.group()))
            )
        for match in _AWS_KEY_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_credential", _mask(match.group()))
            )
        for match in _GENERIC_CREDENTIAL_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_credential", _mask(match.group()))
            )
        for match in _BEARER_TOKEN_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_credential", _mask(match.group()))
            )
        for match in _STUDENT_ID_PATTERN.finditer(line):
            findings.append(
                Finding(filename, line_number, "possible_student_id", _mask(match.group()))
            )
        lower_line = line.lower()
        for phrase in _PROMPT_INJECTION_PHRASES:
            if phrase in lower_line:
                findings.append(
                    Finding(filename, line_number, "possible_prompt_injection", _mask(phrase))
                )

    return findings


def discover_scannable_files(path: Path, *, recursive: bool) -> list[Path]:
    if path.is_file():
        return [path]
    pattern = "**/*" if recursive else "*"
    return sorted(
        p
        for p in path.glob(pattern)
        if p.is_file() and p.suffix.lower() in TEXT_LIKE_EXTENSIONS and not p.name.startswith(".")
    )


def run_scan(path: Path, *, recursive: bool) -> ScanReport:
    files = discover_scannable_files(path, recursive=recursive)
    report = ScanReport(
        generated_at=utcnow().isoformat(), scanned_path=str(path), files_scanned=len(files)
    )
    for file_path in files:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        report.findings.extend(scan_text(text, filename=file_path.name))
    return report


def write_report(report: ScanReport, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    json_path = reports_dir / f"privacy-scan-{timestamp}.json"
    md_path = reports_dir / f"privacy-scan-{timestamp}.md"
    json_path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    md_path.write_text(report.to_markdown(), encoding="utf-8")
    return json_path, md_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m cli.privacy_scan",
        description="Local-only pattern scan for possible sensitive content. Never deletes or "
        "modifies files; never sends data anywhere.",
    )
    parser.add_argument("--path", required=True, help="A file or directory to scan.")
    parser.add_argument("--recursive", action="store_true")
    parser.add_argument("--reports-dir", default="data/reports")
    args = parser.parse_args(argv)

    path = Path(args.path)
    if not path.exists():
        print(f"No such file or directory: {path}", file=sys.stderr)
        return 1

    report = run_scan(path, recursive=args.recursive)
    json_path, md_path = write_report(report, Path(args.reports_dir))

    print(f"Scanned {report.files_scanned} file(s), {len(report.findings)} finding(s).")
    print(f"Reports written: {json_path}, {md_path}")
    print(
        "\nReminder: pattern matching only — does not guarantee de-identification or "
        "copyright clearance, and cannot detect private interview transcripts, unpublished "
        "confidential documents, or unlawfully-used copyrighted material. Review findings "
        "yourself; nothing was changed."
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
