"""Chat-attachment validation and on-disk storage (milestone V2).

Deliberately separate from app/ingestion/* (which handles RAG-corpus
documents): a chat attachment is never chunked, embedded, or made
searchable — it exists only so a future vision-integration milestone has
something to read, and so a user can see what they attached in their own
chat history. See app/db/models_conversations.py's MessageAttachment for
the persisted metadata this pairs with.

Every validation decision here is made from the file's actual bytes, never
from a caller-declared Content-Type or filename extension — those are
trivial for a client to spoof (see sniff_mime) — and every image format
this project can decode (PNG, JPEG) is re-encoded before being stored,
which strips EXIF metadata (GPS coordinates, camera/device identifiers,
timestamps) as a side effect: a pymupdf.Pixmap only ever carries raw pixel
samples, never the original file's metadata blocks, so there is no EXIF
left to reproduce once it is re-encoded. WEBP and HEIC are stored
byte-for-byte as uploaded — pymupdf (this project's only imaging
dependency) cannot decode either format, so this project cannot re-encode
them.
"""

import uuid
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from app.core.errors import AttachmentValidationError

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_JPEG_MAGIC = b"\xff\xd8\xff"
_PDF_MAGIC = b"%PDF-"
_RIFF_MAGIC = b"RIFF"
_WEBP_FORMAT = b"WEBP"
# ISO base media file format "brand" values used by HEIC/HEIF images —
# checked against bytes[8:12] of an "....ftyp<brand>" header.
_HEIC_BRANDS = frozenset(
    {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1"}
)

_REENCODABLE_IMAGE_MIMES = frozenset({"image/png", "image/jpeg"})
_BASE_ALLOWED_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "application/pdf"})

_MIME_EXTENSIONS = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "image/heic": ".heic",
}


def sniff_mime(data: bytes) -> str | None:
    """Identifies a file's real format from its content — the only
    signal this module ever trusts for a security decision. Returns None
    for anything unrecognized (the caller rejects it)."""
    if data.startswith(_PNG_MAGIC):
        return "image/png"
    if data.startswith(_JPEG_MAGIC):
        return "image/jpeg"
    if data.startswith(_PDF_MAGIC):
        return "application/pdf"
    if len(data) >= 12 and data[:4] == _RIFF_MAGIC and data[8:12] == _WEBP_FORMAT:
        return "image/webp"
    if len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in _HEIC_BRANDS:
        return "image/heic"
    return None


@dataclass
class ValidatedAttachment:
    mime: str
    data: bytes
    page_count: int | None


def validate_attachment(
    data: bytes,
    *,
    declared_filename: str,
    max_bytes: int,
    max_pdf_pages: int,
    allow_heic: bool,
    page_range_start: int | None = None,
    page_range_end: int | None = None,
) -> ValidatedAttachment:
    """Raises AttachmentValidationError for anything that fails a size,
    mime, page-count, or page-range check. Never raises for anything
    else — a caller that gets a ValidatedAttachment back has a file that
    is safe to persist as-is."""
    if not data:
        raise AttachmentValidationError(f"'{declared_filename}' is empty")
    if len(data) > max_bytes:
        raise AttachmentValidationError(
            f"'{declared_filename}' is {len(data)} bytes, exceeds the {max_bytes}-byte limit"
        )

    mime = sniff_mime(data)
    allowed = set(_BASE_ALLOWED_MIMES)
    if allow_heic:
        allowed.add("image/heic")
    if mime is None or mime not in allowed:
        raise AttachmentValidationError(
            f"'{declared_filename}' is not a supported file type "
            f"(supported: {', '.join(sorted(allowed))})"
        )

    if mime == "application/pdf":
        page_count = _validate_pdf(
            data,
            declared_filename=declared_filename,
            max_pages=max_pdf_pages,
            page_range_start=page_range_start,
            page_range_end=page_range_end,
        )
        return ValidatedAttachment(mime=mime, data=data, page_count=page_count)

    if page_range_start is not None or page_range_end is not None:
        raise AttachmentValidationError(
            f"'{declared_filename}': a page range is only valid for a PDF attachment"
        )

    if mime in _REENCODABLE_IMAGE_MIMES:
        normalized = _strip_exif_via_reencode(data, mime, declared_filename=declared_filename)
        return ValidatedAttachment(mime=mime, data=normalized, page_count=None)

    # image/webp, image/heic: stored byte-for-byte (see module docstring).
    return ValidatedAttachment(mime=mime, data=data, page_count=None)


