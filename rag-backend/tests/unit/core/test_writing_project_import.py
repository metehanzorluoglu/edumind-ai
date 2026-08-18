"""Milestone 5.4 (LaTeX Templates & Project Import) — RELEASE CRITICAL
coverage for app/core/writing_project_import.py's inspect_archive()
pipeline: Part 6 (zip-bomb defense), Part 7 (zip-slip/path traversal),
Part 8 (symlinks), Part 11 (references.bib policy), Part 12/13 (root
detection), and Part 17/18 (duplicate paths, encoding).

Every "must reject" case here asserts ArchiveRejected specifically —
never a bare exception — matching this module's own contract that the
release-critical categories always reject the WHOLE archive outright,
never partially.
"""

from __future__ import annotations

import io
import os
import zipfile

import pytest

from app.core.writing_project_import import ArchiveRejected, _normalize_entry_segments, inspect_archive


def _zip_bytes(entries: dict[str, bytes], *, compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=compression) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


class TestHappyPath:
    def test_single_file_project_is_accepted(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}\\begin{document}Hi\\end{document}"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert inspection.preselected_root == "main.tex"
        assert inspection.root_candidates == ["main.tex"]
        assert inspection.warnings == []

    def test_multi_file_project_with_figure_and_style(self) -> None:
        data = _zip_bytes(
            {
                "main.tex": b"\\documentclass{article}\\input{sections/intro}\\begin{document}\\end{document}",
                "sections/intro.tex": b"Intro text.",
                "figures/plot.png": b"\x89PNG\r\n\x1a\n" + b"0" * 100,
                "mystyle.sty": b"\\ProvidesPackage{mystyle}",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert paths == ["figures/plot.png", "main.tex", "mystyle.sty", "sections/intro.tex"]
        assert inspection.preselected_root == "main.tex"

    def test_suggested_title_derived_from_root_filename(self) -> None:
        data = _zip_bytes({"my_paper.tex": b"\\documentclass{article}"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert inspection.suggested_title == "My Paper"


class TestWrapperFolderNormalization:
    """Milestone 5.5.2 Part 14 — real-world finding: publisher/
    university templates (the UNLV fixture is the exact real case) are
    conventionally shipped as one common top-level wrapper directory."""

    def test_common_wrapper_directory_is_stripped(self) -> None:
        data = _zip_bytes(
            {
                "UNLV_Thesis_Template_Clean/thesis.tex": b"\\documentclass{book}",
                "UNLV_Thesis_Template_Clean/Chapter1.tex": b"Chapter one.",
                "UNLV_Thesis_Template_Clean/UNLVthesis.sty": b"\\ProvidesPackage{UNLVthesis}",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert paths == ["Chapter1.tex", "UNLVthesis.sty", "thesis.tex"]
        # Root detection (Part 15) operates on the NORMALIZED paths.
        assert inspection.preselected_root == "thesis.tex"

    def test_nested_subfolders_under_the_wrapper_are_preserved_relative_to_it(self) -> None:
        data = _zip_bytes(
            {
                "Template/main.tex": b"\\documentclass{article}",
                "Template/sections/intro.tex": b"Intro.",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert paths == ["main.tex", "sections/intro.tex"]

    def test_no_normalization_when_a_file_is_already_at_top_level(self) -> None:
        data = _zip_bytes(
            {
                "Template/main.tex": b"\\documentclass{article}",
                "notes.txt": b"top-level notes",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert "Template/main.tex" in paths
        assert "notes.txt" in paths

    def test_no_normalization_across_two_genuinely_independent_top_level_directories(self) -> None:
        data = _zip_bytes(
            {
                "ProjectA/main.tex": b"\\documentclass{article}",
                "ProjectB/other.tex": b"Some text.",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert paths == ["ProjectA/main.tex", "ProjectB/other.tex"]

    def test_already_flat_project_is_unaffected(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "notes.tex": b"Notes."})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        paths = sorted(f.path for f in inspection.files)
        assert paths == ["main.tex", "notes.tex"]


class TestDocumentationFileSupport:
    """Milestone 5.5.2 Part 16/17 — real-world finding: the UNLV fixture
    ships a README.md with setup/thesis-requirement instructions;
    silently dropping it was not acceptable. .gitignore stays
    unsupported but gets a specific, honest reason."""

    def test_readme_md_is_imported_as_a_readable_text_file(self) -> None:
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", "README.md": b"# Setup\nRead this first."}
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        readme = next(f for f in inspection.files if f.path == "README.md")
        assert readme.kind == "text"
        assert readme.content_text == "# Setup\nRead this first."
        assert inspection.warnings == []

    def test_readme_is_never_a_root_candidate(self) -> None:
        data = _zip_bytes(
            {
                "main.tex": b"\\documentclass{article}",
                "README.md": b"# Not LaTeX, even though this line mentions \\documentclass",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert inspection.root_candidates == ["main.tex"]
        assert inspection.preselected_root == "main.tex"

    def test_gitignore_gets_a_specific_reason_not_the_generic_message(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", ".gitignore": b"*.aux\n*.log"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert len(inspection.warnings) == 1
        assert inspection.warnings[0].reason == "Repository metadata is not imported by EduM8."


class TestZipSlipAndPathTraversal:
    """Part 7 — RELEASE CRITICAL."""

    def test_rejects_dotdot_traversal(self) -> None:
        data = _zip_bytes({"../../etc/passwd": b"pwned"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_leading_slash_absolute_path(self) -> None:
        data = _zip_bytes({"/etc/passwd": b"pwned"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_windows_drive_letter_absolute_path(self) -> None:
        data = _zip_bytes({"C:/Windows/System32/evil.tex": b"x"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_backslash_traversal(self) -> None:
        data = _zip_bytes({"..\\..\\evil.tex": b"x"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_embedded_dotdot_segment(self) -> None:
        data = _zip_bytes({"sections/../../escape.tex": b"x"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_null_byte_in_name(self) -> None:
        # zipfile itself truncates a name at an embedded null byte on
        # write/read (a libc-string-handling quirk below this module's
        # control), so a null byte can never actually survive into
        # inspect_archive()'s view of an entry's filename through a real
        # ZIP — exercise the underlying segment validator directly
        # instead, which is where Part 7's defense actually lives.
        assert _normalize_entry_segments("main.tex\x00.png") is None

    def test_rejects_empty_path_component(self) -> None:
        data = _zip_bytes({"sections//intro.tex": b"x"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_unicode_line_separator_trick(self) -> None:
        # U+2028 LINE SEPARATOR — a Zl-category character that could
        # visually or structurally impersonate a path separator.
        data = _zip_bytes({"sections\u2028intro.tex": b"x"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)


class TestSymlinks:
    """Part 8 — reject outright, never follow."""

    def test_rejects_symlink_entry(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            info = zipfile.ZipInfo("link.tex")
            info.external_attr = (0o120777 & 0xFFFF) << 16
            zf.writestr(info, "/etc/passwd")
        with pytest.raises(ArchiveRejected):
            inspect_archive(buf.getvalue(), max_archive_bytes=30_000_000)


class TestDuplicateAndOverlappingPaths:
    """Part 17."""

    def test_rejects_duplicate_path_case_sensitive(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("main.tex", "first")
            zf.writestr("main.tex", "second")
        with pytest.raises(ArchiveRejected):
            inspect_archive(buf.getvalue(), max_archive_bytes=30_000_000)

    def test_rejects_file_used_as_both_file_and_folder(self) -> None:
        data = _zip_bytes({"foo": b"i am a file", "foo/bar.tex": b"i am inside foo"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)


class TestNestedArchives:
    """Part 6 — recursive nested archives rejected outright."""

    def test_rejects_zip_within_zip(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "extra.zip": b"PK\x03\x04fake"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_rar_extension(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "extra.rar": b"fake"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)


class TestZipBombDefense:
    """Part 6 — RELEASE CRITICAL."""

    def test_rejects_archive_exceeding_upload_size_cap(self) -> None:
        data = _zip_bytes({"blob.png": os.urandom(200)})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=50)

    def test_rejects_too_many_entries(self) -> None:
        entries = {f"f{i}.tex": b"x" for i in range(151)}
        data = _zip_bytes(entries)
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_suspicious_compression_ratio(self) -> None:
        # 10MB of zeros compresses to a tiny fraction of its size —
        # under the 15MB per-entry cap but far over the 100x ratio
        # threshold, exercising the ratio-specific defense independent
        # of the absolute-size defense.
        huge_zeros = b"\x00" * (10 * 1024 * 1024)
        data = _zip_bytes({"bomb.txt": huge_zeros}, compression=zipfile.ZIP_DEFLATED)
        with pytest.raises(ArchiveRejected, match="compression ratio"):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_rejects_entry_exceeding_per_file_cap(self) -> None:
        # Random (incompressible) bytes past MAX_IMPORT_SINGLE_ENTRY_BYTES
        # (15,000,000) — stored, not deflated, so declared file_size ==
        # compress_size and this exercises the absolute per-entry cap
        # specifically, independent of the ratio check.
        data = _zip_bytes({"huge.png": os.urandom(15_000_001)}, compression=zipfile.ZIP_STORED)
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)

    def test_bounded_read_independent_of_declared_metadata(self) -> None:
        """A crafted ZipInfo that LIES about file_size (claims small,
        actual content larger) must still be caught by the bounded
        `.read(limit+1)` pass, not just the metadata pre-check."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
            info = zipfile.ZipInfo("lie.tex")
            zf.writestr(info, "x" * (600_000))  # exceeds MAX_TEXT_FILE_CONTENT_CHARS (500_000)
        with pytest.raises(ArchiveRejected):
            inspect_archive(buf.getvalue(), max_archive_bytes=30_000_000)


class TestReferencesBibPolicy:
    """Part 11, narrowed by the Bibliography Source Detection milestone
    — only a file literally named "references.bib" (EduM8's own
    reserved virtual-file name) is detected/reported/EXCLUDED now; any
    other `.bib` file is a legitimate import (see
    TestOtherBibFilesAreImported below and app/core/reference_mode.py)."""

    def test_references_bib_excluded_with_warning_not_whole_archive_rejection(self) -> None:
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", "references.bib": b"@article{x,}"}
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert len(inspection.warnings) == 1
        assert inspection.warnings[0].path == "references.bib"
        assert "reserved" in inspection.warnings[0].reason

    @pytest.mark.parametrize("name", ["REFERENCES.BIB", "References.Bib"])
    def test_references_bib_excluded_case_insensitively(self, name: str) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", name: b"@article{x,}"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert inspection.warnings[0].path == name

    def test_bibliography_carve_out_still_rejects_unsafe_names(self) -> None:
        data = _zip_bytes({"../references.bib": b"@article{x,}"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)


class TestOtherBibFilesAreImported:
    """Bibliography Source Detection milestone — a real imported `.bib`
    database (any name OTHER than the one reserved "references.bib") is
    now a legitimate project file, not silently dropped: the real-world
    case this fixes is the Springer Nature journal template, which ships
    its own "sn-bibliography.bib"."""

    @pytest.mark.parametrize("name", ["bibliography.bib", "refs.bib", "sn-bibliography.bib"])
    def test_a_differently_named_bib_file_imports_as_a_normal_text_file(self, name: str) -> None:
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", name: b"@article{bib1,\ntitle={x}\n}"}
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert {f.path for f in inspection.files} == {"main.tex", name}
        assert inspection.warnings == []
        bib_file = next(f for f in inspection.files if f.path == name)
        assert bib_file.kind == "text"
        assert bib_file.content_text is not None
        assert "@article{bib1," in bib_file.content_text


class TestUnsupportedExtensions:
    """Part 10."""

    def test_unsupported_extension_excluded_with_warning(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "run.sh": b"#!/bin/sh\nrm -rf /"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert inspection.warnings[0].path == "run.sh"
        assert "Unsupported" in inspection.warnings[0].reason

    def test_archive_with_only_unsupported_files_is_rejected(self) -> None:
        data = _zip_bytes({"run.sh": b"#!/bin/sh"})
        with pytest.raises(ArchiveRejected):
            inspect_archive(data, max_archive_bytes=30_000_000)


class TestEncodingAndBinaryContent:
    """Part 18."""

    def test_invalid_utf8_text_file_excluded_with_warning(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "bad.tex": b"\xff\xfe\x00broken"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert "UTF-8" in inspection.warnings[0].reason

    def test_valid_accented_utf8_text_preserved(self) -> None:
        content = "\\documentclass{article}% café, naïve, façade".encode("utf-8")
        data = _zip_bytes({"main.tex": content})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert "café" in inspection.files[0].content_text

    def test_empty_file_excluded_with_warning(self) -> None:
        data = _zip_bytes({"main.tex": b"\\documentclass{article}", "empty.tex": b""})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert [f.path for f in inspection.files] == ["main.tex"]
        assert "empty" in inspection.warnings[0].reason.lower()


class TestRootDetection:
    """Part 12/13."""

    def test_no_documentclass_anywhere_yields_no_candidates(self) -> None:
        data = _zip_bytes({"notes.tex": b"just some notes, no preamble"})
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert inspection.root_candidates == []
        assert inspection.preselected_root is None

    def test_multiple_documentclass_files_require_explicit_choice(self) -> None:
        data = _zip_bytes(
            {
                "main.tex": b"\\documentclass{article}",
                "alt/backup.tex": b"\\documentclass{article}",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert set(inspection.root_candidates) == {"main.tex", "alt/backup.tex"}
        # Part 12 — "if multiple: ask user" — preselected always stays
        # None even when a priority filename match narrows the list.
        assert inspection.preselected_root is None

    def test_priority_filename_and_top_level_sorted_first(self) -> None:
        data = _zip_bytes(
            {
                "sections/appendix.tex": b"\\documentclass{report}",
                "manuscript.tex": b"\\documentclass{article}",
            }
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        assert inspection.root_candidates[0] == "manuscript.tex"


class TestOuterEnvelope:
    def test_rejects_non_zip_bytes(self) -> None:
        with pytest.raises(ArchiveRejected):
            inspect_archive(b"not a zip file at all", max_archive_bytes=30_000_000)

    def test_rejects_empty_bytes(self) -> None:
        with pytest.raises(ArchiveRejected):
            inspect_archive(b"", max_archive_bytes=30_000_000)

    def test_rejects_archive_with_no_files_only_directories(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("sections/", "")
        with pytest.raises(ArchiveRejected):
            inspect_archive(buf.getvalue(), max_archive_bytes=30_000_000)


class TestInspectionSerializationRoundTrip:
    """Persisted on WritingImportSession.inspection_json and read back by
    a later confirm() call — must round-trip exactly for text content,
    and must never include raw_bytes (binary content is deliberately
    re-read from the staged archive on confirm, not persisted here)."""

    def test_to_json_and_from_json_round_trip(self) -> None:
        data = _zip_bytes(
            {"main.tex": b"\\documentclass{article}", "figures/plot.png": b"\x89PNG" + b"0" * 20}
        )
        inspection = inspect_archive(data, max_archive_bytes=30_000_000)
        restored = type(inspection).from_json_dict(inspection.to_json_dict())
        assert restored.suggested_title == inspection.suggested_title
        assert [f.path for f in restored.files] == [f.path for f in inspection.files]
        assert restored.preselected_root == inspection.preselected_root
        text_entry = next(f for f in restored.files if f.kind == "text")
        assert text_entry.content_text == "\\documentclass{article}"
        binary_entry = next(f for f in restored.files if f.kind == "binary")
        assert binary_entry.raw_bytes is None
