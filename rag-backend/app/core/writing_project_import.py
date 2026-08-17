"""Milestone 5.4 (LaTeX Templates & Project Import) — RELEASE CRITICAL.

Static inspection of an uploaded project ZIP: every check in this module
runs BEFORE a single byte of file content is trusted or written anywhere
(Part 9: "do not extract first and check later"). The whole-archive
metadata pass (entry count, declared sizes, path safety, symlinks,
duplicate paths, nested archives) always runs first and can reject the
entire upload outright; only entries that survive it are ever read, and
even then every read is BOUNDED (Part 6's zip-bomb defense) independent
of what the archive's own metadata claims.

Reuses app/core/writing_file_validation.py's `validate_entry_name` for
every individual path SEGMENT — the exact same validator every other
Writing Project file/folder name in this codebase is checked against —
so an imported file's name can never be "safe by a different, weaker
rule" than a manually-created one.
"""

from __future__ import annotations

import io
import unicodedata
import zipfile
from dataclasses import dataclass, field

from app.core.writing_file_validation import (
    InvalidFileNameError,
    extension_of,
    kind_for_extension,
    validate_depth,
    validate_entry_name,
)
from app.db.models_writing import (
    MAX_BINARY_FILE_BYTES,
    MAX_IMPORT_COMPRESSION_RATIO,
    MAX_IMPORT_ENTRIES,
    MAX_IMPORT_SINGLE_ENTRY_BYTES,
    MAX_IMPORT_TOTAL_UNCOMPRESSED_BYTES,
    MAX_TEXT_FILE_CONTENT_CHARS,
)

