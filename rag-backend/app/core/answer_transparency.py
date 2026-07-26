"""Assembles "How this answer was prepared" (research workspace milestone)
— a snapshot of exactly what fed into one chat turn: which retrieval
scopes were active, which documents were actually cited, which approved
Project Memory summaries and Project Profile fields contributed
background context. Persisted verbatim on the assistant Message row (see
Message.transparency) so a reopened past answer keeps showing what was
true *then*, not the conversation's current settings.

NEVER: `project_summaries_used` is a completely separate list from
`documents_used`/citations — an approved summary is never folded into the
citation-backed sources list, so a frontend rendering this can never
present it as if it were primary evidence (it renders with a distinct
"Project Context" label instead — see app/core/project_context.py and the
frontend's SourceCard component).
"""

from dataclasses import dataclass

from app.core.retrieval_schemas import RetrievedChunk
from app.db.project_knowledge_repository import ProjectKnowledgeRecord
from app.db.project_profile_repository import ProjectProfileRecord

_PROFILE_FIELDS: tuple[str, ...] = (
    "research_questions",
    "frameworks",
    "methodology",
    "participants",
    "data",
    "analysis",
    "citation_style",
    "output_format",
)


@dataclass(frozen=True)
class RetrievalScopeSnapshot:
    chat: bool
    project: bool
    general: bool
    other_projects: bool


@dataclass(frozen=True)
class DocumentUsed:
    document_id: str
    source_filename: str


@dataclass(frozen=True)
class ProjectSummaryUsed:
    id: str
    research_topic: str
    conversation_title: str | None


@dataclass(frozen=True)
class TransparencySnapshot:
    retrieval_scope: RetrievalScopeSnapshot
    documents_used: list[DocumentUsed]
    project_summaries_used: list[ProjectSummaryUsed]
    profile_fields_used: list[str]


def _documents_used(sources: list[RetrievedChunk]) -> list[DocumentUsed]:
    seen: dict[str, str] = {}
    for chunk in sources:
        if chunk.document_id not in seen:
            seen[chunk.document_id] = chunk.source_filename
    return [
        DocumentUsed(document_id=document_id, source_filename=source_filename)
        for document_id, source_filename in seen.items()
    ]


def _profile_fields_used(profiles: list[ProjectProfileRecord]) -> list[str]:
    used: list[str] = []
    for profile in profiles:
        for field_name in _PROFILE_FIELDS:
            value = getattr(profile, field_name)
            if value and field_name not in used:
                used.append(field_name)
    return used


def build_transparency_snapshot(
    *,
    chat_enabled: bool,
    project_enabled: bool,
    general_enabled: bool,
    include_other_project_summaries: bool,
    sources: list[RetrievedChunk],
    approved_items: list[ProjectKnowledgeRecord],
    profiles: list[ProjectProfileRecord],
) -> TransparencySnapshot:
    return TransparencySnapshot(
        retrieval_scope=RetrievalScopeSnapshot(
            chat=chat_enabled,
            project=project_enabled,
            general=general_enabled,
            other_projects=include_other_project_summaries,
        ),
        documents_used=_documents_used(sources),
        project_summaries_used=[
            ProjectSummaryUsed(
                id=str(item.id),
                research_topic=item.research_topic,
                conversation_title=item.conversation_title,
            )
            for item in approved_items
        ],
        profile_fields_used=_profile_fields_used(profiles),
    )


def transparency_to_dict(snapshot: TransparencySnapshot) -> dict[str, object]:
    """JSON-serializable form for persistence on Message.transparency and
    for the ChatDoneEvent SSE payload — one place decides the on-the-wire
    shape so storage and the live stream can never drift."""
    return {
        "retrieval_scope": {
            "chat": snapshot.retrieval_scope.chat,
            "project": snapshot.retrieval_scope.project,
            "general": snapshot.retrieval_scope.general,
            "other_projects": snapshot.retrieval_scope.other_projects,
        },
        "documents_used": [
            {"document_id": doc.document_id, "source_filename": doc.source_filename}
            for doc in snapshot.documents_used
        ],
        "project_summaries_used": [
            {
                "id": item.id,
                "research_topic": item.research_topic,
                "conversation_title": item.conversation_title,
            }
            for item in snapshot.project_summaries_used
        ],
        "profile_fields_used": list(snapshot.profile_fields_used),
    }


_EMPTY_RETRIEVAL_SCOPE: dict[str, object] = {
    "chat": True,
    "project": True,
    "general": True,
    "other_projects": False,
}


def transparency_from_dict(data: dict[str, object]) -> dict[str, object]:
    """Normalizes a persisted/legacy Message.transparency value (possibly
    `{}` for a message sent before this column existed) into the full
    on-the-wire shape, so every caller can render it uniformly."""
    if not data:
        return {
            "retrieval_scope": dict(_EMPTY_RETRIEVAL_SCOPE),
            "documents_used": [],
            "project_summaries_used": [],
            "profile_fields_used": [],
        }
    return data
