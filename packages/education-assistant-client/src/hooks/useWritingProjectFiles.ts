import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_AUTOSAVE_DELAY_MS } from './useWritingProject';
import { EducationAssistantError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  CreateWritingProjectFolderRequest,
  CreateWritingProjectTextFileRequest,
  WritingProjectFileNode,
  WritingProjectFileTree,
} from '../types/writing';
import type { UploadableFile } from '../types/documents';

export type WritingFileTreeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WritingProjectFileTree }
  | { status: 'error'; error: EducationAssistantError };

export type ActiveFileLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

/** Same "Editing…/Saving…/Saved" contract as useWritingProject's own
 * WritingProjectSaveStatus — see that module's docstring. */
export type ActiveFileSaveStatus = 'idle' | 'editing' | 'saving' | 'saved' | 'error';

export interface UseWritingProjectFilesResult {
  treeState: WritingFileTreeState;
  refreshTree: () => void;

  /** Milestone 5.3 Part 13/14 — the "selected-file model" (Part 14: an
   * explicit, reported decision — a lightweight tab strip would add
   * meaningful state-management complexity — unsaved-per-tab tracking,
   * tab close/reorder — for a feature this milestone's own spec marks
   * optional; a caller that wants a visual tab strip can still render
   * one from `treeState`'s recently-opened files locally without this
   * hook needing to know about it). Exactly one text file is "open" in
   * the editor buffer at a time. */
  activeFileId: string | null;
  activeFileNode: WritingProjectFileNode | null;
  activeFileLoadState: ActiveFileLoadState;
  activeFileContent: string;
  activeFileSaveStatus: ActiveFileSaveStatus;
  activeFileSaveError: EducationAssistantError | null;
  /** Updates the active file's buffer and schedules a debounced autosave
   * PATCH — identical discipline to useWritingProject's setContent. */
  setActiveFileContent: (text: string) => void;
  /** Forces any pending/in-flight save of the ACTIVE file to complete.
   * Call before compiling or navigating away. */
  flushActiveFile: () => Promise<void>;
  /**
   * Part 13/39 — flushes whatever is currently open (never silently
   * discarding an edit), then loads `fileId`'s content into the editor
   * buffer. A no-op if `fileId` is already active. Only text files may
   * be opened this way — a binary file's id here rejects (use
   * fetchWritingProjectFileBinaryBlob for a binary asset's preview).
   */
  openFile: (fileId: string) => Promise<void>;

