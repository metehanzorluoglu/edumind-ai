"""Chooses which model (and whether to run retrieval at all) a chat turn
should use — the one place this decision is made, so a future endpoint
that wires up vision chat never has to re-derive it.

+------------------------+------------------+-----------------+
| Input                  | Model            | Retrieval       |
+------------------------+------------------+-----------------+
| Text only              | OLLAMA_LLM_MODEL | yes (unchanged) |
| Image(s) attached      | OLLAMA_VISION_MODEL | no           |
| Image(s) + corpus flag | OLLAMA_VISION_MODEL | yes          |
+------------------------+------------------+-----------------+

"Corpus enabled" is an explicit, caller-supplied flag (e.g. a request body
field a future vision-chat endpoint would expose) — never inferred from
whether images are present, since a user attaching a photo to ask "what is
this?" is not the same request as one attaching a photo while also asking
the assistant to cross-reference their document corpus.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelRoute:
    model: str
    use_retrieval: bool
    is_vision: bool


def choose_model(
    *,
    has_images: bool,
    corpus_enabled: bool,
    text_model: str,
    vision_model: str,
) -> ModelRoute:
    """`corpus_enabled` only ever matters when `has_images` is True — a
    text-only turn always retrieves (that is this system's existing,
    unchanged RAG behavior; the parameter is irrelevant there)."""
    if not has_images:
        return ModelRoute(model=text_model, use_retrieval=True, is_vision=False)
    return ModelRoute(model=vision_model, use_retrieval=corpus_enabled, is_vision=True)
