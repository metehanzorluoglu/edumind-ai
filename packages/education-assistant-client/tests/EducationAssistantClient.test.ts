import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EducationAssistantClient } from '../src/client/EducationAssistantClient';
import {
  AuthenticationError,
  BackendError,
  ConflictError,
  NotFoundError,
  ProviderUnavailableError,
  RequestCancelledError,
  StreamingUnsupportedError,
  TimeoutError,
  ValidationError,
} from '../src/client/errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function makeClient(overrides: Partial<{ getAccessToken: () => Promise<string | null> }> = {}) {
  return new EducationAssistantClient({
    baseUrl: 'http://localhost:8000',
    getAccessToken: overrides.getAccessToken ?? (async () => 'test-token'),
    timeoutMs: 5000,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('health / ready', () => {
  it('GET /health returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 'ok', app_env: 'dev', version: '0.1.0' })
    );
    const result = await makeClient().health();
    expect(result.status).toBe('ok');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8000/health');
  });

  it('GET /health/ready returns the parsed readiness body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        status: 'ready',
        ollama_reachable: true,
        qdrant_reachable: true,
        models_available: {},
      })
    );
    const result = await makeClient().ready();
    expect(result.status).toBe('ready');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8000/health/ready');
  });
});

describe('status', () => {
  it('GET /status returns the parsed status body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        backend_reachable: true,
        ollama_reachable: true,
        qdrant_reachable: true,
        generation_model: 'qwen3:8b',
        embedding_model: 'mxbai-embed-large',
        document_count: 3,
        chunk_count: 12,
        document_type_counts: { journal_article: 2, policy_document: 1 },
        last_ingestion_at: '2026-07-20T12:00:00Z',
        relevance_threshold_enabled: false,
      })
    );
    const result = await makeClient().status();
    expect(result.document_count).toBe(3);
    expect(result.document_type_counts).toEqual({ journal_article: 2, policy_document: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8000/status');
  });

  it('sends Authorization: Bearer <token> since /status is protected', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        backend_reachable: true,
        ollama_reachable: true,
        qdrant_reachable: true,
        generation_model: 'qwen3:8b',
        embedding_model: 'mxbai-embed-large',
        document_count: 0,
        chunk_count: 0,
        document_type_counts: {},
        last_ingestion_at: null,
        relevance_threshold_enabled: false,
      })
    );
    await makeClient().status();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('rejects with AuthenticationError on a 401 response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Not authenticated' }, 401));
    await expect(makeClient().status()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('search', () => {
  it('POSTs the search request and returns results', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    const result = await makeClient().search({ query: 'assessment', top_k: 5 });
    expect(result.results).toEqual([]);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ query: 'assessment', top_k: 5 });
  });

  it('sends Authorization: Bearer <token> when a token is available', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await makeClient().search({ query: 'x', top_k: 1 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('omits Authorization entirely when getAccessToken resolves null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await makeClient({ getAccessToken: async () => null }).search({ query: 'x', top_k: 1 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe('listDocuments / uploadDocument', () => {
  it('GET /documents forwards limit and offset as query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [], total: 0 }));
    await makeClient().listDocuments({ limit: 10, offset: 20 });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('20');
  });

  // jsdom's FormData is spec-strict and rejects the { uri, name, type }
  // shape React Native's own FormData polyfill accepts natively (only a
  // real Blob/File is valid per the browser spec jsdom emulates) — swap
  // in a minimal recording fake so these tests can verify the SDK's field
  // names and value-joining logic, which is the actual RN code path.
  class FakeFormData {
    private entries: [string, unknown][] = [];
    append(key: string, value: unknown): void {
      this.entries.push([key, value]);
    }
    get(key: string): unknown {
      return this.entries.find(([k]) => k === key)?.[1] ?? null;
    }
  }

  const completedDocument = {
    document_id: 'doc-1',
    source_filename: 'paper.pdf',
    file_format: 'pdf',
    document_type: 'journal_article',
    authors: ['A. One', 'B. Two'],
    page_count: 3,
    chunk_count: 5,
    ingested_at: '2026-01-01T00:00:00Z',
  };

  it('uploadDocument POSTs multipart form data with joined authors and no manual Content-Type, then resolves once the polled job completes', async () => {
    vi.stubGlobal('FormData', FakeFormData);

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ job_id: 'job-1', status: 'processing', source_filename: 'paper.pdf' }, 202)
      )
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-1',
          status: 'completed',
          stage: 'persisting',
          total_chunks: 5,
          embedded_chunks: 5,
          document: completedDocument,
          error: null,
        })
      );

    const client = makeClient();
    const result = await client.uploadDocument(
      { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
      { documentType: 'journal_article', authors: ['A. One', 'B. Two'] }
    );

    expect(result.document_id).toBe('doc-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [postUrl, postInit] = fetchMock.mock.calls[0]!;
    expect(postUrl).toBe('http://localhost:8000/documents');
    expect(postInit.headers['Content-Type']).toBeUndefined();
    const formData = postInit.body as InstanceType<typeof FakeFormData>;
    expect(formData.get('document_type')).toBe('journal_article');
    expect(formData.get('authors')).toBe('A. One, B. Two');

    const [pollUrl, pollInit] = fetchMock.mock.calls[1]!;
    expect(pollUrl).toBe('http://localhost:8000/documents/jobs/job-1');
    expect(pollInit.method).toBe('GET');
  });

  it('uploadDocument keeps polling while processing, calling onProgress, until the job fails', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('FormData', FakeFormData);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-2', status: 'processing' }, 202))
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-2',
          status: 'processing',
          stage: 'embedding',
          total_chunks: 10,
          embedded_chunks: 4,
          document: null,
          error: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-2',
          status: 'failed',
          stage: 'embedding',
          total_chunks: 10,
          embedded_chunks: 4,
          document: null,
          error: 'Ollama embedding provider unreachable',
        })
      );

    const onProgress = vi.fn();
    const client = makeClient();
    const uploadPromise = client
      .uploadDocument(
        { uri: 'file:///tmp/paper.pdf', name: 'paper.pdf', type: 'application/pdf' },
        { documentType: 'journal_article' },
        { onProgress }
      )
      .catch((error: unknown) => error);

    // Let the POST + first poll resolve, then fast-forward past the
    // inter-poll sleep so the second (terminal) poll fires without the
    // test actually waiting DOCUMENT_JOB_POLL_INTERVAL_MS in real time.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await uploadPromise;
    expect(result).toBeInstanceOf(BackendError);
    expect((result as BackendError).message).toBe('Ollama embedding provider unreachable');
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]![0]).toMatchObject({
      status: 'processing',
      embedded_chunks: 4,
    });

    vi.useRealTimers();
  });

  it('previewDocumentMetadata posts multipart form data and returns extracted fields', async () => {
    class FakeFormData {
      private entries: [string, unknown][] = [];
      append(key: string, value: unknown): void {
        this.entries.push([key, value]);
      }
      get(key: string): unknown {
        return this.entries.find(([k]) => k === key)?.[1] ?? null;
      }
    }
    vi.stubGlobal('FormData', FakeFormData);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        title: 'Preview Title',
        authors: ['Ada Lovelace'],
        publication_year: 2020,
        source_venue: 'Journal of Examples',
        doi: '10.1234/edu.2020.001',
        source_url: null,
        page_count: 3,
        file_format: 'pdf',
        extraction_sources: { title: 'embedded_metadata' },
        extraction_confidence: { title: 'high' },
      })
    );

    const client = makeClient();
    const result = await client.previewDocumentMetadata({
      uri: 'file:///tmp/paper.pdf',
      name: 'paper.pdf',
      type: 'application/pdf',
    });

    expect(result.title).toBe('Preview Title');
    expect(result.authors).toEqual(['Ada Lovelace']);
    expect(result.extraction_sources).toEqual({ title: 'embedded_metadata' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/documents/metadata-preview');
    expect(init.headers['Content-Type']).toBeUndefined();
  });
});

