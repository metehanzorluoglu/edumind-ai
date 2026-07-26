"""Turns a conversation's message history into a structured Project Memory
draft (see app/db/models_project_knowledge.py) — never the raw transcript
itself. The LLM extracts the qualitative fields (topic, question, concepts,
methodology, frameworks, analysis techniques, decisions, open questions,
keywords); `referenced_documents` is deliberately NOT LLM-generated — it is
computed deterministically from the conversation's actual citation history
(MessageSource rows), so it can never hallucinate a document the
conversation didn't really cite.
"""

import json
from dataclasses import dataclass

from app.core.llm_provider import LLMProvider
from app.db.conversations_repository import MessageRecord

_SYSTEM_PROMPT = """You are a research assistant that distills a chat conversation between a \
researcher and an AI assistant into a compact, structured summary of the researcher's project \
work — for the researcher's own later reference, not as new research output.

Extract ONLY what the conversation actually discusses. Never invent a topic, question, concept, \
methodology, framework, technique, decision, or keyword that isn't genuinely present in the \
transcript. If a field has no real content in this conversation, use an empty string ("") or an \
empty list ([]) for it rather than fabricating a plausible-sounding answer.

Respond with ONLY a single JSON object — no markdown code fences, no commentary before or after \
it — with exactly these keys:

{
  "research_topic": "string — the overall subject being researched",
  "research_question": "string — the specific question(s) being investigated",
  "key_concepts": ["string", "..."],
  "methodology": "string — the research method/approach discussed, if any",
  "frameworks": ["string", "..."],
  "analysis_techniques": ["string", "..."],
  "decisions": ["string", "..."],
  "open_questions": ["string", "..."],
  "keywords": ["string", "..."]
}"""

_ROLE_LABELS = {"user": "Researcher", "assistant": "Assistant"}


class SummaryGenerationError(Exception):
    """Raised when there is nothing to summarize (an empty conversation)
    or the model's response could not be parsed into any JSON object at
    all — mapped to a 4xx in the route, never silently swallowed into an
    empty-looking summary that would then be presented for approval as if
    it were real."""


@dataclass(frozen=True)
class SummaryFields:
    research_topic: str
    research_question: str
    key_concepts: list[str]
    methodology: str
    frameworks: list[str]
    analysis_techniques: list[str]
    decisions: list[str]
    open_questions: list[str]
    keywords: list[str]
    referenced_documents: list[dict[str, str]]


def _format_transcript(messages: list[MessageRecord]) -> str:
    return "\n\n".join(
        f"{_ROLE_LABELS.get(message.role, message.role)}: {message.content}"
        for message in messages
    )


def _referenced_documents(messages: list[MessageRecord]) -> list[dict[str, str]]:
    """Every distinct document actually cited somewhere in this
    conversation, in first-cited order — read straight from the already
    denormalized MessageSource rows (see MessageSource's own docstring on
    why those are a durable snapshot even after a document is deleted),
    never re-derived from the model's output."""
    seen: dict[str, str] = {}
    for message in messages:
        for source in message.sources:
            if source.document_id and source.document_id not in seen:
                seen[source.document_id] = source.source_filename
    return [
        {"document_id": document_id, "source_filename": source_filename}
        for document_id, source_filename in seen.items()
    ]


def _extract_json_object(raw_text: str) -> dict[str, object]:
    """Lenient JSON extraction: tries decoding starting from every `{` in
    the text (in order) rather than requiring the whole response to be
    pure JSON, since a model can still preface/wrap its answer with a
    stray word or markdown fence despite instructions. Raises
    SummaryGenerationError only if no `{` in the text ever starts a valid
    JSON object."""
    decoder = json.JSONDecoder()
    index = raw_text.find("{")
    while index != -1:
        try:
            candidate, _ = decoder.raw_decode(raw_text, index)
            if isinstance(candidate, dict):
                return candidate
        except ValueError:
            pass
        index = raw_text.find("{", index + 1)
    raise SummaryGenerationError("The model did not return a parseable summary. Try again.")


def _coerce_str(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _coerce_str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def generate_conversation_summary(
    llm_provider: LLMProvider, messages: list[MessageRecord]
) -> SummaryFields:
    """Raises SummaryGenerationError for an empty conversation (nothing to
    summarize) or an unparseable model response; propagates
    app.core.errors.LLMProviderError unchanged if the LLM call itself
    fails (same error type the chat pipeline already surfaces)."""
    if not messages:
        raise SummaryGenerationError("This conversation has no messages to summarize yet.")

    user_prompt = (
        f"Conversation transcript:\n\n{_format_transcript(messages)}\n\n"
        "Respond with only the JSON object described in the system prompt."
    )
    raw_text = "".join(
        llm_provider.stream_chat(system_prompt=_SYSTEM_PROMPT, user_prompt=user_prompt)
    )
    payload = _extract_json_object(raw_text)

    return SummaryFields(
        research_topic=_coerce_str(payload.get("research_topic")),
        research_question=_coerce_str(payload.get("research_question")),
        key_concepts=_coerce_str_list(payload.get("key_concepts")),
        methodology=_coerce_str(payload.get("methodology")),
        frameworks=_coerce_str_list(payload.get("frameworks")),
        analysis_techniques=_coerce_str_list(payload.get("analysis_techniques")),
        decisions=_coerce_str_list(payload.get("decisions")),
        open_questions=_coerce_str_list(payload.get("open_questions")),
        keywords=_coerce_str_list(payload.get("keywords")),
        referenced_documents=_referenced_documents(messages),
    )
