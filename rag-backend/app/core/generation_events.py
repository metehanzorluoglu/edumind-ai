"""Tagged updates a generation worker can emit — used only by the batched
vision pipeline (app/services/vision_batch_orchestrator.py) and its
generation_manager.py counterpart (run_batched_vision_generation /
poll_batched_vision). The plain single-shot text/vision workers
(run_text_generation / run_vision_generation) still deal in plain `str`
tokens only and are untouched by this module — this exists because the
batched pipeline is the first generator in this codebase that needs to
report something *other* than answer text while it works (per-batch
progress, e.g. "Analyzing pages 9-16 of 47…"), and a tagged union is the
smallest change that adds that without touching the existing plain-`str`
contract anywhere else.

A tiny dataclass pair rather than a two-tuple or a dict: mypy can
exhaustively narrow `isinstance(update, GenToken)` in a way it cannot for
an untyped tuple/dict shape, and every call site below reads clearly
without a comment explaining what index 0 vs. 1 means.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class GenToken:
    """A chunk of the real, user-facing answer — identical in meaning to
    the plain `str` the older single-shot workers yield."""

    text: str


@dataclass(frozen=True)
class GenProgress:
    """A human-readable, truthful status update about work still in
    progress — never part of the persisted answer. `detail` is shown
    verbatim to the user (see ChatProgressEvent.detail in
    app/schemas/chat.py) — e.g. "Analyzing pages 9-16 of 47…" or
    "Combining findings…" — so it must always be a complete, presentable
    sentence fragment, never a code or enum value."""

    detail: str


GenerationUpdate = GenToken | GenProgress