describe('deleteDocument', () => {
  it('DELETE /documents/{id} returns the parsed response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ deleted: true, document_id: 'doc-1', deleted_chunks: 4 })
    );
    const result = await makeClient().deleteDocument('doc-1');

    expect(result).toEqual({ deleted: true, document_id: 'doc-1', deleted_chunks: 4 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1');
    expect(init.method).toBe('DELETE');
  });

  it('URL-encodes the document ID', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ deleted: true, document_id: 'a/b c', deleted_chunks: 0 })
    );
    await makeClient().deleteDocument('a/b c');

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/a%2Fb%20c');
  });

  it('sends Authorization: Bearer <token>', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ deleted: true, document_id: 'doc-1', deleted_chunks: 0 })
    );
    await makeClient().deleteDocument('doc-1');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('rejects with NotFoundError on a 404 response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'No document found' }, 404));
    await expect(makeClient().deleteDocument('missing-id')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('Document Reader & Highlights (Frontend Milestone 3)', () => {
  it('getDocumentContent() GETs /documents/{id}/content and returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        document_id: 'doc-1',
        title: 'A Study',
        source_filename: 'paper.pdf',
        file_format: 'pdf',
        page_count: 1,
        chunks: [{ chunk_id: 'c0', chunk_index: 0, page_number: 1, text: 'Page one text.' }],
      })
    );
    const result = await makeClient().getDocumentContent('doc-1');

    expect(result.chunks).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/content');
    expect(init.method).toBe('GET');
  });

  it('getDocumentContent() rejects with NotFoundError on a 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'No document found' }, 404));
    await expect(makeClient().getDocumentContent('missing')).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  it('listDocumentHighlights() GETs /documents/{id}/highlights', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ highlights: [] }));
    const result = await makeClient().listDocumentHighlights('doc-1');

    expect(result.highlights).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/highlights');
    expect(init.method).toBe('GET');
  });

  it('createDocumentHighlight() POSTs snake_case body fields to /documents/{id}/highlights', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'h1',
        document_id: 'doc-1',
        chunk_id: 'c0',
        chunk_index: 0,
        page_number: 1,
        selected_text: 'Students completed a 12-week program.',
        note_text: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().createDocumentHighlight('doc-1', {
      chunkId: 'c0',
      chunkIndex: 0,
      pageNumber: 1,
      selectedText: 'Students completed a 12-week program.',
      noteText: 'Worth revisiting.',
    });

    expect(result.id).toBe('h1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/highlights');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      chunk_id: 'c0',
      chunk_index: 0,
      page_number: 1,
      selected_text: 'Students completed a 12-week program.',
      note_text: 'Worth revisiting.',
      visual_anchor: null,
    });
  });

  it('createDocumentHighlight() defaults an omitted noteText to null, never undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'h1',
        document_id: 'doc-1',
        chunk_id: 'c0',
        chunk_index: 0,
        page_number: 1,
        selected_text: 'text',
        note_text: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().createDocumentHighlight('doc-1', {
      chunkId: 'c0',
      chunkIndex: 0,
      pageNumber: 1,
      selectedText: 'text',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string).note_text).toBeNull();
  });

  it('createDocumentHighlight() rejects with a 422-mapped error for a forged/mismatched anchor', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'chunk_id/chunk_index/page_number do not match a real chunk' }, 422)
    );
    await expect(
      makeClient().createDocumentHighlight('doc-1', {
        chunkId: 'bogus',
        chunkIndex: 0,
        pageNumber: 1,
        selectedText: 'text',
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updateDocumentHighlight() PATCHes { note_text } to /documents/{id}/highlights/{highlightId}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'h1',
        document_id: 'doc-1',
        chunk_id: 'c0',
        chunk_index: 0,
        page_number: 1,
        selected_text: 'text',
        note_text: 'Updated.',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().updateDocumentHighlight('doc-1', 'h1', {
      noteText: 'Updated.',
    });

    expect(result.note_text).toBe('Updated.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/highlights/h1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ note_text: 'Updated.' });
  });

  it('updateDocumentHighlight() rejects with NotFoundError for another user\'s highlight', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Highlight not found' }, 404));
    await expect(
      makeClient().updateDocumentHighlight('doc-1', 'not-mine', { noteText: 'x' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deleteDocumentHighlight() DELETEs /documents/{id}/highlights/{highlightId}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().deleteDocumentHighlight('doc-1', 'h1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/highlights/h1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteDocumentHighlight() rejects with NotFoundError on a 404', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Highlight not found' }, 404));
    await expect(
      makeClient().deleteDocumentHighlight('doc-1', 'missing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('createDocumentHighlight() sends null chunk_id/chunk_index and a real visual_anchor for a PDF-only highlight', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'h2',
        document_id: 'doc-1',
        chunk_id: null,
        chunk_index: null,
        page_number: 3,
        selected_text: 'visual-only text',
        note_text: null,
        visual_anchor: { rects: [[10, 20, 100, 40]] },
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().createDocumentHighlight('doc-1', {
      pageNumber: 3,
      selectedText: 'visual-only text',
      visualAnchor: { rects: [[10, 20, 100, 40]] },
    });

    expect(result.chunk_id).toBeNull();
    expect(result.visual_anchor).toEqual({ rects: [[10, 20, 100, 40]] });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      chunk_id: null,
      chunk_index: null,
      page_number: 3,
      selected_text: 'visual-only text',
      note_text: null,
      visual_anchor: { rects: [[10, 20, 100, 40]] },
    });
  });

  it('getHighlightNotebookMembership() GETs /documents/{id}/highlights/{highlightId}/notebooks', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        notebooks: [
          { id: 'nb-1', name: 'Reading List', entry_count: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        ],
      })
    );
    const result = await makeClient().getHighlightNotebookMembership('doc-1', 'h1');

    expect(result.notebooks).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/doc-1/highlights/h1/notebooks');
    expect(init.method).toBe('GET');
  });
});

describe('getDocumentFileRequestInit (Frontend Milestone 3.1)', () => {
  it('resolves the authenticated file URL + Authorization header, never an unauthenticated URL', async () => {
    const result = await makeClient().getDocumentFileRequestInit('doc-1');

    expect(result.url).toBe('http://localhost:8000/documents/doc-1/file');
    expect(result.httpHeaders).toEqual({ Authorization: 'Bearer test-token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns empty httpHeaders (no Authorization key) when unauthenticated', async () => {
    const result = await makeClient({ getAccessToken: async () => null }).getDocumentFileRequestInit(
      'doc-1'
    );
    expect(result.httpHeaders).toEqual({});
  });

  it('encodes a document id containing special characters into the URL path', async () => {
    const result = await makeClient().getDocumentFileRequestInit('a/b c');
    expect(result.url).toBe('http://localhost:8000/documents/a%2Fb%20c/file');
  });
});

describe('Notebook (Frontend Milestone 3.1 — Research Notes Workspace)', () => {
  it('listNotebooks() GETs /notebooks with limit/offset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ notebooks: [], total: 0 }));
    await makeClient().listNotebooks({ limit: 5, offset: 10 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks?limit=5&offset=10');
  });

  it('createNotebook() POSTs { name } to /notebooks', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'nb-1',
        name: 'Reading List',
        entry_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().createNotebook({ name: 'Reading List' });

    expect(result.id).toBe('nb-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Reading List' });
  });

  it('renameNotebook() PATCHes { name }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'nb-1',
        name: 'Renamed',
        entry_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().renameNotebook('nb-1', { name: 'Renamed' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks/nb-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed' });
  });

  it('deleteNotebook() DELETEs /notebooks/{id} and rejects with NotFoundError on a 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().deleteNotebook('nb-1');
    expect(fetchMock.mock.calls[0]![1].method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Notebook not found' }, 404));
    await expect(makeClient().deleteNotebook('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('listNotebookEntries() GETs /notebooks/{id}/entries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [], total: 0 }));
    await makeClient().listNotebookEntries('nb-1', { limit: 20, offset: 0 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks/nb-1/entries?limit=20&offset=0');
  });

  it('addNotebookEntry() with entryType "highlight" POSTs entry_type/document_id/highlight_id, never a client-supplied excerpt', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'e1',
        notebook_id: 'nb-1',
        entry_type: 'highlight',
        highlight_id: 'h1',
        document_id: 'doc-1',
        document_title: 'A Study',
        page_number: 2,
        excerpt: 'Students completed a 12-week program.',
        note_text: null,
        chunk_id: 'c0',
        chunk_index: 0,
        visual_anchor: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().addNotebookEntry('nb-1', {
      entryType: 'highlight',
      documentId: 'doc-1',
      highlightId: 'h1',
    });

    expect(result.excerpt).toBe('Students completed a 12-week program.');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks/nb-1/entries');
    expect(JSON.parse(init.body as string)).toEqual({
      entry_type: 'highlight',
      document_id: 'doc-1',
      highlight_id: 'h1',
      note_text: null,
    });
  });

  it('addNotebookEntry() with entryType "manual" POSTs entry_type/note_text only', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'e2',
        notebook_id: 'nb-1',
        entry_type: 'manual',
        highlight_id: null,
        document_id: null,
        document_title: null,
        page_number: null,
        excerpt: null,
        note_text: 'A standalone thought.',
        chunk_id: null,
        chunk_index: null,
        visual_anchor: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().addNotebookEntry('nb-1', {
      entryType: 'manual',
      noteText: 'A standalone thought.',
    });

    expect(result.entry_type).toBe('manual');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      entry_type: 'manual',
      note_text: 'A standalone thought.',
    });
  });

  it('updateNotebookEntry() PATCHes { note_text }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'e1',
        notebook_id: 'nb-1',
        entry_type: 'manual',
        highlight_id: null,
        document_id: null,
        document_title: null,
        page_number: null,
        excerpt: null,
        note_text: 'Edited.',
        chunk_id: null,
        chunk_index: null,
        visual_anchor: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().updateNotebookEntry('nb-1', 'e1', { noteText: 'Edited.' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks/nb-1/entries/e1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ note_text: 'Edited.' });
  });

  it('removeNotebookEntry() DELETEs /notebooks/{id}/entries/{entryId}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().removeNotebookEntry('nb-1', 'e1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/notebooks/nb-1/entries/e1');
    expect(init.method).toBe('DELETE');
  });
});

