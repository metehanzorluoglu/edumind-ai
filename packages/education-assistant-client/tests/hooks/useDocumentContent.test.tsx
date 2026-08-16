import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDocumentContent } from '../../src/hooks/useDocumentContent';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { DocumentContentResponse } from '../../src/types/documents';

function makeContent(overrides: Partial<DocumentContentResponse> = {}): DocumentContentResponse {
  return {
    document_id: 'd1',
    document_type: 'unknown',
    title: 'A Study',
    source_filename: 'paper.pdf',
    file_format: 'pdf',
    page_count: 2,
    chunks: [
      { chunk_id: 'c0', chunk_index: 0, page_number: 1, text: 'Page one text.' },
      { chunk_id: 'c1', chunk_index: 1, page_number: 2, text: 'Page two text.' },
    ],
    original_file_available: false,
    has_usable_doi: false,
    ...overrides,
  };
}

describe('useDocumentContent', () => {
  it('refresh() transitions idle -> loading -> success with the returned content', async () => {
    const getDocumentContent = vi.fn().mockResolvedValue(makeContent());
    const client = { getDocumentContent } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentContent(client));

    expect(result.current.contentState.status).toBe('idle');

    act(() => {
      result.current.refresh('d1');
    });
    expect(result.current.contentState.status).toBe('loading');

    await waitFor(() => expect(result.current.contentState.status).toBe('success'));
    const state = result.current.contentState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.content.chunks).toHaveLength(2);
    expect(getDocumentContent).toHaveBeenCalledWith('d1', expect.anything());
  });

  it('a failed load produces an error state', async () => {
    const getDocumentContent = vi.fn().mockRejectedValue(new Error('not found'));
    const client = { getDocumentContent } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentContent(client));

    act(() => {
      result.current.refresh('missing');
    });
    await waitFor(() => expect(result.current.contentState.status).toBe('error'));
  });

  it('a superseded refresh (a second call before the first resolves) only reflects the latest result', async () => {
    let resolveFirst!: (value: DocumentContentResponse) => void;
    const first = new Promise<DocumentContentResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const getDocumentContent = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => Promise.resolve(makeContent({ document_id: 'd2' })));
    const client = { getDocumentContent } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useDocumentContent(client));

    act(() => {
      result.current.refresh('d1');
    });
    act(() => {
      result.current.refresh('d2');
    });
    await waitFor(() => expect(result.current.contentState.status).toBe('success'));
    const state = result.current.contentState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.content.document_id).toBe('d2');

    // The stale first call resolving afterward must not clobber the
    // already-current d2 result.
    resolveFirst(makeContent({ document_id: 'd1-stale' }));
    await Promise.resolve();
    const after = result.current.contentState;
    if (after.status !== 'success') throw new Error('expected success');
    expect(after.content.document_id).toBe('d2');
  });
});
