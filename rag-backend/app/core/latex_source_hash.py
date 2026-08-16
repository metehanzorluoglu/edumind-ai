"""Milestone 5.1 Part 34/35 — a deterministic hash over a Writing
Project's full compile input (main.tex + the currently-generated
references.bib), so the frontend can tell "preview is current" from
"source changed since last compile" WITHOUT a full version-history
subsystem (Part 34's own explicit guidance: "a content hash is
acceptable"). Deliberately covers the bibliography text too, not just
main_tex_content — a referenced Document's metadata can change enough to
alter the generated bibliography (Milestone 4.1) even when the
manuscript's own saved text hasn't, and that should also count as
"source changed" for compile-freshness purposes."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping


def compute_source_hash(
    main_tex_content: str,
    bibtex_text: str,
    extra_files: Mapping[str, bytes] | None = None,
) -> str:
    """Never used for anything security-sensitive (not a signature, not
    an integrity check against tampering) — purely a cheap client-side
    "did anything change" signal, so plain sha256 over the UTF-8 bytes
    with an explicit separator (avoids the degenerate case where
    `"ab" + "c" == "a" + "bc"` could coincidentally collide two distinct
    (main_tex, bib) pairs onto the same hash) is more than sufficient.

    Milestone 5.3 Part 40 — `extra_files` folds every OTHER
    compile-relevant project file (additional `.tex` sources, `.cls`/
    `.sty`, figure/PDF assets) into the same hash, keyed by their
    relative path and sorted for determinism (dict iteration order is
    not something this function should depend on) — so renaming a file,
    editing a secondary `.tex` source, or uploading a new figure all
    correctly mark a cached preview stale, exactly like editing
    main_tex_content already did before this milestone. Conservative by
    design (Part 40: "changing an unused/noncompile file may still
    mark stale if simpler") — this hashes every project file the
    compile snapshot actually includes, never a filtered "only files
    reachable via \\input" subset, which would require parsing LaTeX to
    get exactly right and could under-invalidate on a mistake."""
    hasher = hashlib.sha256()
    hasher.update(main_tex_content.encode("utf-8"))
    hasher.update(b"\x00")
    hasher.update(bibtex_text.encode("utf-8"))
    for path in sorted(extra_files or {}):
        hasher.update(b"\x00")
        hasher.update(path.encode("utf-8"))
        hasher.update(b"\x00")
        hasher.update(extra_files[path])
    return hasher.hexdigest()