describe('error mapping through requestJson', () => {
  it('maps a 401 JSON error body to AuthenticationError with the backend detail', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid API key' }, 401));
    await expect(makeClient().search({ query: 'x', top_k: 1 })).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it('maps a 422 error to ValidationError carrying the raw detail array', async () => {
    const detail = [{ loc: ['body', 'top_k'], msg: 'too large', type: 'value_error' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail }, 422));
    try {
      await makeClient().search({ query: 'x', top_k: 999 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toEqual({ detail });
    }
  });

  it('never leaks a non-JSON error body verbatim into the thrown error message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html><body>Internal Server Error traceback...</body></html>', { status: 500 })
    );
    try {
      await makeClient().search({ query: 'x', top_k: 1 });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('traceback');
      expect((error as Error).message).toBe('Backend returned HTTP 500');
    }
  });
});

describe('cancellation and timeout', () => {
  it('an explicit AbortSignal produces RequestCancelledError, not TimeoutError', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = makeClient().search({ query: 'x', top_k: 1 }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('a signal already aborted before the request reaches fetch() still cancels cleanly', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }
      });
    });

    await expect(
      makeClient().search({ query: 'x', top_k: 1 }, { signal: controller.signal })
    ).rejects.toBeInstanceOf(RequestCancelledError);
  });

  it('an unresponsive backend produces TimeoutError once timeoutMs elapses', async () => {
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new EducationAssistantClient({
      baseUrl: 'http://localhost:8000',
      getAccessToken: async () => null,
      timeoutMs: 10,
    });
    await expect(client.search({ query: 'x', top_k: 1 })).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('streamChat', () => {
  it('yields token, sources, and done events in order', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'token', content: 'Hello' }),
        sseEvent({ type: 'sources', sources: [] }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
        }),
      ])
    );

    const events = [];
    for await (const event of makeClient().streamChat({ query: 'x', top_k: 3 })) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(['token', 'sources', 'done']);
  });

  it('does not abort a slow-but-progressing stream once headers have arrived (timeoutMs only bounds connection setup)', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(sseEvent({ type: 'token', content: 'slow' })));
          controller.enqueue(
            encoder.encode(
              sseEvent({
                type: 'done',
                citations: [],
                citation_warnings: [],
                insufficient_evidence: false,
              })
            )
          );
          controller.close();
        }, 50);
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const client = new EducationAssistantClient({
      baseUrl: 'http://localhost:8000',
      getAccessToken: async () => null,
      timeoutMs: 10,
    });
    const events = [];
    for await (const event of client.streamChat({ query: 'x', top_k: 1 })) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['token', 'done']);
  });

  it('throws StreamingUnsupportedError when ReadableStream is unavailable in this runtime', async () => {
    const originalReadableStream = globalThis.ReadableStream;
    // @ts-expect-error deliberately simulating a runtime without ReadableStream
    delete globalThis.ReadableStream;
    try {
      const generator = makeClient().streamChat({ query: 'x', top_k: 3 });
      await expect(generator.next()).rejects.toBeInstanceOf(StreamingUnsupportedError);
    } finally {
      globalThis.ReadableStream = originalReadableStream;
    }
  });
});

describe('chat (buffered)', () => {
  it('assembles a ChatResult from the full buffered SSE response', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'token', content: 'The answer is ' }),
        sseEvent({ type: 'token', content: '42.' }),
        sseEvent({ type: 'sources', sources: [] }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: ['Answer cites source id(s) not present in the retrieved sources: S9'],
          insufficient_evidence: false,
        }),
      ])
    );

    const result = await makeClient().chat({ query: 'x', top_k: 3 });
    expect(result.answer).toBe('The answer is 42.');
    expect(result.insufficientEvidence).toBe(false);
    expect(result.citationWarnings).toEqual([
      'Answer cites source id(s) not present in the retrieved sources: S9',
    ]);
  });

  it('surfaces insufficient_evidence with the backend-authored explanation, never fabricating one client-side', async () => {
    // Mirrors the real backend (routes_chat.py): the insufficient_evidence
    // branch still sends a token event carrying NO_EVIDENCE_ANSWER before
    // "done" — it's a real backend-authored message, not empty and not an
    // SDK-invented string.
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({
          type: 'token',
          content: 'The corpus does not contain enough evidence to answer this question.',
        }),
        sseEvent({ type: 'sources', sources: [] }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: true,
        }),
      ])
    );

    const result = await makeClient().chat({ query: 'x', top_k: 3 });
    expect(result.insufficientEvidence).toBe(true);
    expect(result.answer).toBe(
      'The corpus does not contain enough evidence to answer this question.'
    );
    expect(result.sources).toEqual([]);
  });

  it('throws BackendError when the stream emits an "error" event', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([sseEvent({ type: 'error', message: 'LLM provider failed' })])
    );
    await expect(makeClient().chat({ query: 'x', top_k: 3 })).rejects.toThrow(BackendError);
  });
});

