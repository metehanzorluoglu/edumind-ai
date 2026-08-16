import { useCallback, useEffect, useRef, useState } from 'react';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  AddWritingProjectReferencesResponse,
  CompileWritingProjectResponse,
  UpdateWritingProjectRequest,
  WritingProject,
  WritingProjectBibliography,
  WritingProjectReferencesResponse,
} from '../types/writing';

/** Milestone 5 Section 7 — the editor autosave debounce: how long to wait
 * after the last keystroke before PATCHing main_tex_content. Long enough
 * that rapid typing never generates a PATCH per keystroke; short enough
 * that a "Saved" state normally appears within a second or two of the
 * user pausing. */
export const DEFAULT_AUTOSAVE_DELAY_MS = 1200;

export type WritingProjectLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

/**
 * Milestone 5 Section 7 — the editor's own save status, surfaced as
 * "Editing…/Saving…/Saved". Never reports 'saved' before the server has
 * actually acknowledged the write; an edit made while a save is already
 * in flight is guaranteed to be saved by a follow-up request (see
 * useWritingProject's save loop) rather than lost.
 */
export type WritingProjectSaveStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

export type WritingProjectReferencesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WritingProjectReferencesResponse }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type WritingProjectBibliographyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WritingProjectBibliography }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

/**
 * Milestone 5.1 Part 24 — the Compile button's own state. 'result'
 * covers every backend-reported outcome (success/error/timeout/busy/
 * unavailable — see CompileWritingProjectResponse['status']) as a plain
 * value; only a genuine transport/ownership failure (network down, 404)
 * lands in 'error' here.
 */
export type WritingProjectCompileState =
  | { status: 'idle' }
  | { status: 'compiling' }
  | { status: 'result'; data: CompileWritingProjectResponse }
  | { status: 'error'; error: EducationAssistantError };

export interface UseWritingProjectResult {
  loadState: WritingProjectLoadState;
  /** The full project as last loaded/saved (undefined until loadState is 'success' at least once). */
  project: WritingProject | undefined;
  /** Re-fetches the project from scratch, discarding any unsaved local edit. */
  reload: () => void;

  /** The editor's current buffer — starts equal to project.main_tex_content once loaded. */
  content: string;
  saveStatus: WritingProjectSaveStatus;
  saveError: EducationAssistantError | null;
  /** Updates the editor buffer and schedules a debounced autosave PATCH.
   * Never issues a request synchronously — see DEFAULT_AUTOSAVE_DELAY_MS. */
  setContent: (text: string) => void;
  /** Forces any pending/debounced edit to save immediately and resolves
   * once the server has acknowledged it (or rejects on failure) — call
   * before navigating away so no edit is ever silently lost. A no-op
   * (resolves immediately) if there is nothing unsaved. */
  flush: () => Promise<void>;

  /** Renames the project (title and/or description) — an immediate
   * PATCH, not debounced, distinct from the editor's own autosave. */
  renameProject: (request: { title?: string; description?: string | null }) => Promise<void>;

  referencesState: WritingProjectReferencesState;
  loadReferences: () => void;
  /** Adds one or more existing library Documents as references, then
   * reloads the reference list. */
  addReferences: (documentIds: string[]) => Promise<AddWritingProjectReferencesResponse>;
  /** Removes one reference association, then reloads the reference
   * list. Never deletes the Document itself. */
  removeReference: (documentId: string) => Promise<void>;

  bibliographyState: WritingProjectBibliographyState;
  loadBibliography: () => void;

  /** Fetches the portable project ZIP (main.tex + references.bib) as a Blob. */
  exportProject: () => Promise<Blob>;

