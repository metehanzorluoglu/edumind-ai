import {
  BackendError,
  RequestCancelledError,
  StreamingUnsupportedError,
  displaySourceFromRetrievedChunk,
  type Citation,
  type DisplaySource,
  type EducationAssistantClient,
  type NotebookEntry,
  type WritingAskContextRequest,
  type WritingContextSummary,
} from 'education-assistant-client';
import { useCallback, useMemo, useRef, useState } from 'react';
import { generateClientMessageId } from '@/lib/clientMessageId';
import {
  buildTransientContextPrefix,
  transientEntryFromNotebookEntry,
  type TransientAIContextEntry,
} from '@/lib/transientAIContext';

/**
 * Milestone 6.2 (Context-Aware Ask EduM8) Part 2 — the CURRENT editor
 * state a Writing Ask EduM8 question is submitted with. Replaces the old
 * client-side 'manuscript-selection' TransientAIContextEntry prefix
 * (M5.2): manuscript context is no longer flattened into text on this
 * side at all — it's sent structured, and the M6.1 Writing Context
 * Engine (rag-backend) builds/validates/formats it server-side (Part 2:
 * "That architecture must no longer be the authoritative Writing
 * manuscript context mechanism"). Research-Notes transient context
 * (a DIFFERENT, still-valid mechanism — Part 2's own explicit
 * distinction) is untouched below.
 */
export interface WritingAskEditorContext {
  projectId: string;
  activeFileId: string | null;
  cursorPosition: number;
  selectionStart: number;
  selectionEnd: number;
  selectedText: string;
  /** The live, possibly-unsaved buffer for `activeFileId` — always sent
   * so the backend never has to fall back to a possibly-stale saved
   * copy while autosave is still in flight (Part 3/21). */
  activeFileUnsavedContent: string;
}

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
  /** Milestone 6.2 Parts 11/12 — the compact, honest context indicator
   * (see WritingContextSummary's own docstring). Null while the turn is
   * still 'sending'/'streaming' (only known once the backend's 'done'
   * event arrives) and for any non-Writing turn — this hook is only ever
   * used by Writing, but a plain Chat-style question through it (no
   * editorContext passed to ask()) still legitimately gets null back,
   * same as the backend's own "absent for every ordinary Chat message"
   * contract. */
  contextSummary: WritingContextSummary | null;
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
  /** True whenever the currently open document alone, the active RAG
   * scope alone, or both together give Ask EduM8 something to work
   * with. Writing UX Refinement milestone, Blocker 2 — the currently
   * open document is always-usable Writing context on its own; a
   * project with zero references/sources/notes no longer disables
   * asking (only a project with NEITHER an open document NOR any scope
   * content is refused). */
  canAsk: boolean;
  /** False when the active RAG scope (Project References/Selected
   * Sources/Research Notes) has nothing selected — independent of
   * `canAsk`, which the current document alone can already satisfy.
   * Lets callers show an honest "no references attached" note without
   * implying Ask EduM8 itself is unavailable (Part 13's original
   * per-scope guidance, now informational rather than blocking). */
  hasScopeContent: boolean;
  setProjectReferencesScope: () => void;
  setSelectedSourcesScope: (documentIds: string[]) => void;
  setResearchNotesScope: (entries: NotebookEntry[]) => void;
  turns: WritingAskTurn[];
  asking: boolean;
  ask: (
    question: string,
    editorContext?: WritingAskEditorContext | null,
    options?: {
      /** Milestone 6.2 real-model validation — a quick action's
       * controlled prompt (Grammar/Improve/Concise/Explain) is always
       * local_edit-shaped: M6.1's own POLICY_LAYERS guarantees zero RAG
       * for it regardless of the panel's current scope selection, so
       * canAsk's "does the active scope have anything to search"
       * question simply doesn't apply. Only quick actions pass this —
       * the composer's own typed questions (which really can be
       * reference/evidence questions needing a real scope) stay gated
       * by canAsk exactly as before. */
      skipScopeGate?: boolean;
    }
  ) => Promise<void>;
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
 *
 * `hasCurrentDocument` — Writing UX Refinement milestone, Blocker 2 fix.
 * Real-browser validation found a genuine defect: `canAsk` used to
 * require the active RAG scope (defaulting to Project References) to
 * have at least one document, so a project with zero references
 * disabled the composer entirely — even for questions like "summarize
 * my current document" that need no reference evidence at all. The
 * backend has never actually required this: `writing_context` (built
 * from `editorContext` below) is sent on every ask() call regardless of
 * scope, and the M6.1 Writing Context Engine already treats the active
 * file as first-class context server-side. The gate was a pure
 * frontend bug, not a backend requirement. The currently open document
 * is always-usable Writing context (RAG scope selection remains
 * optional, additive evidence-search on top of it) — see `canAsk`'s own
 * updated comment below.
 */