describe('auth', () => {
  it('getAuthProviders() GETs /auth/providers unauthenticated-friendly and returns the normalized body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providers: [{ provider: 'google', display_name: 'Google' }],
        dev_login_enabled: false,
        local_auth_enabled: true,
      })
    );
    const result = await makeClient().getAuthProviders();

    expect(result).toEqual({
      providers: [{ provider: 'google', display_name: 'Google' }],
      devLoginEnabled: false,
      localAuthEnabled: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/providers');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
  });

  it('getAuthProviders() reports an OAuth provider as available', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        providers: [{ provider: 'google', display_name: 'Google' }],
        dev_login_enabled: false,
        local_auth_enabled: true,
      })
    );

    const result = await makeClient().getAuthProviders();

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toEqual({ provider: 'google', display_name: 'Google' });
  });

  it('getAuthProviders() reports devLoginEnabled true with no OAuth providers configured', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ providers: [], dev_login_enabled: true, local_auth_enabled: true })
    );

    const result = await makeClient().getAuthProviders();

    expect(result).toEqual({ providers: [], devLoginEnabled: true, localAuthEnabled: true });
  });

  it('getAuthProviders() reports devLoginEnabled false with no OAuth providers configured', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: true })
    );

    const result = await makeClient().getAuthProviders();

    expect(result).toEqual({ providers: [], devLoginEnabled: false, localAuthEnabled: true });
  });

  it('getAuthProviders() normalizes a missing/non-boolean dev_login_enabled to false, never truthy-coerced', async () => {
    // A backend bug, a stale/partial response, or a proxy stripping a
    // field should never accidentally *enable* dev login client-side —
    // only a strict `=== true` counts.
    for (const rawValue of [undefined, null, 1, 'true', {}]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ providers: [], dev_login_enabled: rawValue, local_auth_enabled: true })
      );
      const result = await makeClient().getAuthProviders();
      expect(result.devLoginEnabled).toBe(false);
    }
  });

  it('getAuthProviders() normalizes a missing/non-boolean local_auth_enabled to false, never truthy-coerced', async () => {
    // Same reasoning as dev_login_enabled above — an empty `providers`
    // array must never be misread as "no auth available" (see
    // login.tsx's computeLoginBranch), so this flag must never be
    // silently coerced true from a bad/missing backend value either.
    for (const rawValue of [undefined, null, 1, 'true', {}]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ providers: [], dev_login_enabled: false, local_auth_enabled: rawValue })
      );
      const result = await makeClient().getAuthProviders();
      expect(result.localAuthEnabled).toBe(false);
    }
  });

  it('getAuthProviders() normalizes a missing/null providers field to an empty array', async () => {
    for (const rawValue of [undefined, null]) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          providers: rawValue,
          dev_login_enabled: true,
          local_auth_enabled: true,
        })
      );
      const result = await makeClient().getAuthProviders();
      expect(result.providers).toEqual([]);
    }
  });

  it('getAuthProviders() requests the exact configured base URL, including a LAN IP — never a hardcoded localhost', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ providers: [], dev_login_enabled: true }));

    const lanClient = new EducationAssistantClient({
      baseUrl: 'http://192.168.0.99:8000',
      getAccessToken: async () => null,
      timeoutMs: 5000,
    });
    await lanClient.getAuthProviders();

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://192.168.0.99:8000/auth/providers');
  });

  it('buildOAuthAuthorizeUrl() builds the authorize URL with an encoded redirect_uri, without making a request', () => {
    const url = makeClient().buildOAuthAuthorizeUrl('google', 'edum8://auth-callback');

    expect(url).toBe(
      'http://localhost:8000/auth/google/authorize?redirect_uri=edum8%3A%2F%2Fauth-callback'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exchangeAuthCode() POSTs the code and sends credentials for the refresh cookie', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'bearer',
        expires_in: 900,
        user: {
          id: 'u1',
          email: 'a@example.com',
          display_name: null,
          avatar_url: null,
          is_dev_test_user: false,
        },
      })
    );
    const result = await makeClient().exchangeAuthCode('the-auth-code');

    expect(result.access_token).toBe('access-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/session/exchange');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ auth_code: 'the-auth-code' });
    expect(init.credentials).toBe('include');
  });

  it('refreshSession() POSTs the refresh token and sends credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'bearer',
        expires_in: 900,
        user: {
          id: 'u1',
          email: 'a@example.com',
          display_name: null,
          avatar_url: null,
          is_dev_test_user: false,
        },
      })
    );
    await makeClient().refreshSession('refresh-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/refresh');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'refresh-1' });
    expect(init.credentials).toBe('include');
  });

  it('refreshSession() sends a null refresh_token when called with none (web relies on the cookie)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-3',
        refresh_token: 'refresh-3',
        token_type: 'bearer',
        expires_in: 900,
        user: {
          id: 'u1',
          email: 'a@example.com',
          display_name: null,
          avatar_url: null,
          is_dev_test_user: false,
        },
      })
    );
    await makeClient().refreshSession();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ refresh_token: null });
  });

  it('logout() POSTs the refresh token and sends credentials', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().logout('refresh-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/logout');
    expect(JSON.parse(init.body)).toEqual({ refresh_token: 'refresh-1' });
    expect(init.credentials).toBe('include');
  });

  it('getMe() GETs /auth/me with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'u1',
        email: 'a@example.com',
        display_name: 'A User',
        avatar_url: null,
        is_dev_test_user: false,
      })
    );
    const result = await makeClient().getMe();

    expect(result.email).toBe('a@example.com');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/me');
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('devLogin() POSTs email and display_name', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-4',
        refresh_token: 'refresh-4',
        token_type: 'bearer',
        expires_in: 900,
        user: {
          id: 'u2',
          email: 'dev@example.com',
          display_name: 'Dev User',
          avatar_url: null,
          is_dev_test_user: true,
        },
      })
    );
    const result = await makeClient().devLogin('dev@example.com', 'Dev User');

    expect(result.user.is_dev_test_user).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/dev-login');
    expect(JSON.parse(init.body)).toEqual({ email: 'dev@example.com', display_name: 'Dev User' });
  });

  it('rejects with AuthenticationError when /auth/me is called with an invalid token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Invalid or expired access token' }, 401)
    );
    await expect(makeClient().getMe()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('register() POSTs email/password/display_name and sends credentials for the refresh cookie', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          email_verification_required: false,
          message: 'Account created.',
          access_token: 'access-5',
          refresh_token: 'refresh-5',
          token_type: 'bearer',
          expires_in: 900,
          user: {
            id: 'u3',
            email: 'new@example.com',
            display_name: 'New User',
            avatar_url: null,
            is_dev_test_user: false,
            provider: null,
          },
        },
        201
      )
    );
    const result = await makeClient().register({
      email: 'new@example.com',
      password: 'correct horse battery',
      display_name: 'New User',
    });

    expect(result.email_verification_required).toBe(false);
    expect(result.user?.email).toBe('new@example.com');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/register');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      email: 'new@example.com',
      password: 'correct horse battery',
      display_name: 'New User',
    });
    expect(init.credentials).toBe('include');
  });

  it('register() with verification required returns null token/user fields', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          email_verification_required: true,
          message: 'Account created. Check your email.',
          access_token: null,
          refresh_token: null,
          token_type: 'bearer',
          expires_in: null,
          user: null,
        },
        201
      )
    );
    const result = await makeClient().register({
      email: 'needsverify@example.com',
      password: 'correct horse battery',
    });

    expect(result.email_verification_required).toBe(true);
    expect(result.access_token).toBeNull();
    expect(result.user).toBeNull();
  });

  it('register() rejects with ConflictError on a duplicate email (409)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'An account with this email already exists.' }, 409)
    );
    await expect(
      makeClient().register({ email: 'dupe@example.com', password: 'correct horse battery' })
    ).rejects.toMatchObject({ name: 'ConflictError' });
  });

  it('register() rejects with ValidationError on a weak password (422)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: 'Password must be at least 8 characters.' }, 422)
    );
    await expect(
      makeClient().register({ email: 'weak@example.com', password: 'short' })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('login() POSTs email/password and sends credentials for the refresh cookie', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'access-6',
        refresh_token: 'refresh-6',
        token_type: 'bearer',
        expires_in: 900,
        user: {
          id: 'u3',
          email: 'existing@example.com',
          display_name: null,
          avatar_url: null,
          is_dev_test_user: false,
          provider: null,
        },
      })
    );
    const result = await makeClient().login({
      email: 'existing@example.com',
      password: 'correct-password-1',
    });

    expect(result.access_token).toBe('access-6');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      email: 'existing@example.com',
      password: 'correct-password-1',
    });
    expect(init.credentials).toBe('include');
  });

  it('login() rejects with AuthenticationError on wrong credentials, with a generic message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Invalid email or password' }, 401));
    await expect(makeClient().login({ email: 'x@example.com', password: 'wrong' })).rejects.toThrow(
      'Invalid email or password'
    );
  });

  it('login() rejects with RateLimitError when throttled (429)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Too many attempts. Please try again later.' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      })
    );
    await expect(
      makeClient().login({ email: 'x@example.com', password: 'wrong' })
    ).rejects.toMatchObject({ name: 'RateLimitError' });
  });

  it('login() rejects with AuthorizationError and the stable code for an unverified account', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'email_verification_required' }, 403));
    await expect(
      makeClient().login({ email: 'unverified@example.com', password: 'correct-password-1' })
    ).rejects.toMatchObject({ name: 'AuthorizationError', message: 'email_verification_required' });
  });

  it('resendVerification() POSTs the email and returns the generic response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        detail:
          'If an account exists for this email and still needs verification, a new verification email has been sent.',
      })
    );
    const result = await makeClient().resendVerification('someone@example.com');

    expect(result.detail).toMatch(/verification email has been sent/);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/auth/resend-verification');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: 'someone@example.com' });
  });

  it('resendVerification() rejects with RateLimitError when throttled (429)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: 'Too many attempts. Please try again later.' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    );
    await expect(makeClient().resendVerification('someone@example.com')).rejects.toMatchObject({
      name: 'RateLimitError',
    });
  });
});