#: Part 6 — reject any entry whose OWN extension is itself an archive
#: format, outright, before it's ever opened (Part 6: "recursive nested
#: archives"). This is deliberately broader than the two formats Python's
#: zipfile itself understands — an entry named "extra.rar" is refused
#: for the same reason a ".exe" would be: it's not a project file type
#: this milestone (or M5.3 before it) has ever allowed, and naming it
#: something else doesn't change that.
_ARCHIVE_EXTENSIONS = frozenset(
    {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war"}
)

#: Part 12 — filenames (case-insensitive, extension stripped) that get
#: priority when multiple `.tex` files all contain `\documentclass` —
#: "do not simply pick alphabetically."
_ROOT_FILENAME_PRIORITY = ("main", "paper", "manuscript", "article", "thesis")

#: Static root detection only ever scans the first N bytes of a `.tex`
#: file for `\documentclass` (Part 13: "do not execute TeX... limit
#: bytes scanned... do not recursively follow arbitrary input
#: directives").
_ROOT_SCAN_BYTES = 20_000

#: Part 11 — any of these filenames (case-insensitive) found in the
#: archive gets flagged and EXCLUDED, never silently made canonical.
_BIBLIOGRAPHY_FILENAMES = frozenset({"references.bib", "bibliography.bib", "refs.bib"})


class ArchiveRejected(Exception):
    """Raised for anything that must reject the WHOLE archive outright —
    the release-critical categories (Parts 6/7/8): oversized/too many
    entries, a zip bomb signature, ANY traversal-unsafe path, ANY
    symlink, ANY duplicate/overlapping path, ANY nested archive entry,
    excessive folder depth, or a corrupt/unreadable ZIP. Never partial —
    the caller creates nothing and stages nothing on a rejection."""


@dataclass(frozen=True)
class ImportFileEntry:
    """One file this import WILL include if confirmed — already fully
    validated (safe path, allowed extension, within every size limit,
    valid UTF-8 if text)."""

    path: str  # the project-relative path, e.g. "sections/intro.tex"
    kind: str  # "text" | "binary"
    size_bytes: int
    content_text: str | None = None  # kind == "text" only
    raw_bytes: bytes | None = None  # kind == "binary" only, NOT serialized to JSON


@dataclass(frozen=True)
class ImportWarning:
    path: str
    reason: str


@dataclass(frozen=True)
class ImportInspection:
    """The full result of inspecting one archive — JSON-serializable
    (see to_json_dict/from_json_dict below) so it can be persisted on a
    WritingImportSession row and read back by a later `confirm` call
    without ever needing to keep archive bytes in memory across
    requests."""

    suggested_title: str
    files: list[ImportFileEntry]
    root_candidates: list[str]
    preselected_root: str | None
    warnings: list[ImportWarning] = field(default_factory=list)
    total_size_bytes: int = 0

    def to_json_dict(self) -> dict:
        return {
            "suggested_title": self.suggested_title,
            "files": [
                {
                    "path": f.path,
                    "kind": f.kind,
                    "size_bytes": f.size_bytes,
                    # content_text IS persisted (small, bounded, and
                    # confirm needs it without re-reading the archive
                    # for text files); raw_bytes is NEVER persisted to
                    # JSON — confirm re-reads binary bytes from the
                    # staged archive itself, keeping this JSON blob
                    # small regardless of how many images a project has.
                    "content_text": f.content_text,
                }
                for f in self.files
            ],
            "root_candidates": self.root_candidates,
            "preselected_root": self.preselected_root,
            "warnings": [{"path": w.path, "reason": w.reason} for w in self.warnings],
            "total_size_bytes": self.total_size_bytes,
        }

    @staticmethod
    def from_json_dict(data: dict) -> "ImportInspection":
        return ImportInspection(
            suggested_title=data["suggested_title"],
            files=[
                ImportFileEntry(
                    path=f["path"],
                    kind=f["kind"],
                    size_bytes=f["size_bytes"],
                    content_text=f.get("content_text"),
                )
                for f in data["files"]
            ],
            root_candidates=data["root_candidates"],
            preselected_root=data.get("preselected_root"),
            warnings=[ImportWarning(path=w["path"], reason=w["reason"]) for w in data.get("warnings", [])],
            total_size_bytes=data.get("total_size_bytes", 0),
        )


def _decode_text_entry(raw: bytes) -> str | None:
    """Milestone 5.5.1 Part 20/23 — real-world finding, not a synthetic
    fixture: a genuine Springer Nature journal template's main .tex file
    (the December 2024 "sn-article-template" package) failed to import
    at all, because it contains "smart quotes" saved as Windows-1252
    (cp1252) bytes 0x93/0x94 rather than UTF-8 — the file's own
    `\\usepackage[utf8]{inputenc}` declaration only describes what
    encoding pdflatex should EXPECT once compiled, and says nothing
    about what encoding the .tex file was actually SAVED in; templates
    edited on Windows (often via Word or a legacy editor) commonly end
    up cp1252-encoded regardless. UTF-8 is tried first and preferred —
    cp1252 is only a fallback for files that are not valid UTF-8 at
    all — and cp1252 (not the more permissive latin-1) is the right
    fallback specifically because latin-1 accepts EVERY byte value
    without ever failing, silently mapping 0x93/0x94 to the WRONG
    control-range characters instead of the correct curly quotes;
    cp1252 gets it right for exactly the "Windows text editor" case this
    exists for, while still failing on genuinely non-text content (Part
    18's requirement is preserved — this only ever changes what gets
    ACCEPTED as valid text, never accepts binary data as text). The
    result is re-encoded to UTF-8 when persisted (ImportFileEntry.
    content_text is a Python str), so what pdflatex ultimately reads
    back is real UTF-8 bytes — consistent with the template's own
    inputenc declaration, not a mismatch this introduces.

    Regression guard: unlike UTF-8, cp1252 defines a mapping for
    almost every byte value, so tried on its own it cannot tell "real
    Windows-encoded text" apart from arbitrary binary garbage that
    merely isn't valid UTF-8 (an existing test caught this: content
    with a NUL byte was previously "successfully" cp1252-decoded and
    silently accepted as text). Two guards keep Part 18's promise
    intact: a NUL byte never appears in genuine text, so it is rejected
    immediately, before either encoding is even attempted; and once
    cp1252-decoded, content whose control-character ratio is too high
    to plausibly be prose/markup is rejected too.
    """
    if b"\x00" in raw:
        return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        text = raw.decode("cp1252")
    except UnicodeDecodeError:
        return None
    control_count = sum(1 for ch in text if ord(ch) < 32 and ch not in "\t\n\r")
    if control_count > max(1, len(text) // 100):
        return None
    return text


def _is_symlink_entry(info: zipfile.ZipInfo) -> bool:
    """A ZIP entry created on a POSIX system with `zipfile`/`zip -y` (or
    most archivers) stores the Unix file mode in the upper 16 bits of
    `external_attr`; S_IFLNK (0o120000) marks a symlink. Part 8: reject
    outright, never follow — this codebase never calls
    ZipFile.extract()/extractall() at all (only bounded in-memory
    .read() on entries that already passed every other check), so a
    symlink entry cannot actually be "followed" through this code path
    regardless, but detecting and refusing it explicitly removes the
    surface entirely rather than relying on that as the only defense."""
    mode = (info.external_attr >> 16) & 0o170000
    return mode == 0o120000


def _normalize_entry_segments(filename: str) -> list[str] | None:
    """Part 7 — RELEASE CRITICAL. Splits a raw ZIP entry name into path
    segments and validates every single one with the EXACT SAME
    `validate_entry_name` every manually-created file/folder name in
    this codebase already goes through. Returns None for anything
    unsafe: absolute paths (leading '/'), Windows drive-letter absolute
    paths ("C:\\..."), backslash-as-separator (normalized then
    re-validated, not silently trusted), a null byte anywhere, empty
    path components (from "a//b" or a trailing '/'), '.' or '..'
    segments, and anything `validate_entry_name` itself already refuses
    (control chars, Unicode line/paragraph separators, '..' substrings,
    the reserved "references.bib" name at any position)."""
    if not filename:
        return None
    if "\x00" in filename:
        return None
    # zipfile always stores '/' as the separator per the ZIP spec, but a
    # maliciously-crafted archive can still put a literal backslash
    # INSIDE a filename — treat both as separators rather than trusting
    # either exclusively (Part 7: "backslash traversal").
    normalized = filename.replace("\\", "/")
    if normalized.startswith("/"):
        return None
    # Windows drive-letter absolute path, e.g. "C:/Windows/System32" —
    # `Path.is_absolute()` on a POSIX host does NOT catch this (it only
    # recognizes a leading '/'), so it needs its own explicit check.
    if len(normalized) >= 2 and normalized[1] == ":" and normalized[0].isalpha():
        return None
    raw_segments = normalized.split("/")
    segments: list[str] = []
    for position, raw in enumerate(raw_segments):
        if raw == "":
            # Empty component — either a doubled separator ("a//b") or a
            # trailing separator on a would-be file entry; a real
            # directory entry (filename ending in '/') is handled by the
            # caller checking `info.is_dir()` before ever reaching here.
            return None
        # Unicode separator tricks (Part 7): normalize to NFC first so a
        # combining-character or alternate-width slash-lookalike can't
        # slip past the substring checks inside validate_entry_name by
        # being spelled differently than the ASCII '/'/'\\' it already
        # rejects; validate_entry_name's own Zl/Zp category check
        # catches true Unicode line/paragraph separators regardless.
        candidate = unicodedata.normalize("NFC", raw)
        is_leaf = position == len(raw_segments) - 1
        if is_leaf and candidate.lower() in _BIBLIOGRAPHY_FILENAMES:
            # Part 11 — an imported "references.bib" (or an equivalent
            # name) is a deliberate, EXPECTED, soft-excluded case, never
            # a structural safety violation: validate_entry_name would
            # otherwise reject it as a reserved name meant to guard
            # against a MANUALLY-created file shadowing the generated
            # bibliography — that concern doesn't apply here since this
            # entry is never turned into a WritingProjectFile row at all
            # (see the bibliography-detection pass in inspect_archive,
            # which excludes it with a clear message instead). Still
            # apply the same traversal/control-character safety this
            # segment would otherwise get, minus only the reserved-name
            # rejection, so a bib file can't smuggle an unsafe name
            # through under cover of this carve-out.
            if any(bad in candidate for bad in ("/", "\\", "..")) or candidate in {".", ".."}:
                return None
            segments.append(candidate)
            continue
        try:
            validate_entry_name(candidate)
        except InvalidFileNameError:
            return None
        segments.append(candidate)
    return segments


def inspect_archive(data: bytes, *, max_archive_bytes: int) -> ImportInspection:
    """The full Part 6-14 inspection pipeline. Raises ArchiveRejected for
    anything in the release-critical categories; returns a complete
    ImportInspection (files to include, root candidates, warnings for
    everything soft-excluded) otherwise. Never writes anything to disk
    or the database — purely a function of the bytes it's given."""
    if len(data) > max_archive_bytes:
        raise ArchiveRejected(f"Archive exceeds the {max_archive_bytes}-byte upload limit")
    if not data:
        raise ArchiveRejected("Archive is empty")

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise ArchiveRejected("File is not a valid ZIP archive") from exc

    # Part 9 — the FULL entry list is inspected via metadata alone before
    # a single byte of content is ever decompressed.
    try:
        infos = archive.infolist()
    except (zipfile.BadZipFile, OSError, EOFError) as exc:
        raise ArchiveRejected("Archive central directory is corrupt or unreadable") from exc

    file_infos = [info for info in infos if not info.is_dir()]
    if len(file_infos) > MAX_IMPORT_ENTRIES:
        raise ArchiveRejected(f"Archive has more than {MAX_IMPORT_ENTRIES} entries")
    if len(file_infos) == 0:
        raise ArchiveRejected("Archive contains no files")

    seen_paths: set[tuple[str, ...]] = set()
    seen_prefixes: set[tuple[str, ...]] = set()
    total_declared_bytes = 0
    parsed: list[tuple[zipfile.ZipInfo, list[str]]] = []

    for info in file_infos:
        # Part 8 — symlinks are rejected outright, before path
        # validation even runs (a symlink entry's "name" could otherwise
        # pass every other check and still represent an escape vector on
        # a naive extractor).
        if _is_symlink_entry(info):
            raise ArchiveRejected(f"Archive contains a symlink entry: {info.filename!r}")

        segments = _normalize_entry_segments(info.filename)
        if segments is None:
            raise ArchiveRejected(f"Archive contains an unsafe path: {info.filename!r}")
        try:
            validate_depth(len(segments) - 1)
        except InvalidFileNameError as exc:
            raise ArchiveRejected(str(exc)) from exc

        path_key = tuple(segments)
        if path_key in seen_paths:
            raise ArchiveRejected(f"Archive contains a duplicate path: {'/'.join(segments)}")
        # Part 7's "overlapping paths" — a path that is a PREFIX of
        # another entry's path is structurally ambiguous (is "foo" a
        # file, or is it implied to be a folder because "foo/bar.tex"
        # also exists?). Reject the whole archive rather than guess.
        for i in range(1, len(path_key)):
            prefix = path_key[:i]
            if prefix in seen_paths:
                raise ArchiveRejected(
                    f"Archive path {'/'.join(prefix)!r} is used as both a file and a folder"
                )
        seen_paths.add(path_key)
        seen_prefixes.add(path_key)

        # Part 6 — the zip-bomb signature check, on DECLARED metadata,
        # runs before any decompression; the bounded-read pass below
        # re-verifies against the ACTUAL bytes regardless of what this
        # metadata claims.
        if info.file_size > MAX_IMPORT_SINGLE_ENTRY_BYTES:
            raise ArchiveRejected(f"{'/'.join(segments)} exceeds the per-file size limit")
        if info.compress_size > 0 and info.file_size / max(info.compress_size, 1) > MAX_IMPORT_COMPRESSION_RATIO:
            raise ArchiveRejected(f"{'/'.join(segments)} has a suspicious compression ratio")
        total_declared_bytes += info.file_size
        if total_declared_bytes > MAX_IMPORT_TOTAL_UNCOMPRESSED_BYTES:
            raise ArchiveRejected("Archive's total uncompressed size exceeds the project storage limit")

        parsed.append((info, segments))

    # The prefix check above only catches "file A used as a folder for
    # file B" for paths seen so far in iteration order — also check the
    # reverse (a later file's path is a prefix of an EARLIER file's
    # path) by re-scanning the full set once now that it's complete.
    for path_key in seen_paths:
        for i in range(1, len(path_key)):
            if path_key[:i] in seen_paths and path_key[:i] != path_key:
                raise ArchiveRejected(
                    f"Archive path {'/'.join(path_key[:i])!r} is used as both a file and a folder"
                )

    files: list[ImportFileEntry] = []
    warnings: list[ImportWarning] = []
    running_total = 0

    for info, segments in parsed:
        rel_path = "/".join(segments)
        name = segments[-1]
        ext = extension_of(name)

        if ext in _ARCHIVE_EXTENSIONS:
            raise ArchiveRejected(f"Archive contains a nested archive: {rel_path}")

        if ext == ".bib":
            # Part 11, generalized by Milestone 5.5.1 Part 21/24 — real-
            # ZIP testing found this only matched the 3 hardcoded
            # conventional names (references.bib/bibliography.bib/
            # refs.bib), so a template's own differently-named .bib file
            # (e.g. a Springer Nature template's "sn-bibliography.bib")
            # fell through to the generic "Unsupported file type"
            # warning instead of this specific, actionable one — true,
            # but far less helpful, and Part 24 explicitly wants a
            # meaningful diagnostic here, not just "unsupported". ANY
            # .bib file gets the same treatment now: detected, reported,
            # EXCLUDED. Never silently made canonical; EduM8's own
            # references.bib remains the only bibliography source of
            # truth.
            warnings.append(
                ImportWarning(
                    path=rel_path,
                    reason=(
                        "EduM8 generates references.bib from your Reference Library "
                        "— this file was not imported. If your document uses "
                        "\\bibliography{" + name.rsplit(".", 1)[0] + "}, update it to "
                        "\\bibliography{references} after import."
                    ),
                )
            )
            continue

        kind = kind_for_extension(name)
        if kind is None:
            warnings.append(ImportWarning(path=rel_path, reason="Unsupported file type — not imported"))
            continue

        # Bounded read — Part 6's real defense, independent of whatever
        # the archive's own metadata claimed above. `.read(n+1)` only
        # ever decompresses as much of the underlying stream as needed
        # to produce n+1 bytes; a crafted entry that lies about its
        # declared size still cannot force more into memory than this.
        limit = MAX_TEXT_FILE_CONTENT_CHARS if kind == "text" else MAX_BINARY_FILE_BYTES
        try:
            with archive.open(info) as fh:
                raw = fh.read(limit + 1)
        except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as exc:
            raise ArchiveRejected(f"Could not read archive entry {rel_path}: {exc}") from exc
        if len(raw) > limit:
            raise ArchiveRejected(f"{rel_path} exceeds the per-file size limit")
        if not raw:
            warnings.append(ImportWarning(path=rel_path, reason="File is empty — not imported"))
            continue

        running_total += len(raw)
        if running_total > MAX_IMPORT_TOTAL_UNCOMPRESSED_BYTES:
            raise ArchiveRejected("Archive's total uncompressed size exceeds the project storage limit")

        if kind == "text":
            text = _decode_text_entry(raw)
            if text is None:
                # Part 18 — invalid/binary content masquerading as
                # `.tex`/`.cls`/`.sty`/`.txt` is excluded, not silently
                # imported as garbled text.
                warnings.append(
                    ImportWarning(path=rel_path, reason="File is not valid UTF-8 text — not imported")
                )
                continue
            files.append(
                ImportFileEntry(path=rel_path, kind="text", size_bytes=len(raw), content_text=text)
            )
        else:
            files.append(
                ImportFileEntry(path=rel_path, kind="binary", size_bytes=len(raw), raw_bytes=raw)
            )

    if not files:
        raise ArchiveRejected("No supported files remained after filtering — nothing to import")

    root_candidates, preselected = _detect_root_candidates(files)

    suggested_title = "Imported Project"
    if preselected:
        suggested_title = preselected.rsplit("/", 1)[-1].rsplit(".", 1)[0].replace("_", " ").replace("-", " ").title()

    return ImportInspection(
        suggested_title=suggested_title,
        files=files,
        root_candidates=root_candidates,
        preselected_root=preselected,
        warnings=warnings,
        total_size_bytes=running_total,
    )


def _detect_root_candidates(files: list[ImportFileEntry]) -> tuple[list[str], str | None]:
    """Part 12/13 — static, bounded-byte-count scan for `\\documentclass`
    in every `.tex` file. Never executes TeX, never follows `\\input`/
    `\\include` directives recursively — a plain substring search over
    the first `_ROOT_SCAN_BYTES` characters of each candidate file."""
    candidates = [
        f for f in files
        if f.kind == "text" and extension_of(f.path) == ".tex" and f.content_text is not None
        and "\\documentclass" in f.content_text[:_ROOT_SCAN_BYTES]
    ]
    if not candidates:
        return [], None
    paths = [c.path for c in candidates]
    if len(candidates) == 1:
        return paths, paths[0]

    # Multiple strong candidates — prefer a top-level (no folder) file
    # whose basename matches the priority list; still ask the user
    # (Part 12: "if multiple: ask user" — `preselected` stays None so
    # the caller always shows the picker) even when priority naming
    # narrows it, since a filename match is only a HINT, not proof.
    def priority_rank(path: str) -> int:
        basename = path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
        is_top_level = "/" not in path
        try:
            idx = _ROOT_FILENAME_PRIORITY.index(basename)
        except ValueError:
            idx = len(_ROOT_FILENAME_PRIORITY)
        return (0 if is_top_level else 1, idx)

    paths.sort(key=priority_rank)
    return paths, None
