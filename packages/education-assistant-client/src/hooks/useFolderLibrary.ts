import { useCallback, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { DocumentSummary } from '../types/documents';
import type { DeleteFolderResponse, FolderContentsResponse, FolderResponse } from '../types/folders';

export type FolderContentsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; contents: FolderContentsResponse }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseFolderLibraryResult {
  /** null = root/"My Library". */
  currentFolderId: string | null;
  contentsState: FolderContentsState;
  /** Navigates into a folder (or root, via null) and loads its contents. */
  navigate: (folderId: string | null) => void;
  /** Re-fetches the currently-open folder's contents, superseding any in-flight load. */
  refresh: () => void;
  cancel: () => void;

  /** Creates a folder as a child of whichever folder is currently open, then refreshes. */
  createFolder: (name: string) => Promise<FolderResponse>;
  /** Renames a folder (any folder, not necessarily the open one), then refreshes. */
  renameFolder: (folderId: string, name: string) => Promise<FolderResponse>;
  /** Moves a folder to a new parent (null = root), then refreshes. */
  moveFolder: (folderId: string, parentId: string | null) => Promise<FolderResponse>;
  /**
   * Deletes a folder. Rejects with a ConflictError (409) if it directly
   * contains a subfolder or document and `moveContentsToRoot` wasn't
   * passed — see DeleteFolderParams. Refreshes on success.
   */
  deleteFolder: (folderId: string, options?: { moveContentsToRoot?: boolean }) => Promise<DeleteFolderResponse>;
  /** Moves a document to a different folder (null = root), then refreshes. */
  moveDocument: (documentId: string, folderId: string | null) => Promise<DocumentSummary>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * GET /folders/contents plus the folder/document mutations that change
 * what it returns — Milestone 1 (Document Library / Folder Management)'s
 * Documents-page data source. One "current folder" at a time (`navigate`),
 * matching how a file-manager-style breadcrumb UI is actually used —
 * unlike useProjects' flat list, there is no separate "list of all
 * folders" state to keep in sync.
 */
export function useFolderLibrary(client: EducationAssistantClient): UseFolderLibraryResult {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [contentsState, setContentsState] = useState<FolderContentsState>({ status: 'idle' });
  const guard = useAsyncGuard();
  // fetchContents reads this instead of the `currentFolderId` state value so
  // refresh() (called right after an await, e.g. inside createFolder) always
  // targets whichever folder navigate() most recently set, even before
  // React has re-rendered with that state update.
  const currentFolderIdRef = useRef<string | null>(null);

  const fetchContents = useCallback(
    (folderId: string | null) => {
      const { signal, isCurrent } = guard.begin();
      setContentsState({ status: 'loading' });

      client
        .getFolderContents({ folderId }, { signal })
        .then((contents) => {
          if (!isCurrent()) return;
          setContentsState({ status: 'success', contents });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setContentsState({ status: 'cancelled' });
            return;
          }
          setContentsState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, guard]
  );

  const navigate = useCallback(
    (folderId: string | null) => {
      currentFolderIdRef.current = folderId;
      setCurrentFolderId(folderId);
      fetchContents(folderId);
    },
    [fetchContents]
  );

  const refresh = useCallback(() => {
    fetchContents(currentFolderIdRef.current);
  }, [fetchContents]);

  const createFolder = useCallback(
    async (name: string): Promise<FolderResponse> => {
      const folder = await client.createFolder({ name, parentId: currentFolderIdRef.current });
      refresh();
      return folder;
    },
    [client, refresh]
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string): Promise<FolderResponse> => {
      const folder = await client.updateFolder(folderId, { name });
      refresh();
      return folder;
    },
    [client, refresh]
  );

  const moveFolder = useCallback(
    async (folderId: string, parentId: string | null): Promise<FolderResponse> => {
      const folder = await client.updateFolder(folderId, { parentId });
      refresh();
      return folder;
    },
    [client, refresh]
  );

  const deleteFolder = useCallback(
    async (
      folderId: string,
      options: { moveContentsToRoot?: boolean } = {}
    ): Promise<DeleteFolderResponse> => {
      const result = await client.deleteFolder(folderId, {
        moveContentsToRoot: options.moveContentsToRoot,
      });
      refresh();
      return result;
    },
    [client, refresh]
  );

  const moveDocument = useCallback(
    async (documentId: string, folderId: string | null): Promise<DocumentSummary> => {
      const document = await client.moveDocument(documentId, { folderId });
      refresh();
      return document;
    },
    [client, refresh]
  );

  return {
    currentFolderId,
    contentsState,
    navigate,
    refresh,
    cancel: guard.cancel,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    moveDocument,
  };
}
