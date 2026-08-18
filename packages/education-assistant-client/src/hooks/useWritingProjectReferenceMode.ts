import { useCallback, useEffect, useRef, useState } from 'react';
import { EducationAssistantError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type { WritingProjectFileNode, WritingProjectReferenceMode } from '../types/writing';

export type WritingProjectReferenceModeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: WritingProjectReferenceMode }
  | { status: 'error'; error: EducationAssistantError };

export interface UseWritingProjectReferenceModeResult {
  referenceModeState: WritingProjectReferenceModeState;
  /** Re-fetches — call after any file create/rename/delete/content
   * change that could plausibly affect a project's `\bibliography{}`/
   * `\input`/`\include` structure (the caller already knows when that
   * happened; this hook never polls). */
  reload: () => void;
  /**
   * Applies EXACTLY the `edum8_switch_proposal` currently in
   * `referenceModeState.data` — never a hand-constructed find/replace.
   * Throws (never silently no-ops) if there is no current proposal, so
   * a caller can never accidentally call this from a UI state where no
   * proposal was actually shown to the user. Reloads reference-mode
   * state on success so the panel immediately reflects the new
   * edum8_library mode.
   */
  applyEdum8Switch: () => Promise<WritingProjectFileNode>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Bibliography Source Detection — a Writing Project's REAL reference
 * mode (edum8_library / imported_bib / template_tex / inline_template),
 * detected server-side from actual project content (see rag-backend's
 * app/core/reference_mode.py) rather than assumed. Deliberately a
 * separate hook from useWritingProjectFiles — this is read-mostly
 * derived state about the project's file tree, not file-tree mutation
 * itself; the Writing screen composes both hooks together and calls
 * `reload()` here after whichever file-tree mutations could plausibly
 * change the detected mode (creating/renaming/deleting a `.bib`/`.tex`
 * file, or editing the root file's content).
 */
export function useWritingProjectReferenceMode(
  client: EducationAssistantClient,
  projectId: string
): UseWritingProjectReferenceModeResult {
  const [referenceModeState, setReferenceModeState] = useState<WritingProjectReferenceModeState>({
    status: 'idle',
  });
  const isMountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const reload = useCallback(() => {
    const generation = ++generationRef.current;
    setReferenceModeState({ status: 'loading' });
    client
      .getWritingProjectReferenceMode(projectId)
      .then((data) => {
        if (!isMountedRef.current || generation !== generationRef.current) return;
        setReferenceModeState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!isMountedRef.current || generation !== generationRef.current) return;
        setReferenceModeState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const applyEdum8Switch = useCallback(async (): Promise<WritingProjectFileNode> => {
    if (referenceModeState.status !== 'success' || !referenceModeState.data.edum8_switch_proposal) {
      throw new EducationAssistantError(
        'No proposed change is currently available to apply — reload reference mode first.'
      );
    }
    const proposal = referenceModeState.data.edum8_switch_proposal;
    const result = await client.switchWritingProjectToEdum8References(projectId, {
      filePath: proposal.file_path,
      find: proposal.find,
      replace: proposal.replace,
    });
    reload();
    return result.file;
  }, [client, projectId, referenceModeState, reload]);

  return { referenceModeState, reload, applyEdum8Switch };
}