def _strip_exif_via_reencode(data: bytes, mime: str, *, declared_filename: str) -> bytes:
    try:
        pixmap = pymupdf.Pixmap(data)  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise AttachmentValidationError(
            f"Could not decode '{declared_filename}': {exc}"
        ) from exc
    output_format = "png" if mime == "image/png" else "jpeg"
    return bytes(pixmap.tobytes(output_format))  # type: ignore[no-untyped-call]


def _validate_pdf(
    data: bytes,
    *,
    declared_filename: str,
    max_pages: int,
    page_range_start: int | None,
    page_range_end: int | None,
) -> int:
    try:
        document = pymupdf.open(stream=data, filetype="pdf")  # type: ignore[no-untyped-call]
    except Exception as exc:
        raise AttachmentValidationError(
            f"Could not read '{declared_filename}' as a PDF: {exc}"
        ) from exc

    with document:
        page_count = int(document.page_count)
        if page_count == 0:
            raise AttachmentValidationError(f"'{declared_filename}' has no pages")
        if page_count > max_pages:
            raise AttachmentValidationError(
                f"'{declared_filename}' has {page_count} page(s), "
                f"exceeds the {max_pages}-page limit"
            )

        if page_range_start is not None or page_range_end is not None:
            if page_range_start is None or page_range_end is None:
                raise AttachmentValidationError(
                    f"'{declared_filename}': page_range_start and page_range_end "
                    "must both be provided together"
                )
            if page_range_start < 1 or page_range_end < page_range_start:
                raise AttachmentValidationError(
                    f"'{declared_filename}': invalid page range "
                    f"({page_range_start}-{page_range_end})"
                )
            if page_range_end > page_count:
                raise AttachmentValidationError(
                    f"'{declared_filename}': page range ({page_range_start}-{page_range_end}) "
                    f"exceeds the document's {page_count} page(s)"
                )

        return page_count


class AttachmentStorage:
    """Writes/deletes validated attachment bytes under `root_dir`, one
    subdirectory per owning user
    (`root_dir/{user_id}/{attachment_id}{extension}`) — partitioned by
    user_id so a leaked attachment id alone can never be used to locate
    another user's file, and so removing one user's data never requires
    scanning every attachment in the store. Every path segment here is
    generated by this class itself (a UUID and a fixed extension table),
    never derived from a caller-supplied filename, so there is no path
    to traverse."""

    def __init__(self, root_dir: str) -> None:
        self._root = Path(root_dir).resolve()

    def save(self, *, user_id: uuid.UUID, attachment_id: uuid.UUID, mime: str, data: bytes) -> str:
        extension = _MIME_EXTENSIONS.get(mime, "")
        relative_path = Path(str(user_id)) / f"{attachment_id}{extension}"
        full_path = self._resolve_within_root(str(relative_path))
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_bytes(data)
        return str(relative_path)

    def delete(self, storage_key: str) -> None:
        self._resolve_within_root(storage_key).unlink(missing_ok=True)

    def read(self, storage_key: str) -> bytes:
        """Used by both vision-chat rendering (milestone V3 — see
        app/api/routes_conversations.py's vision-chat handler, which reads
        an already-*validated* upload's in-memory bytes directly for the
        message that is currently being sent) and
        GET .../attachments/{attachment_id} (serving a *previously*
        persisted attachment's content back to the frontend for display —
        the only case that actually calls this method, since a
        same-request attachment's bytes are already in memory)."""
        return self._resolve_within_root(storage_key).read_bytes()

    def _resolve_within_root(self, storage_key: str) -> Path:
        """Defense-in-depth (milestone V4): every real caller only ever
        passes a storage_key this class itself generated in save() (a
        UUID filename under a UUID directory — see the class docstring),
        so `storage_key` is never truly attacker-controlled today. This
        guard exists so that stays true even if a future bug ever fed in
        something else — e.g. `storage_key="../../etc/passwd"` — by
        rejecting any resolved path that would land outside `root_dir`,
        rather than silently reading/deleting/writing wherever the
        traversal pointed."""
        full_path = (self._root / storage_key).resolve()
        if full_path != self._root and self._root not in full_path.parents:
            raise AttachmentValidationError(f"Invalid attachment storage key: {storage_key!r}")
        return full_path
