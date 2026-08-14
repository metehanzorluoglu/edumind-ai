import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useNotebooks } from '../../src/hooks/useNotebooks';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { Notebook } from '../../src/types/notebooks';

function makeNotebook(overrides: Partial<Notebook> = {}): Notebook {
  return {
    id: 'nb-1',
    name: 'Reading List',
    entry_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useNotebooks', () => {
  it('refresh() transitions idle -> loading -> success', async () => {
    const listNotebooks = vi.fn().mockResolvedValue({ notebooks: [makeNotebook()], total: 1 });
    const client = { listNotebooks } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebooks(client));

    expect(result.current.notebooksState.status).toBe('idle');
    act(() => result.current.refresh());
    expect(result.current.notebooksState.status).toBe('loading');

    await waitFor(() => expect(result.current.notebooksState.status).toBe('success'));
    const state = result.current.notebooksState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.notebooks).toHaveLength(1);
  });

  it('a failed load produces an error state', async () => {
    const listNotebooks = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listNotebooks } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebooks(client));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.notebooksState.status).toBe('error'));
  });

  it('create() calls createNotebook, refreshes, and returns the created notebook', async () => {
    const listNotebooks = vi.fn().mockResolvedValue({ notebooks: [makeNotebook()], total: 1 });
    const createNotebook = vi.fn().mockResolvedValue(makeNotebook());
    const client = { listNotebooks, createNotebook } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebooks(client));

    let created: Notebook | undefined;
    await act(async () => {
      created = await result.current.create('Reading List');
    });

    expect(createNotebook).toHaveBeenCalledWith({ name: 'Reading List' });
    expect(created?.id).toBe('nb-1');
    await waitFor(() => expect(result.current.notebooksState.status).toBe('success'));
  });

  it('rename() calls renameNotebook and refreshes', async () => {
    const listNotebooks = vi
      .fn()
      .mockResolvedValue({ notebooks: [makeNotebook({ name: 'Renamed' })], total: 1 });
    const renameNotebook = vi.fn().mockResolvedValue(makeNotebook({ name: 'Renamed' }));
    const client = { listNotebooks, renameNotebook } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebooks(client));

    await act(async () => {
      await result.current.rename('nb-1', 'Renamed');
    });

    expect(renameNotebook).toHaveBeenCalledWith('nb-1', { name: 'Renamed' });
    await waitFor(() => {
      const state = result.current.notebooksState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.notebooks[0]?.name).toBe('Renamed');
    });
  });

  it('remove() calls deleteNotebook and refreshes', async () => {
    const listNotebooks = vi.fn().mockResolvedValue({ notebooks: [], total: 0 });
    const deleteNotebook = vi.fn().mockResolvedValue(undefined);
    const client = { listNotebooks, deleteNotebook } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebooks(client));

    await act(async () => {
      await result.current.remove('nb-1');
    });

    expect(deleteNotebook).toHaveBeenCalledWith('nb-1');
    await waitFor(() => {
      const state = result.current.notebooksState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.notebooks).toHaveLength(0);
    });
  });
});