describe('conversations', () => {
  it('createConversation() POSTs /conversations and returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'c1',
          title: 'New conversation',
          title_is_custom: false,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          messages: [],
        },
        201
      )
    );
    const result = await makeClient().createConversation();

    expect(result.id).toBe('c1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations');
    expect(init.method).toBe('POST');
  });

  it('listConversations() GETs /conversations with limit/offset query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], total: 0 }));
    await makeClient().listConversations({ limit: 5, offset: 10 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations?limit=5&offset=10');
  });

  it('getConversation() GETs /conversations/{id}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'c1',
        title: 'Hello',
        title_is_custom: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        messages: [],
      })
    );
    const result = await makeClient().getConversation('c1');

    expect(result.title).toBe('Hello');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations/c1');
  });

  it('getConversation() surfaces the authoritative project-membership list (Frontend Milestone 2.1)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'c1',
        title: 'Hello',
        title_is_custom: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        messages: [],
        projects: [{ id: 'p1', name: 'AI Literacy Study' }],
      })
    );
    const result = await makeClient().getConversation('c1');

    expect(result.projects).toEqual([{ id: 'p1', name: 'AI Literacy Study' }]);
  });

  it('getConversation() defaults to no project membership when the field is absent (pre-Milestone-2.1 shape)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'c1',
        title: 'Hello',
        title_is_custom: true,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        messages: [],
      })
    );
    const result = await makeClient().getConversation('c1');

    expect(result.projects ?? []).toEqual([]);
  });

  it('renameConversation() PATCHes /conversations/{id} with the new title', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'c1',
        title: 'Renamed',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        message_count: 2,
        last_message_preview: 'hi',
      })
    );
    const result = await makeClient().renameConversation('c1', 'Renamed');

    expect(result.title).toBe('Renamed');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations/c1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ title: 'Renamed' });
  });

  it('deleteConversation() DELETEs /conversations/{id}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().deleteConversation('c1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations/c1');
    expect(init.method).toBe('DELETE');
  });

  // Milestone 2: conversation document scope.
  describe('conversation document scope', () => {
    function conversationDocument(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        document_id: 'd1',
        source_filename: 'notes.pdf',
        document_type: 'report',
        added_at: '2026-01-01T00:00:00Z',
        ...overrides,
      };
    }

    it('listConversationDocuments() GETs /conversations/{id}/documents', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ documents: [conversationDocument()], total: 1 })
      );
      const result = await makeClient().listConversationDocuments('c1');

      expect(result.total).toBe(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/documents');
      expect(init.method).toBe('GET');
    });

    it('addConversationDocuments() POSTs document_ids and returns the full selection', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { documents: [conversationDocument({ document_id: 'd1' })], total: 1 },
          201
        )
      );
      const result = await makeClient().addConversationDocuments('c1', ['d1']);

      expect(result.total).toBe(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/documents');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ document_ids: ['d1'] });
    });

    it('addConversationDocuments() supports multiple ids in one call', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [], total: 2 }, 201));
      await makeClient().addConversationDocuments('c1', ['d1', 'd2']);

      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init.body)).toEqual({ document_ids: ['d1', 'd2'] });
    });

    it('replaceConversationDocuments() PUTs document_ids', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [], total: 1 }));
      await makeClient().replaceConversationDocuments('c1', ['d2']);

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/documents');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ document_ids: ['d2'] });
    });

    it('clearConversationDocuments() PUTs an empty document_ids list', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ documents: [], total: 0 }));
      const result = await makeClient().clearConversationDocuments('c1');

      expect(result.total).toBe(0);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/documents');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ document_ids: [] });
    });

    it('removeConversationDocument() DELETEs /conversations/{id}/documents/{document_id}', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await makeClient().removeConversationDocument('c1', 'd1');

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/documents/d1');
      expect(init.method).toBe('DELETE');
    });

    it('addConversationDocuments() rejects with NotFoundError on a 404 (bad conversation or document id)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: "One or more documents not found: ['missing']" }, 404)
      );
      await expect(
        makeClient().addConversationDocuments('c1', ['missing'])
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // Milestone 4: Zoom-In / strict selected-source mode.
  describe('conversation scope', () => {
    function conversationScope(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        chat_enabled: true,
        project_enabled: true,
        general_enabled: true,
        include_other_project_summaries: false,
        zoom_in_mode: false,
        ...overrides,
      };
    }

    it('getConversationScope() GETs /conversations/{id}/scope', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(conversationScope({ zoom_in_mode: true })));
      const result = await makeClient().getConversationScope('c1');

      expect(result.zoom_in_mode).toBe(true);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/scope');
      expect(init.method).toBe('GET');
    });

    it('updateConversationScope() PATCHes only the fields present on the request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(conversationScope({ zoom_in_mode: true })));
      await makeClient().updateConversationScope('c1', { zoomInMode: true });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/scope');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toEqual({ zoom_in_mode: true });
    });

    it('updateConversationScope() omits fields not present on the request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(conversationScope({ chat_enabled: false })));
      await makeClient().updateConversationScope('c1', { chatEnabled: false });

      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse(init.body);
      expect(body).toEqual({ chat_enabled: false });
      expect('zoom_in_mode' in body).toBe(false);
    });

    it('updateConversationScope() can send every field together', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(conversationScope()));
      await makeClient().updateConversationScope('c1', {
        chatEnabled: true,
        projectEnabled: false,
        generalEnabled: false,
        includeOtherProjectSummaries: true,
        zoomInMode: false,
      });

      const [, init] = fetchMock.mock.calls[0]!;
      expect(JSON.parse(init.body)).toEqual({
        chat_enabled: true,
        project_enabled: false,
        general_enabled: false,
        include_other_project_summaries: true,
        zoom_in_mode: false,
      });
    });

    it('updateConversationScope() rejects with a ValidationError on a 422 (zero selected sources)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ detail: 'Zoom-In requires at least one selected source.' }, 422)
      );
      await expect(
        makeClient().updateConversationScope('c1', { zoomInMode: true })
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('updateConversationScope() rejects with NotFoundError on a 404 (missing conversation)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Conversation not found' }, 404));
      await expect(
        makeClient().updateConversationScope('c1', { zoomInMode: false })
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  it('streamConversationMessage() posts to /conversations/{id}/messages and yields parsed events', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'token', content: 'Hi' }),
        sseEvent({ type: 'sources', sources: [] }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
        }),
      ])
    );

    const events = [];
    for await (const event of makeClient().streamConversationMessage('c1', { query: 'hello' })) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(['token', 'sources', 'done']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/conversations/c1/messages');
    expect(JSON.parse(init.body)).toEqual({ query: 'hello' });
  });

  it('postConversationMessage() buffers the stream into one ChatResult', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'token', content: 'answer' }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
        }),
      ])
    );

    const result = await makeClient().postConversationMessage('c1', { query: 'hello' });

    expect(result.answer).toBe('answer');
  });

  describe('with attachments (milestone V2)', () => {
    class FakeFormData {
      private entries: [string, unknown][] = [];
      append(key: string, value: unknown): void {
        this.entries.push([key, value]);
      }
      get(key: string): unknown {
        return this.entries.find(([k]) => k === key)?.[1] ?? null;
      }
      getAll(key: string): unknown[] {
        return this.entries.filter(([k]) => k === key).map(([, v]) => v);
      }
    }

    beforeEach(() => {
      vi.stubGlobal('FormData', FakeFormData);
    });

    it('streamConversationMessage() sends multipart form data with no manual Content-Type when attachments are present', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const file = { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' };
      const events = [];
      for await (const event of makeClient().streamConversationMessage('c1', {
        query: 'what is this?',
        client_message_id: 'attempt-1',
        attachments: [{ file }],
      })) {
        events.push(event);
      }

      expect(events.map((e) => e.type)).toEqual(['done']);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/messages');
      expect(init.headers['Content-Type']).toBeUndefined();
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.get('query')).toBe('what is this?');
      expect(formData.get('client_message_id')).toBe('attempt-1');
      expect(formData.getAll('files')).toEqual([file]);
      expect(JSON.parse(formData.get('page_ranges') as string)).toEqual([null]);
    });

    it('streamConversationMessage() sends a page_ranges entry per attachment, aligned by index', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const image = { uri: 'file:///tmp/a.png', name: 'a.png', type: 'image/png' };
      const pdf = { uri: 'file:///tmp/b.pdf', name: 'b.pdf', type: 'application/pdf' };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of makeClient().streamConversationMessage('c1', {
        query: 'look at these',
        attachments: [{ file: image }, { file: pdf, pageRange: { start: 2, end: 4 } }],
      })) {
        // drain
      }

      const [, init] = fetchMock.mock.calls[0]!;
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.getAll('files')).toEqual([image, pdf]);
      expect(JSON.parse(formData.get('page_ranges') as string)).toEqual([
        null,
        { start: 2, end: 4 },
      ]);
    });

    it('postConversationMessage() also sends multipart form data when attachments are present', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const file = { uri: 'file:///tmp/doc.pdf', name: 'doc.pdf', type: 'application/pdf' };
      await makeClient().postConversationMessage('c1', {
        query: 'summarize',
        attachments: [{ file }],
      });

      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.headers['Content-Type']).toBeUndefined();
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.getAll('files')).toEqual([file]);
    });

    it('sends a plain JSON body (unchanged) when attachments is omitted or empty', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of makeClient().streamConversationMessage('c1', {
        query: 'hello',
        attachments: [],
      })) {
        // drain
      }

      const [, init] = fetchMock.mock.calls[0]!;
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ query: 'hello', attachments: [] });
    });
  });

  describe('vision (milestone V3)', () => {
    class FakeFormData {
      private entries: [string, unknown][] = [];
      append(key: string, value: unknown): void {
        this.entries.push([key, value]);
      }
      get(key: string): unknown {
        return this.entries.find(([k]) => k === key)?.[1] ?? null;
      }
      getAll(key: string): unknown[] {
        return this.entries.filter(([k]) => k === key).map(([, v]) => v);
      }
    }

    beforeEach(() => {
      vi.stubGlobal('FormData', FakeFormData);
    });

    it('sendVisionMessage() builds a multipart request with the images as attachments', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const image = { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' };
      const events = [];
      for await (const event of makeClient().sendVisionMessage('c1', {
        query: 'What is this?',
        images: [image],
      })) {
        events.push(event);
      }

      expect(events.map((e) => e.type)).toEqual(['done']);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/messages');
      expect(init.headers['Content-Type']).toBeUndefined();
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.get('query')).toBe('What is this?');
      expect(formData.get('use_corpus')).toBe('false');
      expect(formData.getAll('files')).toEqual([image]);
    });

    it('sendVisionMessage() sends use_corpus=true when useCorpus is set', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const image = { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of makeClient().sendVisionMessage('c1', {
        query: 'Does this match the research?',
        images: [image],
        useCorpus: true,
      })) {
        // drain
      }

      const [, init] = fetchMock.mock.calls[0]!;
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.get('use_corpus')).toBe('true');
    });

    it('sendVisionMessage() supports a Blob file', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const blob = new Blob(['fake-bytes'], { type: 'image/png' });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of makeClient().sendVisionMessage('c1', {
        query: 'What is this?',
        images: [blob],
      })) {
        // drain
      }

      const [, init] = fetchMock.mock.calls[0]!;
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.getAll('files')).toEqual([blob]);
    });

    it('sendVisionMessage() supports the React Native { uri, name, type } file shape', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const rnFile = {
        uri: 'file:///data/user/0/app/cache/photo.jpg',
        name: 'photo.jpg',
        type: 'image/jpeg',
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of makeClient().sendVisionMessage('c1', {
        query: 'What is this?',
        images: [rnFile],
      })) {
        // drain
      }

      const [, init] = fetchMock.mock.calls[0]!;
      const formData = init.body as InstanceType<typeof FakeFormData>;
      expect(formData.getAll('files')).toEqual([rnFile]);
    });

    it('sendVisionMessage() rejects (does not send a request) when images is empty', async () => {
      const generator = makeClient().sendVisionMessage('c1', {
        query: 'What is this?',
        images: [],
      });

      await expect(generator.next()).rejects.toThrow(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('postVisionMessage() buffers the stream into one ChatResult', async () => {
      fetchMock.mockResolvedValueOnce(
        sseResponse([
          sseEvent({ type: 'token', content: 'It is a cat.' }),
          sseEvent({
            type: 'done',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
          }),
        ])
      );

      const result = await makeClient().postVisionMessage('c1', {
        query: 'What is this?',
        images: [{ uri: 'file:///tmp/cat.png', name: 'cat.png', type: 'image/png' }],
      });

      expect(result.answer).toBe('It is a cat.');
    });

    it('postVisionMessage() rejects when images is empty, without sending a request', async () => {
      await expect(
        makeClient().postVisionMessage('c1', { query: 'What is this?', images: [] })
      ).rejects.toThrow(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('attachment content (milestone V3)', () => {
    it('buildAttachmentUrl() builds the correct path with encoded ids', () => {
      const url = makeClient().buildAttachmentUrl('c 1', 'm/1', 'a?1');
      expect(url).toBe(
        `http://localhost:8000/conversations/${encodeURIComponent('c 1')}/messages/${encodeURIComponent('m/1')}/attachments/${encodeURIComponent('a?1')}`
      );
    });

    it('fetchAttachmentBlob() GETs the attachment URL with a Bearer token and returns the body as a blob-like object', async () => {
      // Deliberately not `instanceof Blob` here: jsdom's Blob and Node's
      // built-in (undici) Blob are different classes across this test
      // environment's two realms, so a same-name `instanceof` check would
      // be testing a jsdom/Node quirk, not this method's actual behavior.
      fetchMock.mockResolvedValueOnce(
        new Response('png-bytes', { status: 200, headers: { 'content-type': 'image/png' } })
      );

      const result = await makeClient().fetchAttachmentBlob('c1', 'm1', 'a1');

      expect(result.type).toBe('image/png');
      expect(await result.text()).toBe('png-bytes');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://localhost:8000/conversations/c1/messages/m1/attachments/a1');
      expect(init.headers.Authorization).toBe('Bearer test-token');
    });

    it('fetchAttachmentBlob() rejects with NotFoundError on a 404', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Attachment not found' }, 404));

      await expect(makeClient().fetchAttachmentBlob('c1', 'm1', 'a1')).rejects.toBeInstanceOf(
        NotFoundError
      );
    });

    it('getAttachmentImageSource() resolves to a { uri, headers } source for React Native Image', async () => {
      const source = await makeClient().getAttachmentImageSource('c1', 'm1', 'a1');

      expect(source.uri).toBe('http://localhost:8000/conversations/c1/messages/m1/attachments/a1');
      expect(source.headers).toEqual({ Authorization: 'Bearer test-token' });
    });

    it('getAttachmentImageSource() omits Authorization when there is no token', async () => {
      const source = await makeClient({
        getAccessToken: async () => null,
      }).getAttachmentImageSource('c1', 'm1', 'a1');

      expect(source.headers).toEqual({});
    });
  });

  describe('PDF page preview (milestone V4)', () => {
    it('buildAttachmentUrl() appends /preview?page=N when a page is given', () => {
      const url = makeClient().buildAttachmentUrl('c1', 'm1', 'a1', 3);
      expect(url).toBe(
        'http://localhost:8000/conversations/c1/messages/m1/attachments/a1/preview?page=3'
      );
    });

    it('buildAttachmentUrl() omits /preview entirely when no page is given', () => {
      const url = makeClient().buildAttachmentUrl('c1', 'm1', 'a1');
      expect(url).toBe('http://localhost:8000/conversations/c1/messages/m1/attachments/a1');
    });

    it('fetchAttachmentBlob() fetches the preview URL when options.page is given', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('page-png-bytes', { status: 200, headers: { 'content-type': 'image/png' } })
      );

      const result = await makeClient().fetchAttachmentBlob('c1', 'm1', 'a1', { page: 2 });

      expect(await result.text()).toBe('page-png-bytes');
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        'http://localhost:8000/conversations/c1/messages/m1/attachments/a1/preview?page=2'
      );
    });

    it('getAttachmentImageSource() resolves to the preview URI when a page is given', async () => {
      const source = await makeClient().getAttachmentImageSource('c1', 'm1', 'a1', 4);

      expect(source.uri).toBe(
        'http://localhost:8000/conversations/c1/messages/m1/attachments/a1/preview?page=4'
      );
      expect(source.headers).toEqual({ Authorization: 'Bearer test-token' });
    });
  });
});

