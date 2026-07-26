import re
from pathlib import Path

from app.ingestion.errors import DocumentExtractionError
from app.ingestion.loaders.base import (
    ExtractedMetadata,
    ExtractionSource,
    LoadedDocument,
    PageContent,
)

_CODE_FENCE_RE = re.compile(r"^```[^\n]*\n|^```\s*$", re.MULTILINE)
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_BOLD_ITALIC_RE = re.compile(r"(\*\*\*|___)(.+?)\1")
_BOLD_RE = re.compile(r"(\*\*|__)(.+?)\1")
_ITALIC_RE = re.compile(r"(\*|_)(.+?)\1")
_HEADING_RE = re.compile(r"^#{1,6}\s*", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"^>\s?", re.MULTILINE)
_HORIZONTAL_RULE_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})\s*$", re.MULTILINE)
_LIST_MARKER_RE = re.compile(r"^\s*([-*+]|\d+\.)\s+", re.MULTILINE)


def _extract_title(raw_markdown: str) -> str | None:
    for line in raw_markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            if title:
                return title
    return None


def _strip_markdown(raw_markdown: str) -> str:
    text = raw_markdown
    text = _CODE_FENCE_RE.sub("", text)
    text = _IMAGE_RE.sub(r"\1", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _INLINE_CODE_RE.sub(r"\1", text)
    text = _BOLD_ITALIC_RE.sub(r"\2", text)
    text = _BOLD_RE.sub(r"\2", text)
    text = _ITALIC_RE.sub(r"\2", text)
    text = _HEADING_RE.sub("", text)
    text = _BLOCKQUOTE_RE.sub("", text)
    text = _HORIZONTAL_RULE_RE.sub("", text)
    text = _LIST_MARKER_RE.sub("", text)

    lines = [line.strip() for line in text.splitlines()]
    non_empty_lines = [line for line in lines if line]
    return "\n".join(non_empty_lines)


def load(path: Path) -> LoadedDocument:
    try:
        raw_markdown = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentExtractionError(f"'{path.name}' is not valid UTF-8 text") from exc

    text = _strip_markdown(raw_markdown)

    if not text:
        raise DocumentExtractionError(f"No extractable text found in Markdown: {path.name}")

    title = _extract_title(raw_markdown)
    # A markdown heading is itself a form of structured-text inference
    # (not embedded file metadata — markdown has none), so it's tagged the
    # same way the shared structured-text pass tags a detected title.
    sources = {"title": ExtractionSource.STRUCTURED_TEXT} if title else {}

    return LoadedDocument(
        file_format="markdown",
        pages=[PageContent(page_number=1, text=text)],
        metadata=ExtractedMetadata(title=title, sources=sources),
    )