  createFolder: (request: CreateWritingProjectFolderRequest) => Promise<WritingProjectFileNode>;
  createTextFile: (request: CreateWritingProjectTextFileRequest) => Promise<WritingProjectFileNode>;
  uploadFile: (
    file: UploadableFile,
    options?: { parentId?: string | null; name?: string }
  ) => Promise<WritingProjectFileNode>;
  renameFile: (fileId: string, name: string) => Promise<WritingProjectFileNode>;
  moveFile: (fileId: string, newParentId: string | null) => Promise<WritingProjectFileNode>;
  /** Part 9/16 — deletes a file, or a folder and everything under it.
   * Rejects if this file is (or contains) the current root file. If the
   * deleted file was active, clears activeFileId. */
  deleteFile: (fileId: string) => Promise<void>;
  /** Part 15 — reassigns the project's root/main document. */
  setRootFile: (fileId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

function findNode(tree: WritingProjectFileTree | null, fileId: string | null): WritingProjectFileNode | null {
  if (!tree || !fileId) return null;
  return tree.files.find((f) => f.id === fileId) ?? null;
}

/**
 * Milestone 5.3 (LaTeX Project Workspace & File Management) — a Writing
 * Project's file tree: listing, structural mutations (create/rename/
 * move/delete/upload/root-selection), and ONE active text file's
 * debounced-autosave editor buffer, using the exact same "save loop
 * never loses a concurrent edit" discipline as useWritingProject's own
 * main_tex_content autosave (see that hook's module docstring — this
 * one is deliberately generalized to `fileId` rather than duplicated
 * wholesale for a second, subtly-different implementation).
 *
 * Deliberately a SEPARATE hook from useWritingProject (which keeps
 * owning project metadata, references, bibliography, compile, and
 * export — Part 2's write-through sync on the backend means editing the
 * root file through EITHER hook keeps `main_tex_content` and the file
 * row consistent, so nothing here needs to reach into
 * useWritingProject's own state).
 */
export function useWritingProjectFiles(
  client: EducationAssistantClient,
  projectId: string,
  options: { autosaveDelayMs?: number; initialFileId?: string | null } = {}
): UseWritingProjectFilesResult {
  const autosaveDelayMs = options.autosaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
  // Milestone 5.5.1 Part 25 — a caller (Writing's own screen, restoring
  // from its cross-navigation session cache — see lib/sessionNavCache.ts
  // there) can request a specific file to open first, instead of always
  // defaulting to the root file. Read once, at the identity this hook
  // instance was created with — like projectId itself, this isn't meant
  // to react to later prop changes within the same mount (there's no
  // "switch the initial file mid-session" use case), matching the
  // effect below's own "never re-fires" contract.
  const initialFileIdRef = useRef(options.initialFileId ?? null);

  const [treeState, setTreeState] = useState<WritingFileTreeState>({ status: 'idle' });
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [activeFileLoadState, setActiveFileLoadState] = useState<ActiveFileLoadState>({
    status: 'idle',
  });
  const [activeFileContent, setActiveFileContentState] = useState('');
  const [activeFileSaveStatus, setActiveFileSaveStatus] = useState<ActiveFileSaveStatus>('idle');
  const [activeFileSaveError, setActiveFileSaveError] = useState<EducationAssistantError | null>(
    null
  );

  const isMountedRef = useRef(true);
  const treeGenerationRef = useRef(0);
  const activeFileIdRef = useRef<string | null>(null);
  const contentRef = useRef('');
  const savedContentRef = useRef('');
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingPromiseRef = useRef<Promise<void> | null>(null);
  const openGenerationRef = useRef(0);

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

  const refreshTree = useCallback(() => {
    const generation = ++treeGenerationRef.current;
    setTreeState({ status: 'loading' });
    client
      .listWritingProjectFiles(projectId)
      .then((data) => {
        if (!isMountedRef.current || generation !== treeGenerationRef.current) return;
        setTreeState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || generation !== treeGenerationRef.current) return;
        setTreeState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, projectId]);

  useEffect(() => {
    refreshTree();
  }, [refreshTree]);

  /** Mirrors useWritingProject's runSaveLoop exactly — keeps PATCHing
   * the ACTIVE file with whatever is currently in the buffer until it
   * matches what was last successfully saved, so a concurrent edit
   * during an in-flight save is never dropped. */
  const runSaveLoop = useCallback(
    async (fileId: string): Promise<void> => {
      while (contentRef.current !== savedContentRef.current) {
        const toSave = contentRef.current;
        if (isMountedRef.current) setActiveFileSaveStatus('saving');
        try {
          await client.updateWritingProjectFileContent(projectId, fileId, { contentText: toSave });
          savedContentRef.current = toSave;
          if (isMountedRef.current && activeFileIdRef.current === fileId) {
            setActiveFileSaveStatus('saved');
            setActiveFileSaveError(null);
          }
        } catch (error) {
          if (isMountedRef.current && activeFileIdRef.current === fileId) {
            setActiveFileSaveStatus('error');
            setActiveFileSaveError(toAssistantError(error));
          }
          throw error;
        }
      }
    },
    [client, projectId]
  );

  const ensureSaving = useCallback(
    (fileId: string): Promise<void> => {
      if (savingPromiseRef.current) return savingPromiseRef.current;
      const promise = runSaveLoop(fileId).finally(() => {
        savingPromiseRef.current = null;
      });
      savingPromiseRef.current = promise;
      return promise;
    },
    [runSaveLoop]
  );

  const flushActiveFile = useCallback(async (): Promise<void> => {
    const fileId = activeFileIdRef.current;
    clearDebounce();
    if (!fileId) return;
    await ensureSaving(fileId);
  }, [clearDebounce, ensureSaving]);

  const setActiveFileContent = useCallback(
    (text: string) => {
      const fileId = activeFileIdRef.current;
      contentRef.current = text;
      setActiveFileContentState(text);
      clearDebounce();
      if (!fileId) return;

      if (text === savedContentRef.current) {
        if (!savingPromiseRef.current) setActiveFileSaveStatus('saved');
        return;
      }
      setActiveFileSaveStatus('editing');
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void ensureSaving(fileId);
      }, autosaveDelayMs);
    },
    [clearDebounce, ensureSaving, autosaveDelayMs]
  );

  const openFile = useCallback(
    async (fileId: string): Promise<void> => {
      if (activeFileIdRef.current === fileId) return;
      // Part 39 — never silently discard an edit when switching files.
      await flushActiveFile();

      const generation = ++openGenerationRef.current;
      activeFileIdRef.current = fileId;
      setActiveFileId(fileId);
      setActiveFileLoadState({ status: 'loading' });
      setActiveFileSaveStatus('idle');
      setActiveFileSaveError(null);

      try {
        const content = await client.getWritingProjectFileContent(projectId, fileId);
        if (!isMountedRef.current || generation !== openGenerationRef.current) return;
        if (content.file.kind === 'folder') {
          throw new EducationAssistantError('Cannot open a folder in the editor.');
        }
        const text = content.content_text ?? '';
        contentRef.current = text;
        savedContentRef.current = text;
        setActiveFileContentState(text);
        setActiveFileLoadState({ status: 'success' });
      } catch (error) {
        if (!isMountedRef.current || generation !== openGenerationRef.current) return;
        setActiveFileLoadState({ status: 'error', error: toAssistantError(error) });
      }
    },
    [client, projectId, flushActiveFile]
  );

  // Part 15/20 — default to the project's current root file the first
  // time the tree loads successfully, mirroring the pre-M5.3 editor's
  // own "always shows main.tex" behavior. Never re-fires after the
  // user has explicitly opened something (activeFileId already set).
  //
  // Milestone 5.5.1 Part 25 — a requested initialFileId takes priority
  // over the root file, but only if it's still a real TEXT file in this
  // exact tree (a file remembered from a previous session may since
  // have been deleted/moved/converted — falling back to root rather
  // than silently doing nothing keeps this exactly as safe as the
  // pre-Part-25 default behavior in that edge case).
  useEffect(() => {
    if (treeState.status === 'success' && activeFileIdRef.current === null) {
      const remembered = initialFileIdRef.current;
      const rememberedIsValid =
        remembered !== null &&
        treeState.data.files.some((f) => f.id === remembered && f.kind === 'text');
      const toOpen = rememberedIsValid ? remembered : treeState.data.root_file_id;
      if (toOpen) void openFile(toOpen);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeState]);

  const createFolder = useCallback(
    async (request: CreateWritingProjectFolderRequest): Promise<WritingProjectFileNode> => {
      const result = await client.createWritingProjectFolder(projectId, request);
      refreshTree();
      return result.file;
    },
    [client, projectId, refreshTree]
  );

  const createTextFile = useCallback(
    async (request: CreateWritingProjectTextFileRequest): Promise<WritingProjectFileNode> => {
      const result = await client.createWritingProjectTextFile(projectId, request);
      refreshTree();
      return result.file;
    },
    [client, projectId, refreshTree]
  );

  const uploadFile = useCallback(
    async (
      file: UploadableFile,
      uploadOptions: { parentId?: string | null; name?: string } = {}
    ): Promise<WritingProjectFileNode> => {
      const result = await client.uploadWritingProjectFile(projectId, file, uploadOptions);
      refreshTree();
      return result.file;
    },
    [client, projectId, refreshTree]
  );

  const renameFile = useCallback(
    async (fileId: string, name: string): Promise<WritingProjectFileNode> => {
      const result = await client.renameWritingProjectFile(projectId, fileId, { name });
      refreshTree();
      return result.file;
    },
    [client, projectId, refreshTree]
  );

  const moveFile = useCallback(
    async (fileId: string, newParentId: string | null): Promise<WritingProjectFileNode> => {
      const result = await client.moveWritingProjectFile(projectId, fileId, { newParentId });
      refreshTree();
      return result.file;
    },
    [client, projectId, refreshTree]
  );

  const deleteFile = useCallback(
    async (fileId: string): Promise<void> => {
      await client.deleteWritingProjectFile(projectId, fileId);
      if (activeFileIdRef.current === fileId) {
        // Clears the buffer immediately (never show a deleted file's
        // stale content); the tree refresh below re-triggers this
        // hook's own "default to the project's root file" effect (see
        // that effect's docstring) once it resolves, so the editor
        // falls back to showing the root document rather than staying
        // permanently blank — the same fallback a fresh mount already
        // uses (Part 16 guarantees the root file itself can never be
        // the one just deleted, so this can never loop).
        activeFileIdRef.current = null;
        setActiveFileId(null);
        setActiveFileContentState('');
        contentRef.current = '';
        savedContentRef.current = '';
        setActiveFileLoadState({ status: 'idle' });
        setActiveFileSaveStatus('idle');
      }
      refreshTree();
    },
    [client, projectId, refreshTree]
  );

  const setRootFile = useCallback(
    async (fileId: string): Promise<void> => {
      await client.setWritingProjectRootFile(projectId, fileId);
      refreshTree();
    },
    [client, projectId, refreshTree]
  );

  return {
    treeState,
    refreshTree,
    activeFileId,
    activeFileNode: findNode(treeState.status === 'success' ? treeState.data : null, activeFileId),
    activeFileLoadState,
    activeFileContent,
    activeFileSaveStatus,
    activeFileSaveError,
    setActiveFileContent,
    flushActiveFile,
    openFile,
    createFolder,
    createTextFile,
    uploadFile,
    renameFile,
    moveFile,
    deleteFile,
    setRootFile,
  };
}
