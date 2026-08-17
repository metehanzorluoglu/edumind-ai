import {
  BackendError,
  RequestCancelledError,
  StreamingUnsupportedError,
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

/**
 * Milestone 5.5 Part 2 — 'sending' is pre-first-event (the request is in
 * flight, nothing has come back yet); 'streaming' is anything after the
 * first SSE event but before 'done' (progress pings and/or growing answer
 * text, but not yet finalized); 'cancelled' is a genuine user Stop, kept
 * distinct from 'error' so the turn history reads as "you stopped this,"
 * never "something went wrong."
 */
export type WritingAskTurnStatus = 'sending' | 'streaming' | 'success' | 'error' | 'cancelled';

export interface WritingAskTurn {
  id: string;
  question: string;
  /** What was actually folded into the question as transient context —
   * shown alongside the turn so the researcher can see exactly what the
   * model was given (Part 12's transparency requirement extended to the
   * turn history, not just the composer). */
  transientEntries: TransientAIContextEntry[];
  scopeLabel: string;
  status: WritingAskTurnStatus;
  /** Grows token-by-token while status === 'streaming' (Part 2: "partial
   * answer rendering"). Citation markers embedded in this text (e.g.
   * "[S1]") only resolve to a highlighted/clickable segment once
   * `citations` itself is populated at 'done' — see AskEduM8Panel's
   * splitAnswerIntoSegments call. */
  answer: string;
  /** Only ever populated from the backend's `sources` SSE event, which
   * today arrives after all tokens but before `done` — i.e. evidence
   * metadata is authoritative the moment it's non-empty (Part 3: "do not
   * show false or temporary evidence"). Empty for the entire 'sending'
   * and most of the 'streaming' lifetime, by construction. */
  sources: DisplaySource[];
  citations: Citation[];
  citationWarnings: string[];
  insufficientEvidence: boolean;
  errorMessage: string | null;
  /** A truthful backend-reported status line (batched-PDF pipeline only,
   * same field Chat's ThinkingContext/progressDetail already surfaces) —
   * null for every ordinary turn. */
  progressDetail: string | null;
  /** Milestone 5.5 Part 4 latency instrumentation — client timestamps
   * (ms since epoch), never a fabricated progress percentage. */
  startedAt: number;
  firstTokenAt: number | null;
  completedAt: number | null;
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
  /** Aborts the in-flight stream (if any) both locally (stops rendering
   * further tokens) and on the backend (POST .../cancel, best-effort —
   * mirrors Chat's cancelPersistedGeneration) so the generation thread
   * itself stops rather than finishing unseen. A no-op when nothing is
   * currently asking. */
  cancel: () => void;
  /** Clears the turn history and lets the next ask() lazily create a
   * fresh conversation — never reuses stale evidence across an
   * unrelated line of inquiry the researcher explicitly restarts. */
  resetThread: () => void;
}

/**
 * Milestone 5.2, streaming added in 5.5 Part 2 — the Writing workspace's
 * "Ask EduM8" orchestration. Deliberately composes the EXISTING
 * conversation primitives (createConversation / replaceConversationDocuments
 * / updateConversationScope(zoomInMode) / streamConversationMessage) rather
 * than a new endpoint (Part 1: "DO NOT create another RAG system") —
 * these are the exact same calls chat/new.tsx's runFirstMessage already
 * makes, in the exact same order (documents PUT, then scope PATCH,
 * BEFORE the message that depends on them — see that function's own
 * comments for why: zoom_in_mode=true reads the CURRENTLY persisted
 * document selection, so it must land second).
 *
 * Streams via client.streamConversationMessage() — the exact same SSE
 * endpoint/event schema Chat uses (token/sources/done/error) — rather
 * than adopting useConversationMessages wholesale: that hook's shape
 * (a persisted message list, GET-on-mount, one thinking placeholder per
 * bubble) is chat-history-shaped, whereas Writing's turns are session-
 * local with their own evidence-card mapping and transient-context
 * prefixing. Consuming the raw async generator directly keeps that
 * bespoke turn model while getting first-token feedback (5.5 Part 2) —
 * the buffered fetchAllChatEvents/postConversationMessage path is kept
 * only as the StreamingUnsupportedError fallback below, never the
 * primary path anymore. One conversation is created lazily on
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
  // The in-flight stream's abort controller + which turn it belongs to —
  // both null whenever nothing is asking. cancel() reads both: the
  // controller stops the local read loop, the turn id (== the real
  // backend message id, since it's minted as client_message_id — see
  // ask() below) lets the backend actually be told to stop generating.
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);

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
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeTurnIdRef.current = null;
    conversationIdRef.current = null;
    lastSyncedRef.current = null;
    setTurns([]);
  }, []);

  const cancel = useCallback((): void => {
    const conversationId = conversationIdRef.current;
    const turnId = activeTurnIdRef.current;
    abortControllerRef.current?.abort();
    // Best-effort server-side stop (mirrors Chat's cancelPersistedGeneration)
    // — turnId doubles as the real backend message id, since it was minted
    // as client_message_id below. A failure here just means the backend
    // worker keeps running unseen until it finishes on its own; the local
    // abort above already stopped the UI from waiting on it.
    if (conversationId && turnId) {
      client.cancelMessage(conversationId, turnId).catch(() => {});
    }
  }, [client]);

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
      const startedAt = Date.now();
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
          progressDetail: null,
          startedAt,
          firstTokenAt: null,
          completedAt: null,
        },
      ]);
      setAsking(true);

      function patch(fn: (t: WritingAskTurn) => WritingAskTurn): void {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? fn(t) : t)));
      }

      function fail(message: string): void {
        patch((t) => ({ ...t, status: 'error', errorMessage: message }));
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      activeTurnIdRef.current = turnId;

      try {
        let conversationId = conversationIdRef.current;
        if (!conversationId) {
          const created = await client.createConversation({ signal: controller.signal });
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
            await client.replaceConversationDocuments(conversationId, activeDocumentIds, {
              signal: controller.signal,
            });
          }
          if (zoomIn) {
            await client.updateConversationScope(
              conversationId,
              { zoomInMode: true },
              { signal: controller.signal }
            );
          }
          lastSyncedRef.current = { documentIds: activeDocumentIds, zoomIn };
        }

        const request = { query: fullQuery, client_message_id: turnId };
        let sawDone = false;

        try {
          for await (const event of client.streamConversationMessage(conversationId, request, {
            signal: controller.signal,
          })) {
            switch (event.type) {
              case 'progress':
                patch((t) => ({
                  ...t,
                  status: t.answer ? t.status : 'streaming',
                  progressDetail: event.detail ?? null,
                }));
                break;
              case 'token':
                patch((t) => ({
                  ...t,
                  status: 'streaming',
                  answer: t.answer + event.content,
                  firstTokenAt: t.firstTokenAt ?? Date.now(),
                  progressDetail: null,
                }));
                break;
              case 'sources':
                // Only ever populated from this event — see WritingAskTurn's
                // own doc comment on why this already satisfies Part 3.
                patch((t) => ({
                  ...t,
                  sources: event.sources.map(displaySourceFromRetrievedChunk),
                }));
                break;
              case 'done':
                sawDone = true;
                patch((t) => ({
                  ...t,
                  status: 'success',
                  citations: event.citations,
                  citationWarnings: event.citation_warnings,
                  insufficientEvidence: event.insufficient_evidence,
                  completedAt: Date.now(),
                }));
                break;
              case 'error':
                fail(event.message);
                return;
            }
          }
          if (!sawDone) fail('The answer stream ended unexpectedly. Please try again.');
        } catch (streamError) {
          if (streamError instanceof StreamingUnsupportedError) {
            // Same buffered fallback Writing used before 5.5 — only
            // reached in a runtime without incremental streaming support.
            const result = await client.postConversationMessage(conversationId, request, {
              signal: controller.signal,
            });
            patch((t) => ({
              ...t,
              status: 'success',
              answer: result.answer,
              sources: result.sources.map(displaySourceFromRetrievedChunk),
              citations: result.citations,
              citationWarnings: result.citationWarnings,
              insufficientEvidence: result.insufficientEvidence,
              completedAt: Date.now(),
            }));
          } else if (streamError instanceof RequestCancelledError) {
            patch((t) => ({ ...t, status: 'cancelled' }));
          } else {
            throw streamError;
          }
        }
      } catch (error) {
        if (error instanceof RequestCancelledError) {
          patch((t) => ({ ...t, status: 'cancelled' }));
        } else {
          fail(
            error instanceof BackendError || error instanceof Error
              ? error.message
              : 'Could not get an answer.'
          );
        }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (activeTurnIdRef.current === turnId) activeTurnIdRef.current = null;
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
    cancel,
    resetThread,
  };
}
