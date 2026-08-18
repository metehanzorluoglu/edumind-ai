import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWritingProjectReferenceMode } from '../../src/hooks/useWritingProjectReferenceMode';
import { EducationAssistantError } from '../../src/client/errors';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProjectReferenceMode } from '../../src/types/writing';

function makeMode(overrides: Partial<WritingProjectReferenceMode> = {}): WritingProjectReferenceMode {
  return {
    mode: 'edum8_library',
    bibliography_source: 'references.bib',
    citation_key_source: 'edum8',
    keys: [],
    edum8_available: false,
    no_key_source_reason: null,
    edum8_switch_proposal: null,
    edum8_switch_instructions: null,
    ...overrides,
  };
}

describe('useWritingProjectReferenceMode', () => {
  it('loads reference-mode state on mount', async () => {
    const getWritingProjectReferenceMode = vi.fn().mockResolvedValue(makeMode());
    const client = { getWritingProjectReferenceMode } as unknown as EducationAssistantClient;

    const { result } = renderHook(() => useWritingProjectReferenceMode(client, 'w1'));

    expect(result.current.referenceModeState.status).toBe('loading');
    await waitFor(() => expect(result.current.referenceModeState.status).toBe('success'));
    expect(getWritingProjectReferenceMode).toHaveBeenCalledWith('w1');
    if (result.current.referenceModeState.status === 'success') {
      expect(result.current.referenceModeState.data.mode).toBe('edum8_library');
    }
  });

  it('surfaces a fetch error as the error state', async () => {
    const getWritingProjectReferenceMode = vi
      .fn()
      .mockRejectedValue(new EducationAssistantError('boom'));
    const client = { getWritingProjectReferenceMode } as unknown as EducationAssistantClient;

    const { result } = renderHook(() => useWritingProjectReferenceMode(client, 'w1'));

    await waitFor(() => expect(result.current.referenceModeState.status).toBe('error'));
  });

  it('reload() re-fetches and only the latest call wins against an out-of-order response', async () => {
    let resolveFirst!: (value: WritingProjectReferenceMode) => void;
    const first = new Promise<WritingProjectReferenceMode>((resolve) => {
      resolveFirst = resolve;
    });
    const getWritingProjectReferenceMode = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(makeMode({ mode: 'imported_bib', bibliography_source: 'x.bib' }));
    const client = { getWritingProjectReferenceMode } as unknown as EducationAssistantClient;

    const { result } = renderHook(() => useWritingProjectReferenceMode(client, 'w1'));
    act(() => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.referenceModeState.status).toBe('success'));
    if (result.current.referenceModeState.status === 'success') {
      expect(result.current.referenceModeState.data.mode).toBe('imported_bib');
    }

    // The stale first call resolving late must never clobber the
    // already-current second result.
    resolveFirst(makeMode({ mode: 'edum8_library' }));
    await Promise.resolve();
    if (result.current.referenceModeState.status === 'success') {
      expect(result.current.referenceModeState.data.mode).toBe('imported_bib');
    }
  });

  it('applyEdum8Switch throws without calling the client when there is no current proposal', async () => {
    const getWritingProjectReferenceMode = vi.fn().mockResolvedValue(makeMode());
    const switchWritingProjectToEdum8References = vi.fn();
    const client = {
      getWritingProjectReferenceMode,
      switchWritingProjectToEdum8References,
    } as unknown as EducationAssistantClient;

    const { result } = renderHook(() => useWritingProjectReferenceMode(client, 'w1'));
    await waitFor(() => expect(result.current.referenceModeState.status).toBe('success'));

    await expect(result.current.applyEdum8Switch()).rejects.toThrow();
    expect(switchWritingProjectToEdum8References).not.toHaveBeenCalled();
  });

  it('applyEdum8Switch applies exactly the current proposal and reloads afterward', async () => {
    const proposal = { file_path: 'main.tex', find: '\\bibliography{mydb}', replace: '\\bibliography{references}' };
    const getWritingProjectReferenceMode = vi
      .fn()
      .mockResolvedValueOnce(
        makeMode({ mode: 'imported_bib', bibliography_source: 'mydb.bib', edum8_switch_proposal: proposal })
      )
      .mockResolvedValueOnce(makeMode({ mode: 'edum8_library' }));
    const updatedFile = { id: 'root-file', parent_id: null, kind: 'text', name: 'main.tex', path: 'main.tex', mime_type: null, size_bytes: 5, is_root: true };
    const switchWritingProjectToEdum8References = vi
      .fn()
      .mockResolvedValue({ file: updatedFile });
    const client = {
      getWritingProjectReferenceMode,
      switchWritingProjectToEdum8References,
    } as unknown as EducationAssistantClient;

    const { result } = renderHook(() => useWritingProjectReferenceMode(client, 'w1'));
    await waitFor(() => expect(result.current.referenceModeState.status).toBe('success'));

    let returnedFile;
    await act(async () => {
      returnedFile = await result.current.applyEdum8Switch();
    });

    expect(switchWritingProjectToEdum8References).toHaveBeenCalledWith('w1', {
      filePath: 'main.tex',
      find: '\\bibliography{mydb}',
      replace: '\\bibliography{references}',
    });
    expect(returnedFile).toEqual(updatedFile);
    await waitFor(() =>
      expect(
        result.current.referenceModeState.status === 'success' &&
          result.current.referenceModeState.data.mode
      ).toBe('edum8_library')
    );
  });
});
