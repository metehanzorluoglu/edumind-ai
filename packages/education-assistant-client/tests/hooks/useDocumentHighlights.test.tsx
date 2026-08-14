import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDocumentHighlights } from '../../src/hooks/useDocumentHighlights';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { DocumentHighlight } from '../../src/types/documents';

function makeHighlight(overrides: Partial<DocumentHighlight> = {}): DocumentHighlight {
  return {
    id: 'h1',
    document_id: 'd1',
    chunk_id: 'c0',
    chunk_index: 0,
    page_number: 1,
    selected_text: 'Students completed a 12-week program.',
    note_text: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useDocumentHighlights', () => {
  it('refresh() transitions idle -> loading -> success with the returned highlights', async () => {
    const listDocumentHighlights = vi
      .fn()
      .mockResolvedValue({ highlights: [makeHighlight()] });
    const client = { listDocumentHighlights } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    expect(result.current.highlightsState.status).toBe('idle');

    act(() => {
      result.current.refresh('d1');
    });
    expect(result.current.highlightsState.status).toBe('loading');

    await waitFor(() => expect(result.current.highlightsState.status).toBe('success'));
    const state = result.current.highlightsState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.highlights).toHaveLength(1);
    expect(listDocumentHighlights).toHaveBeenCalledWith('d1', expect.anything());
  });

  it('a failed load produces an error state', async () => {
    const listDocumentHighlights = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listDocumentHighlights } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    act(() => {
      result.current.refresh('d1');
    });
    await waitFor(() => expect(result.current.highlightsState.status).toBe('error'));
  });

  it('createHighlight() calls createDocumentHighlight and refreshes', async () => {
    const listDocumentHighlights = vi
      .fn()
      .mockResolvedValue({ highlights: [makeHighlight()] });
    const createDocumentHighlight = vi.fn().mockResolvedValue(makeHighlight());
    const client = {
      listDocumentHighlights,
      createDocumentHighlight,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    await act(async () => {
      await result.current.createHighlight('d1', {
        chunkId: 'c0',
        chunkIndex: 0,
        pageNumber: 1,
        selectedText: 'Students completed a 12-week program.',
      });
    });

    expect(createDocumentHighlight).toHaveBeenCalledWith('d1', {
      chunkId: 'c0',
      chunkIndex: 0,
      pageNumber: 1,
      selectedText: 'Students completed a 12-week program.',
    });
    await waitFor(() => expect(result.current.highlightsState.status).toBe('success'));
  });

  it('updateHighlightNote() calls updateDocumentHighlight with the given note and refreshes', async () => {
    const listDocumentHighlights = vi
      .fn()
      .mockResolvedValue({ highlights: [makeHighlight({ note_text: 'Worth revisiting.' })] });
    const updateDocumentHighlight = vi
      .fn()
      .mockResolvedValue(makeHighlight({ note_text: 'Worth revisiting.' }));
    const client = {
      listDocumentHighlights,
      updateDocumentHighlight,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    await act(async () => {
      await result.current.updateHighlightNote('d1', 'h1', 'Worth revisiting.');
    });

    expect(updateDocumentHighlight).toHaveBeenCalledWith('d1', 'h1', {
      noteText: 'Worth revisiting.',
    });
    await waitFor(() => {
      const state = result.current.highlightsState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.highlights[0]?.note_text).toBe('Worth revisiting.');
    });
  });

  it('updateHighlightNote(null) clears the note', async () => {
    const listDocumentHighlights = vi.fn().mockResolvedValue({ highlights: [] });
    const updateDocumentHighlight = vi.fn().mockResolvedValue(makeHighlight({ note_text: null }));
    const client = {
      listDocumentHighlights,
      updateDocumentHighlight,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    await act(async () => {
      await result.current.updateHighlightNote('d1', 'h1', null);
    });

    expect(updateDocumentHighlight).toHaveBeenCalledWith('d1', 'h1', { noteText: null });
  });

  it('deleteHighlight() calls deleteDocumentHighlight and refreshes', async () => {
    const listDocumentHighlights = vi.fn().mockResolvedValue({ highlights: [] });
    const deleteDocumentHighlight = vi.fn().mockResolvedValue(undefined);
    const client = {
      listDocumentHighlights,
      deleteDocumentHighlight,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentHighlights(client));

    await act(async () => {
      await result.current.deleteHighlight('d1', 'h1');
    });

    expect(deleteDocumentHighlight).toHaveBeenCalledWith('d1', 'h1');
    await waitFor(() => {
      const state = result.current.highlightsState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.highlights).toHaveLength(0);
    });
  });
});
