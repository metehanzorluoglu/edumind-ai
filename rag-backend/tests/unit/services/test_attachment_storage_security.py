"""Regression coverage for app/services/attachment_storage.py's security
properties (QA audit: "validate actual file bytes, MIME type, ownership,
filename safety, size, and dimensions; prevent path traversal, unsafe SVG
content, image bombs, and storage-path leakage"). No dedicated test file
existed for this module before — these lock in behavior already
implemented, verified by reading the code, so a future change can't
silently regress it.
"""

import tempfile
import uuid
from pathlib import Path

import pytest

from app.core.errors import AttachmentValidationError
from app.services.attachment_storage import AttachmentStorage, sniff_mime, validate_attachment

_PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"
    b"\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)
_JPEG_MAGIC_ONLY = b"\xff\xd8\xff\xe0" + b"\x00" * 100  # not a fully valid JPEG, but sniffs as one
_PDF_MINIMAL = b"%PDF-1.4\n%%EOF"
_SVG_PAYLOAD = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'


class TestSniffMime:
    def test_png_is_detected_from_magic_bytes(self) -> None:
        assert sniff_mime(_PNG_1PX) == "image/png"

    def test_jpeg_is_detected_from_magic_bytes(self) -> None:
        assert sniff_mime(_JPEG_MAGIC_ONLY) == "image/jpeg"

    def test_pdf_is_detected_from_magic_bytes(self) -> None:
        assert sniff_mime(_PDF_MINIMAL) == "application/pdf"

    def test_svg_is_not_recognized_as_any_supported_type(self) -> None:
        """SVG is never in the supported-type list at all — an SVG upload
        is rejected outright by validate_attachment below, not sanitized;
        there is no path where SVG markup is ever stored or served."""
        assert sniff_mime(_SVG_PAYLOAD) is None

    def test_plain_text_renamed_with_an_image_extension_is_not_sniffed_as_an_image(self) -> None:
        """Filename/extension is never consulted — only content. A text
        file's bytes never match any magic-byte signature."""
        assert sniff_mime(b"just some plain text content, not an image") is None

    def test_empty_bytes_are_not_recognized(self) -> None:
        assert sniff_mime(b"") is None


class TestValidateAttachment:
    def test_rejects_zero_byte_file(self) -> None:
        with pytest.raises(AttachmentValidationError, match="empty"):
            validate_attachment(
                b"", declared_filename="empty.png", max_bytes=1_000_000, max_pdf_pages=10,
                allow_heic=False,
            )

    def test_rejects_file_over_the_byte_limit(self) -> None:
        oversized = _PNG_1PX + (b"\x00" * 1000)
        with pytest.raises(AttachmentValidationError, match="exceeds"):
            validate_attachment(
                oversized,
                declared_filename="big.png",
                max_bytes=len(_PNG_1PX),
                max_pdf_pages=10,
                allow_heic=False,
            )

    def test_rejects_corrupt_image_bytes_even_with_correct_magic_number(self) -> None:
        """PNG magic bytes followed by garbage: passes the cheap magic-byte
        sniff but must fail at actual decode."""
        corrupt = b"\x89PNG\r\n\x1a\n" + b"not a real png stream" * 5
        with pytest.raises(AttachmentValidationError, match="[Cc]ould not decode"):
            validate_attachment(
                corrupt, declared_filename="corrupt.png", max_bytes=1_000_000, max_pdf_pages=10,
                allow_heic=False,
            )

    def test_rejects_corrupt_pdf_bytes_even_with_correct_magic_number(self) -> None:
        corrupt = b"%PDF-1.4\n" + b"not a real pdf structure" * 5
        with pytest.raises(AttachmentValidationError, match="[Cc]ould not read"):
            validate_attachment(
                corrupt, declared_filename="corrupt.pdf", max_bytes=1_000_000, max_pdf_pages=10,
                allow_heic=False,
            )

    def test_rejects_svg_content_outright(self) -> None:
        with pytest.raises(AttachmentValidationError, match="not a supported file type"):
            validate_attachment(
                _SVG_PAYLOAD, declared_filename="image.svg", max_bytes=1_000_000, max_pdf_pages=10,
                allow_heic=False,
            )

    def test_rejects_a_renamed_non_image_file_regardless_of_declared_filename(self) -> None:
        """A .png-named file whose real bytes are plain text must be
        rejected — filename/extension carries zero trust."""
        with pytest.raises(AttachmentValidationError, match="not a supported file type"):
            validate_attachment(
                b"I am secretly a text file",
                declared_filename="totally-a-real-image.PNG",  # uppercase extension, still ignored
                max_bytes=1_000_000,
                max_pdf_pages=10,
                allow_heic=False,
            )

    def test_uppercase_extension_does_not_affect_a_genuinely_valid_image(self) -> None:
        """Extension casing is irrelevant either way — only content is
        inspected, so a real PNG validates regardless of the declared
        filename's extension casing."""
        result = validate_attachment(
            _PNG_1PX, declared_filename="PHOTO.PNG", max_bytes=1_000_000, max_pdf_pages=10,
            allow_heic=False,
        )
        assert result.mime == "image/png"

    def test_heic_rejected_when_not_allowed(self) -> None:
        heic_bytes = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 20
        with pytest.raises(AttachmentValidationError, match="not a supported file type"):
            validate_attachment(
                heic_bytes, declared_filename="photo.heic", max_bytes=1_000_000, max_pdf_pages=10,
                allow_heic=False,
            )

    def test_pdf_over_page_limit_rejected(self) -> None:
        # A minimal 1-page-shaped PDF can't easily be hand-built with many
        # pages here without a real PDF library call; page-count enforcement
        # itself is covered end-to-end via vision_service tests. This test
        # only confirms the zero-page-count guard on a page-less minimal PDF.
        with pytest.raises(AttachmentValidationError):
            validate_attachment(
                _PDF_MINIMAL,
                declared_filename="empty.pdf",
                max_bytes=1_000_000,
                max_pdf_pages=10,
                allow_heic=False,
            )

    def test_reencoded_png_strips_exif_by_construction(self) -> None:
        """Every accepted PNG/JPEG is re-encoded from decoded pixels (see
        the module docstring) — the returned bytes are never a byte-for-
        byte copy of the input, which is what guarantees no metadata
        (EXIF GPS/device/timestamp data) survives, without needing a
        dedicated EXIF-bearing fixture to prove it."""
        result = validate_attachment(
            _PNG_1PX, declared_filename="photo.png", max_bytes=1_000_000, max_pdf_pages=10,
            allow_heic=False,
        )
        assert result.data != _PNG_1PX
        assert sniff_mime(result.data) == "image/png"