describe('projects', () => {
  it('createProject() POSTs /projects with name and description', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'p1',
          name: 'AI Literacy Research',
          description: 'Research chats',
          conversation_count: 0,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        201
      )
    );
    const result = await makeClient().createProject({
      name: 'AI Literacy Research',
      description: 'Research chats',
    });

    expect(result.id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'AI Literacy Research',
      description: 'Research chats',
    });
  });

  it('createProject() sends description: null when omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'p1',
        name: 'No Description',
        description: null,
        conversation_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().createProject({ name: 'No Description' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ name: 'No Description', description: null });
  });

  it('listProjects() GETs /projects with limit/offset query params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [], total: 0 }));
    await makeClient().listProjects({ limit: 5, offset: 10 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects?limit=5&offset=10');
  });

  it('getProject() GETs /projects/{id}', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'p1',
        name: 'AI Literacy Research',
        description: null,
        conversation_count: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().getProject('p1');

    expect(result.name).toBe('AI Literacy Research');
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1');
  });

  it('updateProject() only sends fields actually present on the request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'p1',
        name: 'Teacher Agency Study',
        description: null,
        conversation_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().updateProject('p1', { name: 'Teacher Agency Study' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Teacher Agency Study' });
  });

  it('updateProject() sends an explicit null to clear the description', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'p1',
        name: 'Kept Name',
        description: null,
        conversation_count: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().updateProject('p1', { description: null });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ description: null });
  });

  it('deleteProject() DELETEs /projects/{id}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().deleteProject('p1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1');
    expect(init.method).toBe('DELETE');
  });

  it('listProjectConversations() GETs /projects/{id}/conversations', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: [], total: 0 }));
    await makeClient().listProjectConversations('p1', { limit: 5, offset: 0 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1/conversations?limit=5&offset=0');
  });

  it('addProjectConversation() POSTs /projects/{id}/conversations with conversation_id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          conversation_id: 'c1',
          title: 'A chat',
          added_at: '2026-01-01T00:00:00Z',
          sort_order: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        201
      )
    );
    const result = await makeClient().addProjectConversation('p1', 'c1');

    expect(result.conversation_id).toBe('c1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1/conversations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ conversation_id: 'c1' });
  });

  it('removeProjectConversation() DELETEs /projects/{id}/conversations/{conversationId}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await makeClient().removeProjectConversation('p1', 'c1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/projects/p1/conversations/c1');
    expect(init.method).toBe('DELETE');
  });
});

