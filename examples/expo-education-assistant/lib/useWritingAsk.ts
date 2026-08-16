import {
  displaySourceFromRetrievedChunk,
  type Citation,
  type DisplaySource,
  type EducationAssistantClient,
  type NotebookEntry,
} from 'education-assistant-client';
import { useCallback, useMemo, useRef, useState } from 'react';
import { generateClientMessageId } from '@/lib/clientMessageId';
import {
  buildTransientContextPrefix,
  transientEntryFromNotebookEntry,
  type TransientAIContextEntry,
} from '@/lib/transientAIContext';

/**
 * Milestone 5.2 Part 4 — the three research-context scopes Ask EduM8 can
 * be limited to inside a Writing project. Deliberately never a fourth
 * "whole library" option (Part 12: "Never silently broaden ... to the
 * entire library") — a researcher who genuinely wants that can already
 * get it from the ordinary global chat entry points.
 */
export type WritingAskScopeKind = 'project-references' | 'selected-sources' | 'research-notes';

export function writingAskScopeLabel(
  kind: WritingAskScopeKind,
  activeDocumentIds: string[],
  noteEntries: NotebookEntry[]
): string {
  switch (kind) {
    case 'project-references': {
      const n = activeDocumentIds.length;
      return `Project references · ${n} source${n === 1 ? '' : 's'}`;
    }
    case 'selected-sources': {
      const n = activeDocumentIds.length;
      return `Selected sources · ${n}`;
    }
    case 'research-notes': {
      const n = noteEntries.length;
      return `${n} Research Note${n === 1 ? '' : 's'}`;
    }
  }
}

export interface WritingAskTurn {
  id: string;
  question: string;
  /** What was actually folded into the question as transient context —
   * shown alongside the turn so the researcher can see exactly what the
   * model was given (Part 12's transparency requirement extended to the
   * turn history, not just the composer). */
  transientEntries: TransientAIContextEntry[];
  scopeLabel: string;
  status: 'sending' | 'success' | 'error';
  answer: string;
  sources: DisplaySource[];
  citations: Citation[];
  citationWarnings: string[];
  insufficientEvidence: boolean;
  errorMessage: string | null;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function uniqueDocumentIds(entries: readonly NotebookEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) if (entry.document_id) ids.add(entry.document_id);
  return Array.from(ids);
}

export interface UseWritingAskResult {
  scopeKind: WritingAskScopeKind;
  selectedSourceIds: string[];
  selectedNoteEntries: NotebookEntry[];
  /** The document_ids actually in effect for the CURRENT scope — the one
   * source of truth the research-context indicator (Part 12) and the
   * send-time RAG scoping both read from. */
  activeDocumentIds: string[];
  scopeLabel: string;
  /** False when the active scope has nothing to search — Project
   * References/Selected Sources both require at least one document;
   * Research Notes requires at least one selected entry (Part 13: an
   * empty scope is refused up front rather than silently widened). */
  canAsk: boolean;
  setProjectReferencesScope: () => void;
  setSelectedSourcesScope: (documentIds: string[]) => void;
  setResearchNotesScope: (entries: NotebookEntry[]) => void;
  turns: WritingAskTurn[];
  asking: boolean;
  ask: (question: string, manuscriptSelection?: TransientAIContextEntry | null) => Promise<void>;
  /** Clears the turn history and lets the next ask() lazily create a
   * fresh conversation — never reuses stale evidence across an
   * unrelated line of inquiry the researcher explicitly restarts. */
  resetThread: () => void;
}

/**
 * Milestone 5.2 — the Writing workspace's "Ask EduM8" orchestration.
 * Deliberately composes the EXISTING conversation primitives
 * (createConversation / replaceConversationDocuments /
 * updateConversationScope(zoomInMode) / postConversationMessage) rather
 * than a new endpoint (Part 1: "DO NOT create another RAG system") —
 * these are the exact same calls chat/new.tsx's runFirstMessage already
 * makes, in the exact same order (documents PUT, then scope PATCH,
 * BEFORE the message that depends on them — see that function's own
 * comments for why: zoom_in_mode=true reads the CURRENTLY persisted
 * document selection, so it must land second).
 *
 * Uses the buffered postConversationMessage (not the SSE streaming
 * path) rather than useConversationMessages: Writing's evidence-first
 * UI (Part 5) renders a finished answer + Evidence block together, not
 * a token-by-token typing effect, so there is nothing streaming buys
 * here — and staying off that hook avoids ever mounting it against a
 * not-yet-created conversation id (which would fire a doomed GET on
 * every Ask EduM8 panel open). One conversation is created lazily on
 * the FIRST question and reused for the rest of the Writing session
 * (Part 16: avoid N+1 — a fresh conversation per question would mean a
 * fresh create+scope round-trip every time).
 *
 * `projectReferenceDocumentIds` is owned by the CALLER (the Writing
 * screen's already-loaded referencesState — see writing/[id].tsx) and
 * passed in fresh every render, never independently fetched here (Part
 * 16: no second parallel fetch of the same data) — this is what backs
 * the default "Project References" scope, and always reflects the
 * project's CURRENT reference list, including references added mid
 * Ask-EduM8-session via "Add reference" (Part 7).
 */
