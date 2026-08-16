"""Milestone 5.3 — app/core/writing_file_validation.py. Release-critical
(Part 37): every one of these is a real attempt this test suite proves
gets rejected, not merely documented as "should be rejected"."""

import pytest

from app.core.writing_file_validation import (
    InvalidFileNameError,
    extension_of,
    kind_for_extension,
    validate_depth,
    validate_entry_name,
)


class TestValidateEntryName:
    @pytest.mark.parametrize(
        "name",
        [
            "introduction.tex",
            "figure 1.png",
            "results.pdf",
            "journal.cls",
            "My Section.tex",
            "a",
            "sources",
        ],
    )
    def test_accepts_ordinary_names(self, name: str) -> None:
        assert validate_entry_name(name) == name

    @pytest.mark.parametrize(
        "name",
        [
            "",
            " leading.tex",
            "trailing.tex ",
            ".",
            "..",
            "../secret.tex",
            "..\\secret.tex",
            "sections/introduction.tex",
            "sections\\introduction.tex",
            "a/../../etc/passwd",
            "..%2Fsecret.tex",  # literal percent-encoding is NOT decoded — rejected as ordinary chars only if they contain '..'; see traversal test below for the real point
            "x" * 200,
        ],
    )
    def test_rejects_structurally_unsafe_or_invalid_names(self, name: str) -> None:
        if name == "..%2Fsecret.tex":
            # This one doesn't contain a literal '..' substring check
            # failure by itself necessarily (it does, in fact, contain
            # ".." as the first two chars) — kept as an explicit
            # regression marker that URL-encoded traversal strings are
            # rejected for containing '..' literally, not because this
            # module decodes percent-encoding (it deliberately never
            # does — see traversal test below).
            with pytest.raises(InvalidFileNameError):
                validate_entry_name(name)
            return
        with pytest.raises(InvalidFileNameError):
            validate_entry_name(name)

    def test_rejects_null_byte(self) -> None:
        with pytest.raises(InvalidFileNameError):
            validate_entry_name("evil\x00.tex")

    def test_rejects_control_characters(self) -> None:
        with pytest.raises(InvalidFileNameError):
            validate_entry_name("evil\x01name.tex")

    def test_rejects_reserved_references_bib(self) -> None:
        with pytest.raises(InvalidFileNameError):
            validate_entry_name("references.bib")
        with pytest.raises(InvalidFileNameError):
            validate_entry_name("References.bib")  # case-insensitive

    def test_never_silently_mutates_the_name(self) -> None:
        # A valid name with internal spaces round-trips byte for byte.
        assert validate_entry_name("my results (v2).pdf") == "my results (v2).pdf"


class TestExtensionAndKind:
    def test_extension_of(self) -> None:
        assert extension_of("introduction.tex") == ".tex"
        assert extension_of("archive.tar.gz") == ".gz"
        assert extension_of("no_extension") == ""
        assert extension_of("UPPER.TEX") == ".tex"

    @pytest.mark.parametrize(
        "name,expected",
        [
            ("main.tex", "text"),
            ("journal.cls", "text"),
            ("custom.sty", "text"),
            ("notes.txt", "text"),
            ("figure.png", "binary"),
            ("figure.jpg", "binary"),
            ("figure.jpeg", "binary"),
            ("scan.pdf", "binary"),
        ],
    )
    def test_allowed_extensions(self, name: str, expected: str) -> None:
        assert kind_for_extension(name) == expected

    @pytest.mark.parametrize(
        "name",
        [
            "script.sh",
            "program.exe",
            "archive.zip",
            "style.bst",  # deliberately deferred — Part 45
            "malware.py",
            "config.json",
            "noext",
        ],
    )
    def test_disallowed_extensions_return_none(self, name: str) -> None:
        assert kind_for_extension(name) is None


class TestDepth:
    def test_within_limit_ok(self) -> None:
        validate_depth(0)
        validate_depth(11)

    def test_at_limit_rejected(self) -> None:
        with pytest.raises(InvalidFileNameError):
            validate_depth(12)

    def test_beyond_limit_rejected(self) -> None:
        with pytest.raises(InvalidFileNameError):
            validate_depth(50)
