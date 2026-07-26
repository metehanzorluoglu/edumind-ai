"""Formats approved Project Memory items (see
app/db/models_project_knowledge.py) and a project's Research Profile (see
app/db/models_research_preferences.py) into the "Project Context" block a
chat prompt receives — structurally separate from the numbered <source>
block built by app/core/prompt_builder.py/vision_prompt_builder.py. This is
the one place that decides what either looks like to the model; both prompt
builders call it, so the two pipelines can never drift on the format or on
the "never citable" framing.
"""

from app.db.project_knowledge_repository import ProjectKnowledgeRecord
from app.db.project_profile_repository import ProjectProfileRecord

_FIELD_LABELS: tuple[tuple[str, str], ...] = (
    ("research_topic", "Research topic"),
    ("research_question", "Research question"),
    ("methodology", "Methodology"),
)
_LIST_FIELD_LABELS: tuple[tuple[str, str], ...] = (
    ("key_concepts", "Key concepts"),
    ("frameworks", "Frameworks"),
    ("analysis_techniques", "Analysis techniques"),
    ("decisions", "Decisions"),
    ("open_questions", "Open questions"),
    ("keywords", "Keywords"),
)

_PROFILE_LIST_FIELD_LABELS: tuple[tuple[str, str], ...] = (
    ("research_questions", "Research questions"),
    ("frameworks", "Frameworks"),
    ("methodology", "Methodology"),
    ("analysis", "Analysis"),
)
_PROFILE_STRING_FIELD_LABELS: tuple[tuple[str, str], ...] = (
    ("participants", "Participants"),
    ("data", "Data"),
    ("citation_style", "Citation style"),
    ("output_format", "Output format"),
)


def _format_item(item: ProjectKnowledgeRecord, index: int) -> str:
    conversation_label = item.conversation_title or "untitled"
    lines = [f"Project memory {index} (from conversation: {conversation_label}):"]
    for field, label in _FIELD_LABELS:
        value = getattr(item, field)
        if value:
            lines.append(f"- {label}: {value}")
    for field, label in _LIST_FIELD_LABELS:
        values: list[str] = getattr(item, field)
        if values:
            lines.append(f"- {label}: {', '.join(values)}")
    return "\n".join(lines)


def _format_profile(profile: ProjectProfileRecord) -> str | None:
    """None if every field is still empty (a freshly get-or-created
    profile the user hasn't touched or confirmed anything into yet) — the
    common case for a new project, so callers never add an empty
    "Research profile:" block with nothing under it."""
    lines: list[str] = []
    for field, label in _PROFILE_LIST_FIELD_LABELS:
        values: list[str] = getattr(profile, field)
        if values:
            lines.append(f"- {label}: {', '.join(values)}")
    for field, label in _PROFILE_STRING_FIELD_LABELS:
        value: str = getattr(profile, field)
        if value:
            lines.append(f"- {label}: {value}")
    if not lines:
        return None
    return "\n".join(["Research profile (user-confirmed preferences for this project):", *lines])


def format_project_context(
    items: list[ProjectKnowledgeRecord], profiles: list[ProjectProfileRecord] | None = None
) -> str | None:
    """Returns None only when there is truly nothing to show (no approved
    Project Memory and no non-empty profile) so callers can skip adding a
    <project_context> block entirely rather than sending an empty one.
    Callers are expected to have already filtered `items` to
    status == "approved" (see
    ProjectKnowledgeRepository.list_approved_for_projects/
    list_approved_for_user) — this function does not re-check status
    itself. `profiles` is one entry per project a conversation is scoped
    to (omitted entirely for "general chat" — a conversation in zero
    projects has no specific project's profile to show, only pooled
    approved summaries)."""
    blocks = [_format_item(item, index) for index, item in enumerate(items, start=1)]
    for profile in profiles or []:
        formatted = _format_profile(profile)
        if formatted:
            blocks.append(formatted)
    if not blocks:
        return None
    return "\n\n".join(blocks)