describe('images', () => {
  function generatedAttachment(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'a1',
      mime: 'image/png',
      filename: 'generated-a1.png',
      size_bytes: 1234,
      page_count: null,
      page_range_start: null,
      page_range_end: null,
      created_at: '2026-01-01T00:00:00Z',
      source: 'generated',
      generation_prompt: 'a red apple',
      generation_negative_prompt: null,
      generation_seed: null,
      generation_model: 'x/flux2-klein',
      generation_width: 512,
      generation_height: 512,
      saved_project_id: null,
      ...overrides,
    };
  }

  it('generateImages() POSTs /images/generate with the full request body and assembles the "done" event', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'progress', completed: 1, total: 2 }),
        sseEvent({ type: 'progress', completed: 2, total: 2 }),
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'c1',
          images: [generatedAttachment()],
        }),
      ])
    );

    const result = await makeClient().generateImages({
      prompt: 'a red apple',
      negative_prompt: 'blurry',
      width: 512,
      height: 512,
      seed: 42,
      num_images: 2,
      conversation_id: 'c1',
      save_to_project_id: 'p1',
    });

    expect(result.message_id).toBe('m1');
    expect(result.images).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/images/generate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      prompt: 'a red apple',
      negative_prompt: 'blurry',
      width: 512,
      height: 512,
      seed: 42,
      num_images: 2,
      conversation_id: 'c1',
      save_to_project_id: 'p1',
    });
  });

  it('generateImages() includes reference_images in the request body when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'c1',
          images: [generatedAttachment()],
        }),
      ])
    );

    await makeClient().generateImages({
      prompt: 'the Finch robot on Mars',
      width: 512,
      height: 512,
      num_images: 1,
      conversation_id: 'c1',
      reference_images: [{ data_url: 'data:image/png;base64,AAAA', mime: 'image/png' }],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body).reference_images).toEqual([
      { data_url: 'data:image/png;base64,AAAA', mime: 'image/png' },
    ]);
  });

  it('generateImages() throws BackendError when the stream emits an "error" event', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([sseEvent({ type: 'error', message: "Model 'x/flux2-klein' is not installed." })])
    );

    await expect(
      makeClient().generateImages({
        prompt: 'a cat',
        width: 512,
        height: 512,
        num_images: 1,
        conversation_id: 'c1',
      })
    ).rejects.toThrow(BackendError);
  });

  it('generateImages() propagates a ProviderUnavailableError for a pre-stream HTTP failure (e.g. an unknown conversation)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "Model 'x/flux2-klein' is not installed." }, 502)
    );

    await expect(
      makeClient().generateImages({
        prompt: 'a cat',
        width: 512,
        height: 512,
        num_images: 1,
        conversation_id: 'c1',
      })
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it('streamImageGeneration() yields progress events before the final "done" event', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'progress', completed: 1, total: 3 }),
        sseEvent({ type: 'progress', completed: 2, total: 3 }),
        sseEvent({ type: 'progress', completed: 3, total: 3 }),
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'c1',
          images: [
            generatedAttachment(),
            generatedAttachment({ id: 'a2' }),
            generatedAttachment({ id: 'a3' }),
          ],
        }),
      ])
    );

    const events = [];
    for await (const event of makeClient().streamImageGeneration({
      prompt: 'a cat',
      width: 512,
      height: 512,
      num_images: 3,
      conversation_id: 'c1',
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(['progress', 'progress', 'progress', 'done']);
    expect((events[0] as { completed: number; total: number }).completed).toBe(1);
    expect((events[2] as { completed: number; total: number }).completed).toBe(3);
  });

  it("streamImageGeneration() schedules its connection-establishment deadline at DEFAULT_IMAGE_GENERATION_TIMEOUT_MS, not the client's own (much shorter) constructed timeoutMs", async () => {
    // combineSignals (request.ts) schedules its deadline via a bare
    // setTimeout(fn, timeoutMs) — spying on the real setTimeout and
    // reading the duration it was actually called with is a direct,
    // non-flaky way to prove which timeoutMs value won, without waiting
    // on any real elapsed time.
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'c1',
          images: [generatedAttachment()],
        }),
      ])
    );

    // makeClient() constructs with timeoutMs: 5000 — if streamImageGeneration
    // used that instead of its own dedicated default, the spied duration
    // below would be 5000, not 300000.
    const events = [];
    for await (const event of makeClient().streamImageGeneration({
      prompt: 'a cat',
      width: 512,
      height: 512,
      num_images: 1,
      conversation_id: 'c1',
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    const deadlineCall = setTimeoutSpy.mock.calls.find((call) => call[1] === 300_000);
    expect(deadlineCall).toBeDefined();
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 5000)).toBe(false);
  });

  it('streamImageGeneration() honors an explicit options.timeoutMs override', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({
          type: 'done',
          message_id: 'm1',
          conversation_id: 'c1',
          images: [generatedAttachment()],
        }),
      ])
    );

    const events = [];
    for await (const event of makeClient().streamImageGeneration(
      { prompt: 'a cat', width: 512, height: 512, num_images: 1, conversation_id: 'c1' },
      { timeoutMs: 60_000 }
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 300_000)).toBe(false);
  });

  it("chat() keeps using the client's own constructed timeoutMs (5000), unaffected by DEFAULT_IMAGE_GENERATION_TIMEOUT_MS existing", async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        sseEvent({ type: 'token', content: 'hi' }),
        sseEvent({ type: 'sources', sources: [] }),
        sseEvent({
          type: 'done',
          citations: [],
          citation_warnings: [],
          insufficient_evidence: false,
        }),
      ])
    );

    await makeClient().chat({ query: 'x', top_k: 3 });

    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 5000)).toBe(true);
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 300_000)).toBe(false);
  });

  it('saveAttachmentToProject() PATCHes /attachments/{id}/project with the project id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(generatedAttachment({ saved_project_id: 'p1' })));

    const result = await makeClient().saveAttachmentToProject('a1', 'p1');

    expect(result.saved_project_id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/attachments/a1/project');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ project_id: 'p1' });
  });

  it('saveAttachmentToProject() sends project_id: null to un-save', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(generatedAttachment({ saved_project_id: null })));

    await makeClient().saveAttachmentToProject('a1', null);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ project_id: null });
  });

  it('streamImageGeneration() cancelling mid-batch throws RequestCancelledError and yields no further events', async () => {
    // A real fetch() ties its AbortSignal to the response body stream
    // itself (aborting mid-read rejects the pending reader.read() call) —
    // sseResponse()/controllableSseResponse() build a plain ReadableStream
    // with no such wiring, so this test wires it explicitly: the mocked
    // fetch listens for the abort and errors the stream's controller,
    // which is what a real implementation does under the hood.
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const controller = new AbortController();

    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        streamController.error(err);
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const received: unknown[] = [];
    const iterator = makeClient().streamImageGeneration(
      { prompt: 'a cat', width: 512, height: 512, num_images: 3, conversation_id: 'c1' },
      { signal: controller.signal }
    );

    streamController.enqueue(
      encoder.encode(sseEvent({ type: 'progress', completed: 1, total: 3 }))
    );
    const first = await iterator.next();
    received.push(first.value);
    expect(first.done).toBe(false);

    controller.abort();

    await expect(iterator.next()).rejects.toBeInstanceOf(RequestCancelledError);
    expect(received).toHaveLength(1); // never received a second progress event or "done"
  });
});

