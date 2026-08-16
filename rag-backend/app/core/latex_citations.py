"""Milestone 5 (Academic Writing & LaTeX Foundation) Section 26/27 — a
conservative, deterministic LaTeX `\\cite{...}` parser. No LLM, no full
TeX parsing (Section 27: "Do not attempt full TeX parsing if unnecessary.
A conservative citation-command parser is sufficient for M5"). Used for
two things: flagging a citation key present in the manuscript but not in
the project's current reference list (missing-reference warning), and
marking each reference "Cited" / "Not cited" in the References panel.
"""

from __future__ import annotations

import re

# Matches \cite{Key}, \cite{Key1,Key2}, \citep{...}, \citet{...},
# \citeauthor{...}, \citeyear{...} — the handful of citation commands a
# LaTeX document conventionally uses (natbib's variants included, since
# they're common enough in academic manuscripts that only recognizing
# bare \cite would under-detect). Deliberately does NOT try to parse
# general TeX syntax, macros, or comments — a `%`-commented-out
# `\cite{...}` is still conservatively counted as "used" (Section 27: a
# conservative parser errs toward not silently missing a real citation,
# never toward asserting certainty about intent it can't verify).
_CITE_COMMAND_RE = re.compile(
    r"\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])?(?:\[[^\]]*\])?\{([^}]*)\}"
)


def parse_cite_keys(tex_content: str) -> set[str]:
    """Every citation key referenced anywhere in `tex_content`, via any
    \\cite-family command, with \\cite{KeyOne,KeyTwo} correctly split into
    two separate keys. Whitespace around each key is trimmed; an empty
    key (e.g. a stray trailing comma) is dropped rather than counted as a
    real key. Returns an empty set for content with no citation commands
    at all — never raises on malformed LaTeX, since this only ever reads
    the user's own in-progress manuscript."""
    keys: set[str] = set()
    for match in _CITE_COMMAND_RE.finditer(tex_content):
        for raw_key in match.group(1).split(","):
            key = raw_key.strip()
            if key:
                keys.add(key)
    return keys