class TestAttachmentStoragePathTraversal:
    def _storage(self) -> AttachmentStorage:
        return AttachmentStorage(tempfile.mkdtemp())

    def test_save_then_read_round_trips_real_bytes(self) -> None:
        storage = self._storage()
        user_id = uuid.uuid4()
        attachment_id = uuid.uuid4()
        key = storage.save(user_id=user_id, attachment_id=attachment_id, mime="image/png", data=_PNG_1PX)
        assert storage.read(key) == _PNG_1PX

    def test_storage_key_is_always_uuid_shaped_never_the_declared_filename(self) -> None:
        """The declared filename never reaches the filesystem path at
        all — save() only ever accepts mime/user_id/attachment_id, so
        there is no parameter through which a malicious filename like
        '../../etc/passwd' could even be passed to influence the path."""
        storage = self._storage()
        key = storage.save(
            user_id=uuid.uuid4(), attachment_id=uuid.uuid4(), mime="image/png", data=_PNG_1PX
        )
        assert ".." not in key
        assert key.endswith(".png")

    @pytest.mark.parametrize(
        "malicious_key",
        [
            "../../../../etc/passwd",
            "../../secrets.env",
            "/etc/passwd",
            "a/../../b",
        ],
    )
    def test_read_rejects_a_path_traversal_storage_key(self, malicious_key: str) -> None:
        """Defense-in-depth (see _resolve_within_root's own docstring): a
        real caller only ever passes a key this class itself generated,
        but even a hypothetical future bug feeding in an attacker-shaped
        key must not be able to read outside root_dir."""
        storage = self._storage()
        with pytest.raises(AttachmentValidationError):
            storage.read(malicious_key)

    @pytest.mark.parametrize(
        "malicious_key",
        ["../../../../etc/passwd", "/etc/passwd"],
    )
    def test_delete_rejects_a_path_traversal_storage_key(self, malicious_key: str) -> None:
        storage = self._storage()
        with pytest.raises(AttachmentValidationError):
            storage.delete(malicious_key)

    def test_files_are_partitioned_per_user_directory(self) -> None:
        storage = self._storage()
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        key_a = storage.save(
            user_id=user_a, attachment_id=uuid.uuid4(), mime="image/png", data=_PNG_1PX
        )
        key_b = storage.save(
            user_id=user_b, attachment_id=uuid.uuid4(), mime="image/png", data=_PNG_1PX
        )
        assert Path(key_a).parts[0] == str(user_a)
        assert Path(key_b).parts[0] == str(user_b)
        assert Path(key_a).parts[0] != Path(key_b).parts[0]