  /**
   * Milestone 5.1 Part 33 — compiles the project. Always flushes any
   * pending/in-flight autosave and awaits a successful save FIRST
   * (matching the module docstring's "flush -> save -> act" discipline);
   * if that save fails, this rejects without ever calling compile, so a
   * stale/outdated manuscript is never silently compiled. Resolves with
   * the structured result (busy/timeout/error are ordinary values here,
   * not thrown — see WritingProjectCompileState); only a genuine
   * transport/ownership failure rejects.
   */
  compileState: WritingProjectCompileState;
  compileProject: () => Promise<CompileWritingProjectResponse>;
  /** Fetches one compile's PDF bytes as a Blob — pass the `compile_id`
   * from a successful compileState.data. */
  fetchCompiledPdf: (compileId: string) => Promise<Blob>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) — single writing
 * project: load, debounced-autosave editing, references, bibliography,
 * and export. `projectId` is fixed for the lifetime of one hook instance
 * (the editor screen's route param) — pass a new key/remount to switch
 * projects, the same convention as most single-resource screens in this
 * app.
 *
 * The autosave "save loop" (see the internal `runSaveLoop`) guarantees
 * an edit made while a save is already in flight is never lost: it keeps
 * PATCHing with the latest buffer content until the buffer matches what
 * was last successfully saved, rather than firing one PATCH per debounce
 * tick and letting requests race.
 */
export function useWritingProject(
  client: EducationAssistantClient,
  projectId: string,
  options: { autosaveDelayMs?: number } = {}
): UseWritingProjectResult {
  const autosaveDelayMs = options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;

  const [loadState, setLoadState] = useState<WritingProjectLoadState>({ status: 'idle' });
  const [project, setProject] = useState<WritingProject | undefined>(undefined);
  const [content, setContentState] = useState<string>('');
  const [saveStatus, setSaveStatus] = useState<WritingProjectSaveStatus>('idle');
  const [saveError, setSaveError] = useState<EducationAssistantError | null>(null);
  const [referencesState, setReferencesState] = useState<WritingProjectReferencesState>({
    status: 'idle',
  });
  const [bibliographyState, setBibliographyState] = useState<WritingProjectBibliographyState>({
    status: 'idle',
  });
  const [compileState, setCompileState] = useState<WritingProjectCompileState>({
    status: 'idle',
  });

  const isMountedRef = useRef(true);
  const contentRef = useRef('');
  const savedContentRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingPromiseRef = useRef<Promise<void> | null>(null);
  const loadGenerationRef = useRef(0);
  const referencesGenerationRef = useRef(0);
  const bibliographyGenerationRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (debounceTimerRef.current !== null) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  /** Keeps PATCHing with whatever content is currently in the buffer
   * until it matches what was last successfully saved — see the module
   * docstring for why this beats one request per debounce tick. */
  const runSaveLoop = useCallback(async (): Promise<void> => {
    while (contentRef.current !== savedContentRef.current) {
      const toSave = contentRef.current;
      if (isMountedRef.current) setSaveStatus('saving');
      try {
        const updated = await client.updateWritingProject(projectId, {
          mainTexContent: toSave,
        });
        savedContentRef.current = toSave;
        if (isMountedRef.current) {
          setProject(updated);
          setSaveStatus('saved');
          setSaveError(null);
        }
      } catch (error) {
        if (isMountedRef.current) {
          setSaveStatus('error');
          setSaveError(toAssistantError(error));
        }
        throw error;
      }
    }
  }, [client, projectId]);

  const ensureSaving = useCallback((): Promise<void> => {
    if (savingPromiseRef.current) return savingPromiseRef.current;
    const promise = runSaveLoop().finally(() => {
      savingPromiseRef.current = null;
    });
    savingPromiseRef.current = promise;
    return promise;
  }, [runSaveLoop]);

  const reload = useCallback(() => {
    const generation = ++loadGenerationRef.current;
    clearDebounce();
    setLoadState({ status: 'loading' });

    client
      .getWritingProject(projectId)
      .then((data) => {
        if (!isMountedRef.current || generation !== loadGenerationRef.current) return;
        setProject(data);
        contentRef.current = data.main_tex_content;
        savedContentRef.current = data.main_tex_content;
        setContentState(data.main_tex_content);
        setSaveStatus('idle');
        setSaveError(null);
        setLoadState({ status: 'success' });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || generation !== loadGenerationRef.current) return;
        setLoadState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, projectId, clearDebounce]);

  useEffect(() => {
    reload();
    // `reload`'s own identity already changes exactly when `client` or
    // `projectId` change (its deps are [client, projectId, clearDebounce],
    // and clearDebounce is stable) — [reload] is therefore exhaustive.
  }, [reload]);

  const setContent = useCallback(
    (text: string) => {
      contentRef.current = text;
      setContentState(text);
      clearDebounce();

      if (text === savedContentRef.current) {
        // Reverted back to the last-saved value — nothing new to persist.
        if (!savingPromiseRef.current) setSaveStatus('saved');
        return;
      }
      setSaveStatus('editing');
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void ensureSaving();
      }, autosaveDelayMs);
    },
    [clearDebounce, ensureSaving, autosaveDelayMs]
  );

  const flush = useCallback(async (): Promise<void> => {
    clearDebounce();
    await ensureSaving();
  }, [clearDebounce, ensureSaving]);

  const renameProject = useCallback(
    async (request: { title?: string; description?: string | null }): Promise<void> => {
      const body: UpdateWritingProjectRequest = {};
      if ('title' in request) body.title = request.title;
      if ('description' in request) body.description = request.description;
      const updated = await client.updateWritingProject(projectId, body);
      if (isMountedRef.current) setProject(updated);
    },
    [client, projectId]
  );

  const loadReferences = useCallback(() => {
    const generation = ++referencesGenerationRef.current;
    setReferencesState({ status: 'loading' });

    client
      .listWritingProjectReferences(projectId)
      .then((data) => {
        if (!isMountedRef.current || generation !== referencesGenerationRef.current) return;
        setReferencesState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || generation !== referencesGenerationRef.current) return;
        if (error instanceof RequestCancelledError) {
          setReferencesState({ status: 'cancelled' });
          return;
        }
        setReferencesState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, projectId]);

  const addReferences = useCallback(
    async (documentIds: string[]): Promise<AddWritingProjectReferencesResponse> => {
      const result = await client.addWritingProjectReferences(projectId, documentIds);
      loadReferences();
      return result;
    },
    [client, projectId, loadReferences]
  );

  const removeReference = useCallback(
    async (documentId: string): Promise<void> => {
      await client.removeWritingProjectReference(projectId, documentId);
      loadReferences();
    },
    [client, projectId, loadReferences]
  );

  const loadBibliography = useCallback(() => {
    const generation = ++bibliographyGenerationRef.current;
    setBibliographyState({ status: 'loading' });

    client
      .getWritingProjectBibliography(projectId)
      .then((data) => {
        if (!isMountedRef.current || generation !== bibliographyGenerationRef.current) return;
        setBibliographyState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || generation !== bibliographyGenerationRef.current) return;
        setBibliographyState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, projectId]);

  const exportProject = useCallback((): Promise<Blob> => {
    return client.fetchWritingProjectExportBlob(projectId);
  }, [client, projectId]);

  const compileProject = useCallback(async (): Promise<CompileWritingProjectResponse> => {
    // Part 33 — flush first; a save failure must abort the compile
    // entirely rather than compile stale content. `flush()` already
    // sets saveStatus/saveError on failure — this rethrows the same
    // error so the caller's own error handling (if any) sees it too.
    await flush();

    setCompileState({ status: 'compiling' });
    try {
      const result = await client.compileWritingProject(projectId);
      if (isMountedRef.current) setCompileState({ status: 'result', data: result });
      return result;
    } catch (error) {
      if (isMountedRef.current) setCompileState({ status: 'error', error: toAssistantError(error) });
      throw error;
    }
  }, [client, projectId, flush]);

  const fetchCompiledPdf = useCallback(
    (compileId: string): Promise<Blob> => {
      return client.fetchCompiledPdfBlob(projectId, compileId);
    },
    [client, projectId]
  );

  return {
    loadState,
    project,
    reload,
    content,
    saveStatus,
    saveError,
    setContent,
    flush,
    renameProject,
    referencesState,
    loadReferences,
    addReferences,
    removeReference,
    bibliographyState,
    loadBibliography,
    exportProject,
    compileState,
    compileProject,
    fetchCompiledPdf,
  };
}