export function useWritingAsk(
  client: EducationAssistantClient,
  projectReferenceDocumentIds: string[]
): UseWritingAskResult {
  const [scopeKind, setScopeKind] = useState<WritingAskScopeKind>('project-references');
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedNoteEntries, setSelectedNoteEntries] = useState<NotebookEntry[]>([]);
  const [turns, setTurns] = useState<WritingAskTurn[]>([]);
  const [asking, setAsking] = useState(false);

  // Lazily created on the first ask() — never at panel-open time, so
  // opening the panel and never asking anything creates zero backend
  // state (Part 16).
  const conversationIdRef = useRef<string | null>(null);
  // What was last PUT/PATCHed onto that conversation, so an unchanged
  // scope across consecutive questions never re-issues the same two
  // requests (Part 16's "avoid N+1" applied to scope sync, not just
  // reference loading).
  const lastSyncedRef = useRef<{ documentIds: string[]; zoomIn: boolean } | null>(null);

  const activeDocumentIds = useMemo(() => {
    switch (scopeKind) {
      case 'project-references':
        return projectReferenceDocumentIds;
      case 'selected-sources':
        return selectedSourceIds;
      case 'research-notes':
        return uniqueDocumentIds(selectedNoteEntries);
    }
  }, [scopeKind, projectReferenceDocumentIds, selectedSourceIds, selectedNoteEntries]);

  const setProjectReferencesScope = useCallback((): void => {
    setScopeKind('project-references');
  }, []);

  const setSelectedSourcesScope = useCallback((documentIds: string[]): void => {
    setScopeKind('selected-sources');
    setSelectedSourceIds(documentIds);
  }, []);

  const setResearchNotesScope = useCallback((entries: NotebookEntry[]): void => {
    setScopeKind('research-notes');
    setSelectedNoteEntries(entries);
  }, []);

  const scopeLabel = writingAskScopeLabel(scopeKind, activeDocumentIds, selectedNoteEntries);

  // Part 12/13: Research Notes intentionally does NOT require its
  // entries to have a backing document (a manual, no-source note is
  // still valid evidence text) — mirrors the Notebook's own existing
  // multi-select "Ask EduM8" precedent (notes/[id].tsx's
  // handleAskAboutSelected), which folds every selected entry in as
  // transient context regardless of whether any of them narrow
  // retrieval. Project References/Selected Sources are real RAG scopes
  // with no such fallback — an empty set there means "search nothing,"
  // never "search everything."
  const canAsk =
    scopeKind === 'research-notes' ? selectedNoteEntries.length > 0 : activeDocumentIds.length > 0;

  const resetThread = useCallback((): void => {
    conversationIdRef.current = null;
    lastSyncedRef.current = null;
    setTurns([]);
  }, []);

  const ask = useCallback(
    async (
      question: string,
      manuscriptSelection?: TransientAIContextEntry | null
    ): Promise<void> => {
      const trimmed = question.trim();
      if (!trimmed || asking || !canAsk) return;

      const noteContextEntries =
        scopeKind === 'research-notes'
          ? selectedNoteEntries.map(transientEntryFromNotebookEntry)
          : [];
      const transientEntries: TransientAIContextEntry[] = manuscriptSelection
        ? [manuscriptSelection, ...noteContextEntries]
        : noteContextEntries;
      const prefix = buildTransientContextPrefix(transientEntries);
      const fullQuery = `${prefix}${trimmed}`;

      const turnId = generateClientMessageId();
      setTurns((prev) => [
        ...prev,
        {
          id: turnId,
          question: trimmed,
          transientEntries,
          scopeLabel,
          status: 'sending',
          answer: '',
          sources: [],
          citations: [],
          citationWarnings: [],
          insufficientEvidence: false,
          errorMessage: null,
        },
      ]);
      setAsking(true);

      function fail(message: string): void {
        setTurns((prev) =>
          prev.map((t) => (t.id === turnId ? { ...t, status: 'error', errorMessage: message } : t))
        );
      }

      try {
        let conversationId = conversationIdRef.current;
        if (!conversationId) {
          const created = await client.createConversation();
          conversationId = created.id;
          conversationIdRef.current = conversationId;
        }

        // Research Notes with zero backing documents (all-manual
        // selection) never forces zoom-in — see canAsk's own comment.
        // Every other case here has already been guarded by canAsk to
        // have at least one document.
        const zoomIn = activeDocumentIds.length > 0;
        const previouslySynced = lastSyncedRef.current;
        const scopeChanged =
          !previouslySynced ||
          previouslySynced.zoomIn !== zoomIn ||
          !sameIds(previouslySynced.documentIds, activeDocumentIds);

        if (scopeChanged) {
          if (activeDocumentIds.length > 0) {
            await client.replaceConversationDocuments(conversationId, activeDocumentIds);
          }
          if (zoomIn) {
            await client.updateConversationScope(conversationId, { zoomInMode: true });
          }
          lastSyncedRef.current = { documentIds: activeDocumentIds, zoomIn };
        }

        const result = await client.postConversationMessage(conversationId, {
          query: fullQuery,
          client_message_id: turnId,
        });

        setTurns((prev) =>
          prev.map((t) =>
            t.id === turnId
              ? {
                  ...t,
                  status: 'success',
                  answer: result.answer,
                  sources: result.sources.map(displaySourceFromRetrievedChunk),
                  citations: result.citations,
                  citationWarnings: result.citationWarnings,
                  insufficientEvidence: result.insufficientEvidence,
                }
              : t
          )
        );
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Could not get an answer.');
      } finally {
        setAsking(false);
      }
    },
    [client, asking, canAsk, scopeKind, selectedNoteEntries, activeDocumentIds, scopeLabel]
  );

  return {
    scopeKind,
    selectedSourceIds,
    selectedNoteEntries,
    activeDocumentIds,
    scopeLabel,
    canAsk,
    setProjectReferencesScope,
    setSelectedSourcesScope,
    setResearchNotesScope,
    turns,
    asking,
    ask,
    resetThread,
  };
}