// Milestone 1: Document Library / Folder Management.
describe('folders', () => {
  function folderResponse(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'f1',
      name: 'Research',
      parent_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      folder_count: 0,
      document_count: 0,
      ...overrides,
    };
  }

  it('createFolder() POSTs /folders with name and parentId (defaulting parentId to null)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(folderResponse(), 201));
    const result = await makeClient().createFolder({ name: 'Research' });

    expect(result.id).toBe('f1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Research', parent_id: null });
  });

  it('createFolder() sends the given parentId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(folderResponse({ id: 'f2', name: 'AI Education', parent_id: 'f1' }), 201)
    );
    await makeClient().createFolder({ name: 'AI Education', parentId: 'f1' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ name: 'AI Education', parent_id: 'f1' });
  });

  it('getFolderContents() GETs /folders/contents with folder_id omitted for root', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        folder: null,
        breadcrumbs: [],
        folders: [folderResponse()],
        documents: [],
        documents_total: 0,
      })
    );
    const result = await makeClient().getFolderContents();

    expect(result.folders).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders/contents');
  });

  it('getFolderContents() GETs /folders/contents with folder_id/limit/offset when given', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        folder: folderResponse(),
        breadcrumbs: [{ id: 'f1', name: 'Research' }],
        folders: [],
        documents: [],
        documents_total: 0,
      })
    );
    await makeClient().getFolderContents({ folderId: 'f1', limit: 10, offset: 20 });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders/contents?folder_id=f1&limit=10&offset=20');
  });

  it('updateFolder() sends only name when renaming', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(folderResponse({ name: 'Renamed' })));
    await makeClient().updateFolder('f1', { name: 'Renamed' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders/f1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' });
  });

  it('updateFolder() sends an explicit null parentId to move to root', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(folderResponse()));
    await makeClient().updateFolder('f2', { parentId: null });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ parent_id: null });
  });

  it('updateFolder() omits a field entirely when not present on the request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(folderResponse()));
    await makeClient().updateFolder('f1', { parentId: 'f2' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ parent_id: 'f2' });
    expect(JSON.parse(init.body)).not.toHaveProperty('name');
  });

  it('deleteFolder() DELETEs /folders/{id} with move_contents_to_root omitted by default', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ deleted: true, folder_id: 'f1', moved_folders: 0, moved_documents: 0 })
    );
    await makeClient().deleteFolder('f1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders/f1');
    expect(init.method).toBe('DELETE');
  });

  it('deleteFolder() sends move_contents_to_root=true when requested', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ deleted: true, folder_id: 'f1', moved_folders: 2, moved_documents: 3 })
    );
    const result = await makeClient().deleteFolder('f1', { moveContentsToRoot: true });

    expect(result.moved_folders).toBe(2);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/folders/f1?move_contents_to_root=true');
  });

  it('createFolder() rejects with a ConflictError on a 409 (duplicate sibling name)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "A folder named 'Research' already exists here" }, 409)
    );
    await expect(makeClient().createFolder({ name: 'Research' })).rejects.toBeInstanceOf(
      ConflictError
    );
  });
});

describe('moveDocument (Milestone 1: Document Library / Folder Management)', () => {
  it('PATCHes /documents/{id} with folder_id', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        document_id: 'd1',
        source_filename: 'notes.pdf',
        folder_id: 'f1',
        document_type: 'report',
        chunk_count: 3,
        ingested_at: '2026-01-01T00:00:00Z',
      })
    );
    const result = await makeClient().moveDocument('d1', { folderId: 'f1' });

    expect(result.folder_id).toBe('f1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8000/documents/d1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ folder_id: 'f1' });
  });

  it('sends folder_id: null to move a document to root', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        document_id: 'd1',
        source_filename: 'notes.pdf',
        folder_id: null,
        document_type: 'report',
        chunk_count: 3,
        ingested_at: '2026-01-01T00:00:00Z',
      })
    );
    await makeClient().moveDocument('d1', { folderId: null });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ folder_id: null });
  });

  it('rejects with NotFoundError on a 404 (document or folder not found)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Folder not found' }, 404));
    await expect(makeClient().moveDocument('d1', { folderId: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError
    );
  });
});

describe('uploadDocument() folderId (Milestone 1: Document Library / Folder Management)', () => {
  it('appends folder_id to the multipart form when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: 'job1' }, 202));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'job1',
        status: 'completed',
        stage: 'persisting',
        total_chunks: 1,
        embedded_chunks: 1,
        document: {
          document_id: 'd1',
          source_filename: 'notes.txt',
          file_format: 'txt',
          folder_id: 'f1',
          document_type: 'report',
          page_count: 1,
          chunk_count: 1,
          ingested_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      })
    );

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const result = await makeClient().uploadDocument(file, {
      documentType: 'report',
      folderId: 'f1',
    });

    expect(result.folder_id).toBe('f1');
    const [, uploadInit] = fetchMock.mock.calls[0]!;
    const formData = uploadInit.body as FormData;
    expect(formData.get('folder_id')).toBe('f1');
  });

  it('omits folder_id from the multipart form when not provided (root upload, unchanged behavior)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ job_id: 'job1' }, 202));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        job_id: 'job1',
        status: 'completed',
        stage: 'persisting',
        total_chunks: 1,
        embedded_chunks: 1,
        document: {
          document_id: 'd1',
          source_filename: 'notes.txt',
          file_format: 'txt',
          folder_id: null,
          document_type: 'report',
          page_count: 1,
          chunk_count: 1,
          ingested_at: '2026-01-01T00:00:00Z',
        },
        error: null,
      })
    );

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await makeClient().uploadDocument(file, { documentType: 'report' });

    const [, uploadInit] = fetchMock.mock.calls[0]!;
    const formData = uploadInit.body as FormData;
    expect(formData.has('folder_id')).toBe(false);
  });
});
