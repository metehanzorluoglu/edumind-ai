from pathlib import Path

from bs4 import BeautifulSoup
from bs4.element import Tag

from app.ingestion.errors import DocumentExtractionError
from app.ingestion.loaders.base import (
    ExtractedMetadata,
    ExtractionSource,
    LoadedDocument,
    PageContent,
)
from app.ingestion.metadata_extraction import extract_year_from_date_string, normalize_doi


def _meta_content(soup: BeautifulSoup, name: str, *, attr: str = "name") -> str | None:
    tag = soup.find("meta", attrs={attr: name})
    if not isinstance(tag, Tag):
        return None
    content = tag.get("content")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _meta_content_all(soup: BeautifulSoup, name: str) -> list[str]:
    values: list[str] = []
    for tag in soup.find_all("meta", attrs={"name": name}):
        if not isinstance(tag, Tag):
            continue
        content = tag.get("content")
        if isinstance(content, str) and content.strip():
            values.append(content.strip())
    return values


def load(path: Path) -> LoadedDocument:
    try:
        raw_html = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentExtractionError(f"'{path.name}' is not valid UTF-8 text") from exc

    soup = BeautifulSoup(raw_html, "html.parser")

    for tag in soup(["script", "style"]):
        tag.decompose()

    # Priority within HTML itself: Highwire/Google-Scholar-style
    # citation_* meta tags (most authoritative for scholarly content,
    # designed exactly for this purpose) > Open Graph > the plain <title>
    # tag, which is often just "Site Name | Page Title" boilerplate.
    citation_title = _meta_content(soup, "citation_title")
    og_title = _meta_content(soup, "og:title", attr="property")
    title_tag = soup.find("title")
    title_tag_text = (
        title_tag.get_text(strip=True) if isinstance(title_tag, Tag) else None
    ) or None
    title = citation_title or og_title or title_tag_text

    citation_authors = _meta_content_all(soup, "citation_author")
    meta_author = _meta_content(soup, "author")
    authors = citation_authors or ([meta_author] if meta_author else [])

    citation_journal = _meta_content(soup, "citation_journal_title")

    raw_doi = _meta_content(soup, "citation_doi")
    doi = normalize_doi(raw_doi) if raw_doi else None

    raw_date = _meta_content(soup, "citation_publication_date") or _meta_content(
        soup, "citation_date"
    )
    publication_year = extract_year_from_date_string(raw_date) if raw_date else None

    canonical_tag = soup.find("link", attrs={"rel": "canonical"})
    source_url = None
    if isinstance(canonical_tag, Tag):
        href = canonical_tag.get("href")
        source_url = href.strip() if isinstance(href, str) and href.strip() else None
    if not source_url:
        source_url = _meta_content(soup, "og:url", attr="property")

    sources: dict[str, ExtractionSource] = {}
    if title:
        sources["title"] = ExtractionSource.EMBEDDED_METADATA
    if authors:
        sources["authors"] = ExtractionSource.EMBEDDED_METADATA
    if citation_journal:
        sources["source_venue"] = ExtractionSource.EMBEDDED_METADATA
    if doi:
        sources["doi"] = ExtractionSource.EMBEDDED_METADATA
    if publication_year:
        sources["publication_year"] = ExtractionSource.EMBEDDED_METADATA
    if source_url:
        sources["source_url"] = ExtractionSource.EMBEDDED_METADATA

    metadata = ExtractedMetadata(
        title=title,
        authors=authors,
        source_venue=citation_journal,
        doi=doi,
        publication_year=publication_year,
        source_url=source_url,
        sources=sources,
    )

    text = soup.get_text(separator="\n", strip=True)

    if not text:
        raise DocumentExtractionError(f"No extractable text found in HTML: {path.name}")

    return LoadedDocument(
        file_format="html", pages=[PageContent(page_number=1, text=text)], metadata=metadata
    )
