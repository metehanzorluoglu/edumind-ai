import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  DocumentMetadataPreviewResponse,
  DocumentSummary,
  DocumentUploadMetadata,
  DocumentUploadResponse,
  ListDocumentsParams,
  UploadableFile,
} from '../types/documents';

export type DocumentsListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; documents: DocumentSummary[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type UploadState =
  | { status: 'idle' }
  /** Synchronous ingestion: uploading covers the whole parse+embed+index pipeline, not just the HTTP transfer. There is no separate queued/processing state because the backend has no background job queue. */
  | { status: 'uploading' }
  | { status: 'success'; document: DocumentUploadResponse }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type DeleteDocumentState =
  | { status: 'deleting' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export type MetadataPreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; preview: DocumentMetadataPreviewResponse }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseEducationDocumentsResult {
  listState: DocumentsListState;
  /** Fetches (or re-fetches) the document list, superseding any in-flight list request. */
  refresh: (params?: ListDocumentsParams) => void;
  cancelList: () => void;

  uploadState: UploadState;
  /**
   * Uploads one document. The promise resolves only once ingestion is
   * fully complete (chunked, embedded, indexed) — POST /documents is
   * synchronous on the backend, so there is nothing to poll. Does not
   * automatically refresh the list; call refresh() afterward if the UI
   * should reflect the new document.
   */
  upload: (file: UploadableFile, metadata: DocumentUploadMetadata) => void;
  cancelUpload: () => void;
  resetUpload: () => void;

  previewState: MetadataPreviewState;
  /**
   * Calls POST /documents/metadata-preview for a just-picked file, so the
   * caller can show detected title/authors/publication year/venue/DOI/
   * source URL as editable fields before the user confirms the actual
   * upload() call. Pure extraction on the backend — never chunks, embeds,
   * or indexes anything, so this is safe to call again (e.g. the user
   * picked a different file) without any risk of double-indexing.
   */
  previewMetadata: (file: UploadableFile) => void;
  cancelPreview: () => void;
  resetPreview: () => void;

  /**
   * Per-document delete state, keyed by document_id. A document with no
   * entry has never had a delete attempted (equivalent to 'idle') — this
   * lets many documents' delete state be tracked independently, so
   * deleting one never disturbs another's button/spinner.
   */
  deleteStates: Record<string, DeleteDocumentState>;
  /**
   * Deletes one document by its stable document_id. A second call for the
   * same document_id while one is already 'deleting' is ignored (duplicate
   * request guard). On success, the document is optimistically removed
   * from the current listState immediately — no refresh() call needed —
   * without touching any other document in the list.
   */
  deleteDocument: (documentId: string) => void;
  /** Clears a document's delete error (e.g. before letting the user retry). */
  resetDeleteState: (documentId: string) => void;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/** GET/POST /documents. Two independent async operations (list, upload) that can be in flight at once. */
export function useEducationDocuments(
  client: EducationAssistantClient
): UseEducationDocumentsResult {
  const [listState, setListState] = useState<DocumentsListState>({ status: 'idle' });
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' });
  const [previewState, setPreviewState] = useState<MetadataPreviewState>({ status: 'idle' });
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteDocumentState>>({});
  const listGuard = useAsyncGuard();
  const uploadGuard = useAsyncGuard();
  const previewGuard = useAsyncGuard();

  // deleteDocument() tracks each document_id independently (not a single
  // in-flight operation like list/upload), so it can't reuse useAsyncGuard
  // as-is; this mirrors just the "no setState after unmount" half of it.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // A ref, not the deleteStates *value*, is what guards against duplicate
  // requests: two deleteDocument() calls for the same id issued back to
  // back (e.g. a double-click) both run before React has re-rendered with
  // the first call's 'deleting' status, so reading `deleteStates` from the
  // closure would let both through. A ref is updated synchronously and is
  // visible to the very next call regardless of render/batching timing.
  const deletingIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(
    (params: ListDocumentsParams = {}) => {
      const { signal, isCurrent } = listGuard.begin();
      setListState({ status: 'loading' });

      client
        .listDocuments(params, { signal })
        .then((response) => {
          if (!isCurrent()) return;
          setListState({ status: 'success', documents: response.documents, total: response.total });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setListState({ status: 'cancelled' });
            return;
          }
          setListState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, listGuard]
  );

  const upload = useCallback(
    (file: UploadableFile, metadata: DocumentUploadMetadata) => {
      const { signal, isCurrent } = uploadGuard.begin();
      setUploadState({ status: 'uploading' });

      client
        .uploadDocument(file, metadata, { signal })
        .then((document) => {
          if (!isCurrent()) return;
          setUploadState({ status: 'success', document });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setUploadState({ status: 'cancelled' });
            return;
          }
          setUploadState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, uploadGuard]
  );

  const resetUpload = useCallback(() => {
    uploadGuard.cancel();
    setUploadState({ status: 'idle' });
  }, [uploadGuard]);

  const previewMetadata = useCallback(
    (file: UploadableFile) => {
      const { signal, isCurrent } = previewGuard.begin();
      setPreviewState({ status: 'loading' });

      client
        .previewDocumentMetadata(file, { signal })
        .then((preview) => {
          if (!isCurrent()) return;
          setPreviewState({ status: 'success', preview });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setPreviewState({ status: 'cancelled' });
            return;
          }
          setPreviewState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, previewGuard]
  );

  const resetPreview = useCallback(() => {
    previewGuard.cancel();
    setPreviewState({ status: 'idle' });
  }, [previewGuard]);

  const deleteDocument = useCallback(
    (documentId: string) => {
      // Duplicate-request guard: a second click while this document is
      // already deleting is a no-op, not a second HTTP request.
      if (deletingIdsRef.current.has(documentId)) return;
      deletingIdsRef.current.add(documentId);

      setDeleteStates((prev) => ({ ...prev, [documentId]: { status: 'deleting' } }));

      client
        .deleteDocument(documentId)
        .then(() => {
          deletingIdsRef.current.delete(documentId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({ ...prev, [documentId]: { status: 'success' } }));
          // Optimistic local removal: reflects the deletion immediately
          // without a round-trip refresh(), and only ever touches the one
          // matching entry — every other document in the list is untouched.
          setListState((prev) =>
            prev.status === 'success'
              ? {
                  status: 'success',
                  documents: prev.documents.filter((doc) => doc.document_id !== documentId),
                  total: Math.max(0, prev.total - 1),
                }
              : prev
          );
        })
        .catch((error: unknown) => {
          deletingIdsRef.current.delete(documentId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({
            ...prev,
            [documentId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client]
  );

  const resetDeleteState = useCallback((documentId: string) => {
    setDeleteStates((prev) => {
      if (!(documentId in prev)) return prev;
      const next = { ...prev };
      delete next[documentId];
      return next;
    });
  }, []);

  return {
    listState,
    refresh,
    cancelList: listGuard.cancel,
    uploadState,
    upload,
    cancelUpload: uploadGuard.cancel,
    resetUpload,
    previewState,
    previewMetadata,
    cancelPreview: previewGuard.cancel,
    resetPreview,
    deleteStates,
    deleteDocument,
    resetDeleteState,
  };
}
