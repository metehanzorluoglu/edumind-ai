import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { UploadableFile } from '../types/documents';
import type {
  ConfirmWritingProjectImportRequest,
  WritingProjectImportInspection,
} from '../types/writingImport';
import type { WritingProject } from '../types/writing';

export type WritingProjectImportInspectState =
  | { status: 'idle' }
  | { status: 'inspecting' }
  | { status: 'success'; inspection: WritingProjectImportInspection }
  | { status: 'cancelled' }
  /** A rejected archive (Parts 6-8's release-critical categories) — the
   * ArchiveRejected message is already user-safe (no path/stack detail),
   * see the backend's own docstring. */
  | { status: 'error'; error: EducationAssistantError };

export type ConfirmWritingProjectImportState =
  | { status: 'idle' }
  | { status: 'confirming' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseWritingProjectImportResult {
  /** Part 5/6/9 — the ENTIRE security pipeline runs before this
   * resolves; only a successfully inspected archive can ever reach
   * confirmImport(). Fire-and-forget: superseding calls (e.g. the user
   * picks a different file) cancel the previous inspect request. */
  inspectState: WritingProjectImportInspectState;
  inspect: (file: UploadableFile) => void;
  cancelInspect: () => void;

  /**
   * Part 15 — creates the project atomically from the current
   * inspectState's session. Requires inspectState to be 'success';
   * throws otherwise. On success, clears inspectState back to 'idle'
   * (the session no longer exists — it was consumed). Returns the new
   * WritingProject so the caller can navigate to it.
   */
  confirmState: ConfirmWritingProjectImportState;
  confirmImport: (request: ConfirmWritingProjectImportRequest) => Promise<WritingProject>;

  /**
   * Discards the current inspected session (Part 32: "cleanup on
   * success/cancel/failure/timeout") and resets inspectState to 'idle'.
   * Best-effort — a session that's already expired/gone 404s server-side
   * and is silently treated as already-discarded, never surfaced as an
   * error to the caller (the end state — no session — is identical
   * either way).
   */
  discardImport: () => void;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 5/9/14/15/31/32
 * — the ZIP-import "upload -> inspect -> preview -> confirm/cancel"
 * flow's data source. Follows the exact same async-guard/fire-and-
 * forget pattern useEducationDocuments.ts uses for its metadata-preview
 * step, since this is the same shape of problem: inspect (like
 * preview) is read-only and safe to re-run for a different file;
 * confirm (like upload) is the one call that actually creates
 * something and is guarded against double-submission.
 */
export function useWritingProjectImport(
  client: EducationAssistantClient
): UseWritingProjectImportResult {
  const [inspectState, setInspectState] = useState<WritingProjectImportInspectState>({
    status: 'idle',
  });
  const [confirmState, setConfirmState] = useState<ConfirmWritingProjectImportState>({
    status: 'idle',
  });
  const inspectGuard = useAsyncGuard();
  const isMountedRef = useRef(true);
  const confirmingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const inspect = useCallback(
    (file: UploadableFile) => {
      const { signal, isCurrent } = inspectGuard.begin();
      setInspectState({ status: 'inspecting' });
      setConfirmState({ status: 'idle' });

      client
        .inspectWritingProjectImport(file, { signal })
        .then((inspection) => {
          if (!isCurrent()) return;
          setInspectState({ status: 'success', inspection });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setInspectState({ status: 'cancelled' });
            return;
          }
          setInspectState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, inspectGuard]
  );

  const cancelInspect = useCallback(() => {
    inspectGuard.cancel();
  }, [inspectGuard]);

  const confirmImport = useCallback(
    async (request: ConfirmWritingProjectImportRequest): Promise<WritingProject> => {
      if (inspectState.status !== 'success') {
        throw new EducationAssistantError(
          'confirmImport() called without a successfully inspected archive.'
        );
      }
      if (confirmingRef.current) {
        throw new EducationAssistantError('A project is already being created from this import.');
      }
      const sessionId = inspectState.inspection.session_id;
      confirmingRef.current = true;
      setConfirmState({ status: 'confirming' });
      try {
        const project = await client.confirmWritingProjectImport(sessionId, request);
        if (isMountedRef.current) {
          setConfirmState({ status: 'idle' });
          setInspectState({ status: 'idle' });
        }
        return project;
      } catch (error) {
        if (isMountedRef.current) {
          setConfirmState({ status: 'error', error: toAssistantError(error) });
        }
        throw error;
      } finally {
        confirmingRef.current = false;
      }
    },
    [client, inspectState]
  );

  const discardImport = useCallback(() => {
    inspectGuard.cancel();
    if (inspectState.status === 'success') {
      // Best-effort: an already-expired/consumed session 404s, which is
      // an equally valid "no session remains" end state — never surfaced.
      client.cancelWritingProjectImport(inspectState.inspection.session_id).catch(() => {});
    }
    setInspectState({ status: 'idle' });
    setConfirmState({ status: 'idle' });
  }, [client, inspectGuard, inspectState]);

  return {
    inspectState,
    inspect,
    cancelInspect,
    confirmState,
    confirmImport,
    discardImport,
  };
}
