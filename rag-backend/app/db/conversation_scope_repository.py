"""The research workspace's per-conversation "active scope" toggle bar
(see app/db/models_conversation_scope.py) — same "404, not 403" ownership
convention as every other repository in this app.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models_conversation_scope import ConversationScopeSettings
from app.db.models_conversations import Conversation

_EDITABLE_FIELDS = frozenset(
    {"chat_enabled", "project_enabled", "general_enabled", "include_other_project_summaries"}
)


@dataclass(frozen=True)
class ConversationScopeRecord:
    conversation_id: uuid.UUID
    chat_enabled: bool
    project_enabled: bool
    general_enabled: bool
    include_other_project_summaries: bool
    updated_at: datetime


def _to_record(row: ConversationScopeSettings) -> ConversationScopeRecord:
    return ConversationScopeRecord(
        conversation_id=row.conversation_id,
        chat_enabled=row.chat_enabled,
        project_enabled=row.project_enabled,
        general_enabled=row.general_enabled,
        include_other_project_summaries=row.include_other_project_summaries,
        updated_at=row.updated_at,
    )


class ConversationScopeRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def get_or_create(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID
    ) -> ConversationScopeRecord | None:
        """Returns None if the conversation doesn't exist or isn't
        user_id's — never creates a settings row for one that fails that
        check. Every conversation has exactly one settings row always;
        this is the only place a row is ever inserted (no explicit
        "create settings" route exists)."""
        conversation = self._db.execute(
            select(Conversation).where(
                Conversation.id == conversation_id, Conversation.user_id == user_id
            )
        ).scalar_one_or_none()
        if conversation is None:
            return None

        row = self._db.get(ConversationScopeSettings, conversation_id)
        if row is None:
            row = ConversationScopeSettings(conversation_id=conversation_id)
            self._db.add(row)
            self._db.commit()
            self._db.refresh(row)
        return _to_record(row)

    def update(
        self, user_id: uuid.UUID, conversation_id: uuid.UUID, updates: dict[str, object]
    ) -> ConversationScopeRecord | None:
        """Partial update — only fields actually present in `updates` (the
        route builds this from the request's `model_fields_set`) are
        touched, same convention as every other PATCH in this app."""
        if self.get_or_create(user_id, conversation_id) is None:
            return None
        row = self._db.get(ConversationScopeSettings, conversation_id)
        assert row is not None  # just get-or-created above
        for field, value in updates.items():
            if field in _EDITABLE_FIELDS:
                setattr(row, field, value)
        self._db.commit()
        self._db.refresh(row)
        return _to_record(row)
