import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEducationDocuments } from '../../src/hooks/useEducationDocuments';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type {
  DocumentJobResponse,
  DocumentSummary,
  DocumentUploadResponse,
} from '../../src/types/documents';

const uploadResponse: DocumentUploadResponse = {
  document_id: 'doc-1',
  source_filename: 'paper.pdf',
  file_format: 'pdf',
  document_type: 'journal_article',
  authors: [],
  page_count: 1,
  chunk_count: 1,
  ingested_at: '2026-01-01T00:00:00Z',
  original_file_available: false,
};

function makeDocument(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: 'doc-1',
    source_filename: 'paper.pdf',
    document_type: 'journal_article',
    authors: [],
    chunk_count: 3,
    ingested_at: '2026-01-01T00:00:00Z',
    original_file_available: false,
    ...overrides,
  };
}

describe('useEducationDocuments', () => {
  it('refresh() transitions loading -> success with the returned documents', async () => {
    const listDocuments = vi.fn().mockResolvedValue({ documents: [], total: 0 });
    const client = {
      listDocuments,
      uploadDocument: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.refresh();
    });
    expect(result.current.listState.status).toBe('loading');

    await waitFor(() => expect(result.current.listState.status).toBe('success'));
  });

  it('upload() transitions uploading -> success', async () => {
    const uploadDocument = vi.fn().mockResolvedValue(uploadResponse);
    const client = {
      uploadDocument,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.upload(
        { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
        { documentType: 'journal_article' }
      );
    });
    expect(result.current.uploadState.status).toBe('uploading');

    await waitFor(() => expect(result.current.uploadState.status).toBe('success'));
    const state = result.current.uploadState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.document.document_id).toBe('doc-1');
  });

  it('upload() surfaces backend ingestion-job progress via a processing state before resolving', async () => {
    const progressJob: DocumentJobResponse = {
      job_id: 'job-1',
      status: 'processing',
      stage: 'embedding',
      total_chunks: 272,
      embedded_chunks: 96,
      document: null,
      error: null,
    };
    const uploadDocument = vi
      .fn()
      .mockImplementation(
        (
          _file: unknown,
          _metadata: unknown,
          options: { onProgress?: (job: DocumentJobResponse) => void }
        ) => {
          options.onProgress?.(progressJob);
          return Promise.resolve(uploadResponse);
        }
      );
    const client = {
      uploadDocument,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.upload(
        { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
        { documentType: 'journal_article' }
      );
    });

    await waitFor(() => expect(result.current.uploadState.status).toBe('processing'));
    const processingState = result.current.uploadState;
    if (processingState.status !== 'processing') throw new Error('expected processing');
    expect(processingState.job.embedded_chunks).toBe(96);
    expect(processingState.job.total_chunks).toBe(272);

    await waitFor(() => expect(result.current.uploadState.status).toBe('success'));
  });

  it('upload() failure produces an error state', async () => {
    const uploadDocument = vi.fn().mockRejectedValue(new Error('upload failed'));
    const client = {
      uploadDocument,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.upload(
        { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
        { documentType: 'journal_article' }
      );
    });

    await waitFor(() => expect(result.current.uploadState.status).toBe('error'));
  });

  it('aborts an in-flight upload signal on unmount, independently of an in-flight list request', () => {
    let uploadSignal: AbortSignal | undefined;
    let listSignal: AbortSignal | undefined;
    const client = {
      uploadDocument: vi
        .fn()
        .mockImplementation((_file: unknown, _meta: unknown, options: { signal?: AbortSignal }) => {
          uploadSignal = options.signal;
          return new Promise(() => {});
        }),
      listDocuments: vi
        .fn()
        .mockImplementation((_params: unknown, options: { signal?: AbortSignal }) => {
          listSignal = options.signal;
          return new Promise(() => {});
        }),
    } as unknown as EducationAssistantClient;

    const { result, unmount } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.upload(
        { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
        { documentType: 'journal_article' }
      );
      result.current.refresh();
    });

    expect(uploadSignal?.aborted).toBe(false);
    expect(listSignal?.aborted).toBe(false);

    unmount();

    expect(uploadSignal?.aborted).toBe(true);
    expect(listSignal?.aborted).toBe(true);
  });

  it('previewMetadata() transitions loading -> success with the returned preview', async () => {
    const previewDocumentMetadata = vi.fn().mockResolvedValue({
      title: 'Preview Title',
      authors: ['Ada Lovelace'],
      publication_year: 2020,
      source_venue: null,
      doi: null,
      source_url: null,
      page_count: 2,
      file_format: 'pdf',
      extraction_sources: { title: 'embedded_metadata' },
      extraction_confidence: { title: 'high' },
    });
    const client = {
      previewDocumentMetadata,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.previewMetadata({
        uri: 'file:///tmp/paper.pdf',
        name: 'paper.pdf',
        type: 'application/pdf',
      });
    });
    expect(result.current.previewState.status).toBe('loading');

    await waitFor(() => expect(result.current.previewState.status).toBe('success'));
    const state = result.current.previewState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.preview.title).toBe('Preview Title');
    expect(state.preview.authors).toEqual(['Ada Lovelace']);
  });

  it('previewMetadata() failure produces an error state', async () => {
    const previewDocumentMetadata = vi.fn().mockRejectedValue(new Error('preview failed'));
    const client = {
      previewDocumentMetadata,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.previewMetadata({
        uri: 'file:///tmp/paper.pdf',
        name: 'paper.pdf',
        type: 'application/pdf',
      });
    });

    await waitFor(() => expect(result.current.previewState.status).toBe('error'));
  });

  it('resetPreview() returns previewState to idle', async () => {
    const previewDocumentMetadata = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      previewDocumentMetadata,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.previewMetadata({
        uri: 'file:///tmp/paper.pdf',
        name: 'paper.pdf',
        type: 'application/pdf',
      });
    });
    await waitFor(() => expect(result.current.previewState.status).toBe('error'));

    act(() => {
      result.current.resetPreview();
    });
    expect(result.current.previewState.status).toBe('idle');
  });

  it('a stale preview response can never overwrite a newer file selection\'s metadata', async () => {
    // Simulates picking file A (slow preview), then quickly switching to
    // file B (fast preview) before A's response has arrived — A's response
    // must never land in state after B's already has, even though A's
    // promise resolves *after* B's call was made.
    let resolveFirst: ((value: unknown) => void) | undefined;
    const previewDocumentMetadata = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          title: 'File B Title',
          authors: ['File B Author'],
          publication_year: 2024,
          source_venue: null,
          doi: null,
          source_url: null,
          page_count: 1,
          file_format: 'pdf',
          extraction_sources: {},
          extraction_confidence: {},
        })
      );
    const client = {
      previewDocumentMetadata,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.previewMetadata({
        uri: 'file:///tmp/a.pdf',
        name: 'a.pdf',
        type: 'application/pdf',
      });
    });
    act(() => {
      result.current.previewMetadata({
        uri: 'file:///tmp/b.pdf',
        name: 'b.pdf',
        type: 'application/pdf',
      });
    });

    await waitFor(() => expect(result.current.previewState.status).toBe('success'));
    const beforeStaleResolution = result.current.previewState;
    if (beforeStaleResolution.status !== 'success') throw new Error('expected success');
    expect(beforeStaleResolution.preview.title).toBe('File B Title');

    // Now let file A's stale response resolve — it must be silently
    // dropped (its request was already aborted/superseded), not applied.
    await act(async () => {
      resolveFirst?.({
        title: 'File A Title (stale)',
        authors: ['Stale Author'],
        publication_year: 1999,
        source_venue: null,
        doi: null,
        source_url: null,
        page_count: 1,
        file_format: 'pdf',
        extraction_sources: {},
        extraction_confidence: {},
      });
    });

    const finalState = result.current.previewState;
    if (finalState.status !== 'success') throw new Error('expected success');
    expect(finalState.preview.title).toBe('File B Title');
  });

  it('selecting a file, then a different one, then the very same first file again triggers a fresh request each time', async () => {
    const previewDocumentMetadata = vi.fn().mockResolvedValue({
      title: 'Preview Title',
      authors: [],
      publication_year: null,
      source_venue: null,
      doi: null,
      source_url: null,
      page_count: 1,
      file_format: 'pdf',
      extraction_sources: {},
      extraction_confidence: {},
    });
    const client = {
      previewDocumentMetadata,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    const fileA = { uri: 'file:///tmp/a.pdf', name: 'a.pdf', type: 'application/pdf' };

    act(() => {
      result.current.previewMetadata(fileA);
    });
    await waitFor(() => expect(result.current.previewState.status).toBe('success'));

    // Re-selecting the exact same filename must still issue a brand new
    // request — nothing here is allowed to short-circuit on "we already
    // previewed a file with this name."
    act(() => {
      result.current.previewMetadata(fileA);
    });
    expect(result.current.previewState.status).toBe('loading');
    await waitFor(() => expect(result.current.previewState.status).toBe('success'));

    expect(previewDocumentMetadata).toHaveBeenCalledTimes(2);
  });

  it('deleteDocument() transitions deleting -> success and removes only that document from the list', async () => {
    const deleteDocument = vi
      .fn()
      .mockResolvedValue({ deleted: true, document_id: 'doc-1', deleted_chunks: 3 });
    const client = {
      deleteDocument,
      listDocuments: vi.fn().mockResolvedValue({
        documents: [makeDocument({ document_id: 'doc-1' }), makeDocument({ document_id: 'doc-2' })],
        total: 2,
      }),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteDocument('doc-1');
    });
    expect(result.current.deleteStates['doc-1']).toEqual({ status: 'deleting' });

    await waitFor(() => expect(result.current.deleteStates['doc-1']?.status).toBe('success'));
    expect(deleteDocument).toHaveBeenCalledWith('doc-1');

    const listState = result.current.listState;
    if (listState.status !== 'success') throw new Error('expected success');
    expect(listState.documents.map((d) => d.document_id)).toEqual(['doc-2']);
    expect(listState.total).toBe(1);
  });

  it('deleteDocument() failure produces a per-document error state without touching the list', async () => {
    const deleteDocument = vi.fn().mockRejectedValue(new Error('network down'));
    const client = {
      deleteDocument,
      listDocuments: vi.fn().mockResolvedValue({ documents: [makeDocument()], total: 1 }),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteDocument('doc-1');
    });

    await waitFor(() => expect(result.current.deleteStates['doc-1']?.status).toBe('error'));
    const listState = result.current.listState;
    if (listState.status !== 'success') throw new Error('expected success');
    expect(listState.documents).toHaveLength(1);
  });

  it('deleteDocument() ignores a second call for the same document while one is already in flight', () => {
    const deleteDocument = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = {
      deleteDocument,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.deleteDocument('doc-1');
      result.current.deleteDocument('doc-1');
    });

    expect(deleteDocument).toHaveBeenCalledTimes(1);
  });

  it('deleting one document does not affect another document already mid-delete', async () => {
    let resolveFirst: (() => void) | undefined;
    const deleteDocument = vi.fn().mockImplementation((documentId: string) => {
      if (documentId === 'doc-1') {
        return new Promise<{ deleted: true; document_id: string; deleted_chunks: number }>(
          (resolve) => {
            resolveFirst = () =>
              resolve({ deleted: true, document_id: 'doc-1', deleted_chunks: 1 });
          }
        );
      }
      return Promise.resolve({ deleted: true, document_id: 'doc-2', deleted_chunks: 1 });
    });
    const client = {
      deleteDocument,
      listDocuments: vi.fn().mockResolvedValue({
        documents: [makeDocument({ document_id: 'doc-1' }), makeDocument({ document_id: 'doc-2' })],
        total: 2,
      }),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteDocument('doc-1');
      result.current.deleteDocument('doc-2');
    });
    expect(result.current.deleteStates['doc-1']).toEqual({ status: 'deleting' });

    await waitFor(() => expect(result.current.deleteStates['doc-2']?.status).toBe('success'));
    // doc-1's delete is still pending — must be unaffected by doc-2's completion.
    expect(result.current.deleteStates['doc-1']).toEqual({ status: 'deleting' });

    await act(async () => {
      resolveFirst?.();
    });
    await waitFor(() => expect(result.current.deleteStates['doc-1']?.status).toBe('success'));
  });

  it('resetDeleteState() clears a document delete error', async () => {
    const deleteDocument = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      deleteDocument,
      listDocuments: vi.fn(),
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useEducationDocuments(client));

    act(() => {
      result.current.deleteDocument('doc-1');
    });
    await waitFor(() => expect(result.current.deleteStates['doc-1']?.status).toBe('error'));

    act(() => {
      result.current.resetDeleteState('doc-1');
    });
    expect(result.current.deleteStates['doc-1']).toBeUndefined();
  });
});
