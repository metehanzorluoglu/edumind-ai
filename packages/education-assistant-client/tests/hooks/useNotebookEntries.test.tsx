import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useNotebookEntries } from '../../src/hooks/useNotebookEntries';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { NotebookEntry } from '../../src/types/notebooks';

function makeEntry(overrides: Partial<NotebookEntry> = {}): NotebookEntry {
  return {
    id: 'e1',
    notebook_id: 'nb-1',
    entry_type: 'highlight',
    highlight_id: 'h1',
    document_id: 'd1',
    document_title: 'AI Education',
    page_number: 3,
    excerpt: 'Students completed a 12-week program.',
    note_text: null,
    chunk_id: 'c0',
    chunk_index: 0,
    visual_anchor: null,
    source_available: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useNotebookEntries', () => {
  it('refresh() transitions idle -> loading -> success', async () => {
    const listNotebookEntries = vi.fn().mockResolvedValue({ entries: [makeEntry()], total: 1 });
    const client = { listNotebookEntries } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebookEntries(client));

    expect(result.current.entriesState.status).toBe('idle');
    act(() => result.current.refresh('nb-1'));
    expect(result.current.entriesState.status).toBe('loading');

    await waitFor(() => expect(result.current.entriesState.status).toBe('success'));
    const state = result.current.entriesState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.entries).toHaveLength(1);
    expect(listNotebookEntries).toHaveBeenCalledWith('nb-1', {}, expect.anything());
  });

  it('addEntry() with entryType "highlight" calls addNotebookEntry and refreshes', async () => {
    const listNotebookEntries = vi.fn().mockResolvedValue({ entries: [makeEntry()], total: 1 });
    const addNotebookEntry = vi.fn().mockResolvedValue(makeEntry());
    const client = { listNotebookEntries, addNotebookEntry } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebookEntries(client));

    let added: NotebookEntry | undefined;
    await act(async () => {
      added = await result.current.addEntry('nb-1', {
        entryType: 'highlight',
        documentId: 'd1',
        highlightId: 'h1',
      });
    });

    expect(addNotebookEntry).toHaveBeenCalledWith('nb-1', {
      entryType: 'highlight',
      documentId: 'd1',
      highlightId: 'h1',
    });
    expect(added?.id).toBe('e1');
    await waitFor(() => expect(result.current.entriesState.status).toBe('success'));
  });

  it('addEntry() with entryType "manual" calls addNotebookEntry and refreshes', async () => {
    const listNotebookEntries = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    const addNotebookEntry = vi
      .fn()
      .mockResolvedValue(makeEntry({ entry_type: 'manual', highlight_id: null, note_text: 'A thought.' }));
    const client = { listNotebookEntries, addNotebookEntry } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebookEntries(client));

    await act(async () => {
      await result.current.addEntry('nb-1', { entryType: 'manual', noteText: 'A thought.' });
    });

    expect(addNotebookEntry).toHaveBeenCalledWith('nb-1', {
      entryType: 'manual',
      noteText: 'A thought.',
    });
  });

  it('updateEntryNote() calls updateNotebookEntry and refreshes', async () => {
    const listNotebookEntries = vi
      .fn()
      .mockResolvedValue({ entries: [makeEntry({ note_text: 'Edited.' })], total: 1 });
    const updateNotebookEntry = vi.fn().mockResolvedValue(makeEntry({ note_text: 'Edited.' }));
    const client = {
      listNotebookEntries,
      updateNotebookEntry,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebookEntries(client));

    await act(async () => {
      await result.current.updateEntryNote('nb-1', 'e1', 'Edited.');
    });

    expect(updateNotebookEntry).toHaveBeenCalledWith('nb-1', 'e1', { noteText: 'Edited.' });
    await waitFor(() => {
      const state = result.current.entriesState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.entries[0]?.note_text).toBe('Edited.');
    });
  });

  it('removeEntry() calls removeNotebookEntry and refreshes', async () => {
    const listNotebookEntries = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    const removeNotebookEntry = vi.fn().mockResolvedValue(undefined);
    const client = {
      listNotebookEntries,
      removeNotebookEntry,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useNotebookEntries(client));

    await act(async () => {
      await result.current.removeEntry('nb-1', 'e1');
    });

    expect(removeNotebookEntry).toHaveBeenCalledWith('nb-1', 'e1');
    await waitFor(() => {
      const state = result.current.entriesState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.entries).toHaveLength(0);
    });
  });
});