export function useWritingAsk(
  client: EducationAssistantClient,
  projectReferenceDocumentIds: string[],
  hasCurrentDocument: boolean
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
  // with no fallback of their own — an empty set there means "no extra
  // evidence to search," never "search everything."
  //
  // Writing UX Refinement milestone, Blocker 2 fix — that emptiness used
  // to mean "cannot ask at all," which was wrong: the currently open
  // document (`hasCurrentDocument`) is always valid Writing context on
  // its own, independent of whatever RAG scope happens to be selected.
  // `hasCurrentDocument` is an OR, not a replacement — a real, populated
  // scope still keeps working exactly as before (e.g. a project with no
  // file open yet but with references already selected can still ask
  // against them). Only a project with genuinely nothing at all — no
  // open document AND an empty scope — is refused, same as today's
  // behavior for that edge case.
  const hasScopeContent =
    scopeKind === 'research-notes' ? selectedNoteEntries.length > 0 : activeDocumentIds.length > 0;
  const canAsk = hasCurrentDocument || hasScopeContent;

  const resetThread = useCallback((): void => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    activeTurnIdRef.current = null;
    conversationIdRef.current = null;
    lastSyncedRef.current = null;
    setTurns([]);
  }, []);

  const cancel = useCallback((): void => {
    // Milestone 6.2 real-model validation — a real bug found and fixed
    // here: this used to ALSO call client.cancelMessage(conversationId,
    // turnId), on the belief that turnId (== the client_message_id
    // minted below) "doubles as the real backend message id." It never
    // does — PostConversationMessageRequest.client_message_id is a
    // purely client-side idempotency key (a base36 timestamp+random
    // string), while the assistant Message row's own `id` is a UUID
    // assigned server-side (see app/db/models_conversations.py) and is
    // never sent back to the client during a live stream. Every such
    // call therefore 422'd (a UUID-format path-param validation
    // failure) — confirmed against real backend logs — meaning the
    // backend worker kept generating a real, unseen answer (burning
    // real compute) after every "Stop" press, not just in the rare
    // failure case the old comment described. This exactly mirrors
    // Chat's OWN cancelSend() (useConversationMessages.ts) for a live,
    // still-connected turn: a LOCAL abort only. Chat's separate
    // cancelPersistedGeneration (a genuine server-side cancel) is only
    // ever used for a DIFFERENT scenario — resuming a reconnected
    // 'generating' message the client already has the real persisted id
    // for — which Writing's live turns never have. Removing the broken
    // call changes nothing about user-visible behavior (it always
    // failed silently before); it just stops sending a doomed request
    // and stops claiming a stop that never actually happened server-side.
    abortControllerRef.current?.abort();
  }, []);

  const ask = useCallback(
    async (
      question: string,
      editorContext?: WritingAskEditorContext | null,
      options?: { skipScopeGate?: boolean }
    ): Promise<void> => {
      const trimmed = question.trim();
      if (!trimmed || asking || (!canAsk && !options?.skipScopeGate)) return;

      // Milestone 6.2 Part 2 — manuscript selection/section context is no
      // longer folded into the query text here at all; it travels
      // structured (see `writingContext` below) straight to the M6.1
      // engine. Research Notes transient context is untouched — a
      // genuinely different, still-valid mechanism (Part 2's own
      // explicit "may continue using existing architecture" distinction).
      const transientEntries: TransientAIContextEntry[] =
        scopeKind === 'research-notes'
          ? selectedNoteEntries.map(transientEntryFromNotebookEntry)
          : [];
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
          contextSummary: null,
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

        const writingContext: WritingAskContextRequest | undefined = editorContext
          ? {
              project_id: editorContext.projectId,
              active_file_id: editorContext.activeFileId,
              cursor_position: editorContext.cursorPosition,
              selection_start: editorContext.selectionStart,
              selection_end: editorContext.selectionEnd,
              selected_text: editorContext.selectedText,
              active_file_unsaved_content: editorContext.activeFileUnsavedContent,
            }
          : undefined;
        const request = {
          query: fullQuery,
          client_message_id: turnId,
          writing_context: writingContext,
        };
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
                  contextSummary: event.writing_context_summary ?? null,
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
              contextSummary: result.writingContextSummary,
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
    hasScopeContent,
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
