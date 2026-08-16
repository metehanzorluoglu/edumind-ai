import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWritingProjectImport } from '../../src/hooks/useWritingProjectImport';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProject } from '../../src/types/writing';
import type { WritingProjectImportInspection } from '../../src/types/writingImport';

function makeInspection(
  overrides: Partial<WritingProjectImportInspection> = {}
): WritingProjectImportInspection {
  return {
    session_id: 's1',
    suggested_title: 'Imported Project',
    files: [{ path: 'main.tex', kind: 'text', size_bytes: 20 }],
    root_candidates: ['main.tex'],
    preselected_root: 'main.tex',
    warnings: [],
    total_size_bytes: 20,
    expires_at: '2026-01-01T00:30:00Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<WritingProject> = {}): WritingProject {
  return {
    id: 'w1',
    title: 'Imported Paper',
    description: null,
    main_tex_content: '\\documentclass{article}',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFile(name = 'project.zip'): File {
  return new File(['zip bytes'], name, { type: 'application/zip' });
}

describe('useWritingProjectImport', () => {
  it('inspect() transitions inspecting -> success with the returned inspection', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    const client = { inspectWritingProjectImport } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    expect(result.current.inspectState.status).toBe('inspecting');

    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));
    const state = result.current.inspectState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.inspection.session_id).toBe('s1');
  });

  it('inspect() failure (rejected archive) produces an error state', async () => {
    const inspectWritingProjectImport = vi
      .fn()
      .mockRejectedValue(new Error('Archive contains an unsafe path'));
    const client = { inspectWritingProjectImport } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile('evil.zip'));
    });

    await waitFor(() => expect(result.current.inspectState.status).toBe('error'));
  });

  it('a second inspect() call supersedes the first (only the latest result is kept)', async () => {
    const inspectWritingProjectImport = vi
      .fn()
      .mockResolvedValueOnce(makeInspection({ session_id: 'first' }))
      .mockResolvedValueOnce(makeInspection({ session_id: 'second' }));
    const client = { inspectWritingProjectImport } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
      result.current.inspect(makeFile());
    });

    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));
    const state = result.current.inspectState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.inspection.session_id).toBe('second');
  });

  it('confirmImport() throws without a successfully inspected archive', async () => {
    const client = {} as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    await expect(result.current.confirmImport({ title: 'X' })).rejects.toThrow(
      'confirmImport() called without a successfully inspected archive.'
    );
  });

  it('confirmImport() creates the project and resets both states to idle on success', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    const confirmWritingProjectImport = vi.fn().mockResolvedValue(makeProject());
    const client = {
      inspectWritingProjectImport,
      confirmWritingProjectImport,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));

    const project = await act(() => result.current.confirmImport({ title: 'Imported Paper' }));

    expect(project.id).toBe('w1');
    expect(confirmWritingProjectImport).toHaveBeenCalledWith('s1', { title: 'Imported Paper' });
    expect(result.current.confirmState.status).toBe('idle');
    expect(result.current.inspectState.status).toBe('idle');
  });

  it('confirmImport() failure surfaces an error via confirmState but keeps inspectState (user can retry with a different root_path)', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    const confirmWritingProjectImport = vi.fn().mockRejectedValue(new Error('root_path is required'));
    const client = {
      inspectWritingProjectImport,
      confirmWritingProjectImport,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.confirmImport({ title: 'X' });
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error)?.message).toBe('root_path is required');
    expect(result.current.confirmState.status).toBe('error');
    expect(result.current.inspectState.status).toBe('success');
  });

  it('confirmImport() rejects a second concurrent call while one is already in flight', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    let resolveConfirm: (project: WritingProject) => void = () => {};
    const confirmWritingProjectImport = vi.fn(
      () =>
        new Promise<WritingProject>((resolve) => {
          resolveConfirm = resolve;
        })
    );
    const client = {
      inspectWritingProjectImport,
      confirmWritingProjectImport,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));

    let secondError: unknown;
    act(() => {
      result.current.confirmImport({ title: 'First' });
      result.current.confirmImport({ title: 'Second' }).catch((error: unknown) => {
        secondError = error;
      });
    });

    await waitFor(() => expect(secondError).toBeDefined());
    expect((secondError as Error).message).toBe(
      'A project is already being created from this import.'
    );
    expect(confirmWritingProjectImport).toHaveBeenCalledTimes(1);

    resolveConfirm(makeProject());
    await waitFor(() => expect(result.current.inspectState.status).toBe('idle'));
  });

  it('discardImport() cancels the staged session and resets to idle', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    const cancelWritingProjectImport = vi.fn().mockResolvedValue(undefined);
    const client = {
      inspectWritingProjectImport,
      cancelWritingProjectImport,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));

    act(() => {
      result.current.discardImport();
    });

    expect(cancelWritingProjectImport).toHaveBeenCalledWith('s1');
    expect(result.current.inspectState.status).toBe('idle');
    expect(result.current.confirmState.status).toBe('idle');
  });

  it('discardImport() is a safe no-op when nothing has been inspected yet', () => {
    const cancelWritingProjectImport = vi.fn();
    const client = { cancelWritingProjectImport } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.discardImport();
    });

    expect(cancelWritingProjectImport).not.toHaveBeenCalled();
    expect(result.current.inspectState.status).toBe('idle');
  });

  it('discardImport() never surfaces a failed server-side cancel (already-expired session is an equally valid end state)', async () => {
    const inspectWritingProjectImport = vi.fn().mockResolvedValue(makeInspection());
    const cancelWritingProjectImport = vi.fn().mockRejectedValue(new Error('404 not found'));
    const client = {
      inspectWritingProjectImport,
      cancelWritingProjectImport,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectImport(client));

    act(() => {
      result.current.inspect(makeFile());
    });
    await waitFor(() => expect(result.current.inspectState.status).toBe('success'));

    act(() => {
      result.current.discardImport();
    });

    expect(result.current.inspectState.status).toBe('idle');
  });
});
