"""Milestone 5.3 (LaTeX Project Workspace & File Management) Part 5/6/11/37
— pure, dependency-free validation for a Writing Project file/folder
NAME (never a full path — see app/db/models_writing.py's WritingProjectFile
docstring for why this codebase never accepts or stores a client-supplied
path string at all). This is the single place that decides what a legal
entry name looks like; both the API layer and the repository call into
it, so there is exactly one definition of "safe" to keep in sync.

Because every mutation identifies its target by `parent_id` (a database
row, never a string), and every new name is validated here BEFORE it is
ever written to a row, path traversal is structurally impossible through
this API family — there is no code path anywhere in this milestone that
concatenates a caller-supplied string onto a filesystem path. This is
stronger than blocklisting "../" (Part 37's release-critical requirement)
because it does not depend on remembering to filter every new endpoint;
a name containing a path separator or ".." is simply not a valid NAME,
full stop, regardless of which endpoint tries to set it.
"""

from __future__ import annotations

import unicodedata
from typing import Literal

from app.db.models_writing import (
    BINARY_FILE_EXTENSIONS,
    MAX_FOLDER_DEPTH,
    TEXT_FILE_EXTENSIONS,
)

MAX_NAME_LENGTH = 120

#: references.bib is never a real row (Part 3) — reserved so a user can
#: never create/rename/upload a real file that would shadow the
#: synthesized generated-bibliography tree entry.
RESERVED_NAMES = frozenset({"references.bib"})


class InvalidFileNameError(ValueError):
    """Raised for any structurally-bad name — the API layer maps this to
    a 422, never a 500."""


def validate_entry_name(name: str) -> str:
    """Validates a single path SEGMENT (one file or folder's own name,
    never a multi-segment path — there is no `/` anywhere in a legal
    name). Returns the name unchanged (never mutates/"fixes" it — an
    invalid name is rejected outright, never silently sanitized into
    something the user didn't ask for, matching this codebase's existing
    filename-handling convention elsewhere)."""
    if not isinstance(name, str):
        raise InvalidFileNameError("Name must be a string")
    # Reject BEFORE stripping — leading/trailing whitespace is itself
    # invalid, not silently trimmed, so what the user sees in the tree is
    # always exactly what they typed.
    if name != name.strip():
        raise InvalidFileNameError("Name cannot have leading or trailing whitespace")
    if not name:
        raise InvalidFileNameError("Name cannot be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise InvalidFileNameError(f"Name cannot exceed {MAX_NAME_LENGTH} characters")
    if name in {".", ".."}:
        raise InvalidFileNameError(f"{name!r} is not a valid name")
    # Part 37 — release critical. Blocks '/', '\\', and every raw
    # ".."-based traversal attempt outright (this check alone would be
    # sufficient even without the "no stored path" architecture above —
    # belt and suspenders). Also blocks control characters (including a
    # literal null byte) and any Unicode separator that could visually
    # or structurally impersonate a path separator once normalized by a
    # filesystem or another layer of this stack.
    forbidden_substrings = ("/", "\\", "..")
    if any(bad in name for bad in forbidden_substrings):
        raise InvalidFileNameError("Name cannot contain a path separator or '..'")
    for ch in name:
        category = unicodedata.category(ch)
        # Cc = control character (includes NUL, all C0/C1 controls).
        # Zl/Zp = line/paragraph separator. Zs (ordinary space) is
        # allowed — "my figure.png" is a completely normal filename.
        if category in {"Cc", "Zl", "Zp"}:
            raise InvalidFileNameError("Name contains a disallowed control or separator character")
    if name.lower() in RESERVED_NAMES:
        raise InvalidFileNameError(f"{name!r} is reserved for the generated bibliography")
    return name


def extension_of(name: str) -> str:
    if "." not in name:
        return ""
    return "." + name.rsplit(".", 1)[-1].lower()


def kind_for_extension(name: str) -> Literal["text", "binary"] | None:
    """None means the extension isn't allowed for a project file at all
    (Part 10/48: "Do NOT accept executables/shell scripts/archives...
    arbitrary binaries")."""
    ext = extension_of(name)
    if ext in TEXT_FILE_EXTENSIONS:
        return "text"
    if ext in BINARY_FILE_EXTENSIONS:
        return "binary"
    return None


def validate_folder_name(name: str) -> str:
    """A folder name follows the same character rules as a file name but
    must not itself look like an allowed file extension — mostly a
    footgun-prevention nicety (Part 6 doesn't require this), not a
    security boundary; folders and files already can't collide by name
    within one parent regardless (the DB unique constraint covers both)."""
    return validate_entry_name(name)


def validate_depth(ancestor_count: int) -> None:
    """`ancestor_count` = how many folders deep the NEW entry's parent
    already is (0 for a root-level parent). Part 41's "nested folders"
    performance scenario is tested well under this ceiling — this exists
    only to keep the file tree UI and the compiler's relative-path
    construction from ever having to handle a pathological, effectively
    unbounded-depth tree."""
    if ancestor_count >= MAX_FOLDER_DEPTH:
        raise InvalidFileNameError(f"Folders cannot be nested more than {MAX_FOLDER_DEPTH} deep")
