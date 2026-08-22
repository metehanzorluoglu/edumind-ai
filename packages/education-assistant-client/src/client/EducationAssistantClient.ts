import {
  combineSignals,
  isAbortError,
  parseErrorBody,
  requestJson,
  requestMultipart,
  safeReadText,
  type RequestContext,
} from './request';
import { fetchAllChatEvents, streamChatEvents } from './stream';
import { fetchAllImageGenerationEvents, streamImageGenerationEvents } from './imageStream';
import {
  BackendError,
  NetworkError,
  RequestCancelledError,
  TimeoutError,
  errorFromResponse,
  extractRequestId,
} from './errors';
import { normalizeBaseUrl } from '../utils/url';
import type { HealthResponse, ReadinessResponse } from '../types/health';
import type { StatusResponse } from '../types/status';
import type { SearchRequest, SearchResponse } from '../types/search';
import type {
  BibtexExportRequest,
  BibtexExportResponse,
  CitationStyle,
  CreateHighlightRequest,
  DocumentBibtexResponse,
  DocumentCitationResponse,
  DocumentContentResponse,
  DocumentDeleteResponse,
  DocumentEnrichmentResponse,
  DocumentFileRequestInit,
  DocumentHighlight,
  DocumentHighlightListResponse,
  DocumentJobResponse,
  DocumentListResponse,
  DocumentMetadataPreviewResponse,
  DocumentSummary,
  DocumentUploadMetadata,
  DocumentUploadResponse,
  ListDocumentsParams,
  MoveDocumentRequest,
  UpdateDocumentMetadataRequest,
  UpdateHighlightRequest,
  UploadableFile,
} from '../types/documents';
import type {
  AddNotebookEntryRequest,
  CreateNotebookRequest,
  ListNotebookEntriesParams,
  ListNotebooksParams,
  Notebook,
  NotebookEntry,
  NotebookEntryListResponse,
  NotebookListResponse,
  NotebookMembershipResponse,
  RenameNotebookRequest,
  UpdateNotebookEntryRequest,
} from '../types/notebooks';
import type {
  CreateFolderRequest,
  DeleteFolderParams,
  DeleteFolderResponse,
  FolderContentsResponse,
  FolderResponse,
  GetFolderContentsParams,
  UpdateFolderRequest,
} from '../types/folders';
import type { ChatEvent, ChatRequest, ChatResult } from '../types/chat';
import type {
  GenerateImagesRequest,
  GenerateImagesResponse,
  GeneratedImageAttachment,
  ImageGenerationEvent,
} from '../types/images';
import type {
  AuthProviders,
  AuthProvidersResponse,
  AuthTokenResponse,
  AuthUser,
  GenericMessageResult,
  LoginRequestBody,
  RegisterRequestBody,
  RegisterResult,
} from '../types/auth';
import type {
  ConversationDetail,
  ConversationDocumentListResponse,
  ConversationListResponse,
  ConversationScope,
  ConversationSummary,
  ListConversationsParams,
  PostConversationMessageRequest,
  SendVisionMessageRequest,
  UpdateConversationScopeRequest,
} from '../types/conversations';
import type {
  CreateProjectRequest,
  ListProjectConversationsParams,
  ListProjectsParams,
  ProjectConversation,
  ProjectConversationListResponse,
  ProjectListResponse,
  ProjectSummary,
  UpdateProjectRequest,
} from '../types/projects';
import type {
  AddWritingProjectReferencesResponse,
  CompileWritingProjectResponse,
  CreateWritingProjectFolderRequest,
  CreateWritingProjectRequest,
  CreateWritingProjectTextFileRequest,
  InverseSearchResult,
  MoveWritingProjectFileRequest,
  RenameWritingProjectFileRequest,
  SwitchWritingProjectToEdum8ReferencesRequest,
  UpdateWritingProjectFileContentRequest,
  UpdateWritingProjectRequest,
  WritingProject,
  WritingProjectBibliography,
  WritingProjectFileContent,
  WritingProjectFileMutationResponse,
  WritingProjectFileTree,
  WritingProjectListResponse,
  WritingProjectReferenceMode,
  WritingProjectReferencesResponse,
} from '../types/writing';
import type {
  ConfirmWritingProjectImportRequest,
  WritingProjectImportInspection,
} from '../types/writingImport';
import type {
  CreateWritingProjectFromTemplateRequest,
  WritingTemplateDetail,
  WritingTemplateListResponse,
} from '../types/writingTemplates';

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Dedicated default for streamImageGeneration()/generateImages() only —
 * see IMAGE_GENERATION_REQUEST_TIMEOUT_SECONDS in rag-backend/.env.example
 * for the equivalent backend-side timeout (bounding each individual
 * image's call to Ollama). Generating even one image commonly takes tens
 * of seconds; a multi-image batch is generated strictly sequentially, so
 * the *connection* (not the whole generation) needs a much longer
 * allowance than this client's own 30s DEFAULT_TIMEOUT_MS — which stays
 * completely unchanged for every other request (chat, search, …).
 * Overridable per call via RequestOptions.timeoutMs.
 */
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 300_000;

/**
 * Milestone 5.1 — a real isolated LaTeX compile can legitimately take
 * close to the compiler service's own job_timeout_seconds (45s default,
 * see latex-compiler/app/config.py) plus network/queue overhead; the
 * backend's own client-side budget for that hop is 55s (Settings.
 * latex_compiler_timeout_seconds). 60s here gives this SDK's own request
 * a small margin beyond that so the backend's own honest "busy"/
 * "timeout" response has a chance to arrive before this client gives up
 * first. Overridable per call via RequestOptions.timeoutMs.
 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 60_000;

/**
 * How often uploadDocument() polls GET /documents/jobs/{job_id} once
 * POST /documents has handed back a job id. Ingestion (embedding + Qdrant
 * indexing) happens in a backend background task and can take anywhere
 * from seconds to several minutes on CPU-only hardware — polling keeps
 * each individual HTTP request short (well within DEFAULT_TIMEOUT_MS)
 * regardless of how long the job as a whole takes.
 */
const DOCUMENT_JOB_POLL_INTERVAL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface EducationAssistantClientOptions {
  /** Backend base URL, e.g. "http://192.168.1.20:8000". No trailing slash required. */
  baseUrl: string;
  /**
   * Returns the current bearer token, or null if unauthenticated. Called
   * fresh on every request — prefer this over passing a stored key so a
   * token obtained after client construction (e.g. entered into a dev
   * Settings screen) is always picked up. Never logged; never included in
   * thrown errors (see errors.ts).
   */
  getAccessToken: () => Promise<string | null>;
  /**
   * Bounds connection establishment (time until response headers arrive)
   * for every request, including chat. It never bounds how long an
   * already-started generation takes to finish streaming — see stream.ts.
   * Defaults to 30000ms.
   */
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * Overrides this call's own connection-establishment timeout — only
   * streamImageGeneration()/generateImages() currently read this; every
   * other method always uses the client's own constructed timeoutMs
   * (see EducationAssistantClientOptions.timeoutMs) and ignores this
   * field entirely.
   */
  timeoutMs?: number;
  /**
   * Only read by uploadDocument(). Called with each polled
   * GET /documents/jobs/{job_id} result while ingestion is still in
   * progress, so a caller can show live stage/chunk-count progress instead
   * of a single generic "uploading" state. Optional — omitting it changes
   * nothing about uploadDocument()'s own behavior or return value.
   */
  onProgress?: (job: DocumentJobResponse) => void;
}

/** Non-null only when the runtime restricted the base URL scheme/host in a way worth surfacing. */
export interface ClientWarning {
  message: string;
}

/**
 * Thin, typed client over the rag-backend HTTP API. Performs no retrieval,
 * generation, citation validation, grounding, or "is this evidence
 * sufficient" logic itself — every one of those decisions is made by the
 * backend and this client only transports and types the result.
 */
export class EducationAssistantClient {
  private readonly context: RequestContext;
  readonly baseUrl: string;
  readonly warning: string | null;

  constructor(options: EducationAssistantClientOptions) {
    const normalized = normalizeBaseUrl(options.baseUrl);
    this.baseUrl = normalized.url;
    this.warning = normalized.warning;
    this.context = {
      baseUrl: normalized.url,
      getAccessToken: options.getAccessToken,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  /** GET /health — unauthenticated, always reachable if the backend process is up. */
  async health(options: RequestOptions = {}): Promise<HealthResponse> {
    const { data } = await requestJson<HealthResponse>(this.context, {
      method: 'GET',
      path: '/health',
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /health/ready — unauthenticated. Reports live Ollama/Qdrant
   * reachability and model availability; `status: "ready"` iff both are
   * reachable and required models are present. Does not imply anything
   * about retrieval quality or document coverage.
   */
  async ready(options: RequestOptions = {}): Promise<ReadinessResponse> {
    const { data } = await requestJson<ReadinessResponse>(this.context, {
      method: 'GET',
      path: '/health/ready',
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /status — protected (requires a token). Corpus/dependency status for
   * a dev-only status display: reachability, model names, indexed
   * document/chunk counts, document-type breakdown, last ingestion time, and
   * whether a relevance threshold is enabled. Never includes document text,
   * filesystem paths, or secrets — see backend app/api/routes_status.py.
   */
  async status(options: RequestOptions = {}): Promise<StatusResponse> {
    const { data } = await requestJson<StatusResponse>(this.context, {
      method: 'GET',
      path: '/status',
      signal: options.signal,
    });
    return data;
  }

  /** POST /search — returns retrieved chunks only; no generation, no citations. */
  async search(request: SearchRequest, options: RequestOptions = {}): Promise<SearchResponse> {
    const { data } = await requestJson<SearchResponse>(this.context, {
      method: 'POST',
      path: '/search',
      body: request,
      signal: options.signal,
    });
    return data;
  }

  /** GET /documents */
  async listDocuments(
    params: ListDocumentsParams = {},
    options: RequestOptions = {}
  ): Promise<DocumentListResponse> {
    const { data } = await requestJson<DocumentListResponse>(this.context, {
      method: 'GET',
      path: '/documents',
      query: { limit: params.limit, offset: params.offset, q: params.q },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /documents/{document_id} — deletes the document and every chunk
   * belonging to it, keyed by its stable document_id (never by filename).
   * Rejects with NotFoundError (404) if the document doesn't exist.
   */
  async deleteDocument(
    documentId: string,
    options: RequestOptions = {}
  ): Promise<DocumentDeleteResponse> {
    const { data } = await requestJson<DocumentDeleteResponse>(this.context, {
      method: 'DELETE',
      path: `/documents/${encodeURIComponent(documentId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /documents/{document_id} — moves a document into a different
   * folder, or to root (`folderId: null`). Milestone 1 (Document Library /
   * Folder Management): purely organizational, never re-parses/re-embeds
   * or touches Qdrant. Rejects with NotFoundError (404) if the document
   * doesn't exist, or `folderId` names a folder that doesn't exist / isn't
   * the caller's, or folder_library_enabled is off on the backend.
   */
  async moveDocument(
    documentId: string,
    request: MoveDocumentRequest,
    options: RequestOptions = {}
  ): Promise<DocumentSummary> {
    const { data } = await requestJson<DocumentSummary>(this.context, {
      method: 'PATCH',
      path: `/documents/${encodeURIComponent(documentId)}`,
      body: { folder_id: request.folderId },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 4 (Reference Library & Bibliographic Metadata Foundation):
   * PATCH /documents/{document_id}/metadata — the "Edit metadata" action.
   * Only fields actually present on `request` are sent, so omitting a
   * field never clears it and only the fields you do pass get "user"
   * provenance (see UpdateDocumentMetadataRequest's docs). SQL-only: never
   * re-uploads, re-chunks, re-embeds, or touches Qdrant, so highlights/
   * Research Notes/project associations/Reader anchors are all
   * unaffected. Rejects with NotFoundError (404) if the document doesn't
   * exist or isn't the caller's, or a ValidationError (422) for a blanked
   * `title`/`documentType` or a malformed DOI.
   */
  async updateDocumentMetadata(
    documentId: string,
    request: UpdateDocumentMetadataRequest,
    options: RequestOptions = {}
  ): Promise<DocumentSummary> {
    const body: Record<string, unknown> = {};
    if ('title' in request) body.title = request.title;
    if ('authors' in request) body.authors = request.authors;
    if ('publicationYear' in request) body.publication_year = request.publicationYear;
    if ('sourceVenue' in request) body.source_venue = request.sourceVenue;
    if ('doi' in request) body.doi = request.doi;
    if ('sourceUrl' in request) body.source_url = request.sourceUrl;
    if ('documentType' in request) body.document_type = request.documentType;
    if ('journalQuartile' in request) body.journal_quartile = request.journalQuartile;
    if ('volume' in request) body.volume = request.volume;
    if ('issue' in request) body.issue = request.issue;
    if ('pageStart' in request) body.page_start = request.pageStart;
    if ('pageEnd' in request) body.page_end = request.pageEnd;
    if ('publisher' in request) body.publisher = request.publisher;
    if ('abstract' in request) body.abstract = request.abstract;
    if ('keywords' in request) body.keywords = request.keywords;
    if ('language' in request) body.language = request.language;

    const { data } = await requestJson<DocumentSummary>(this.context, {
      method: 'PATCH',
      path: `/documents/${encodeURIComponent(documentId)}/metadata`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate
   * Awareness): POST /documents/{document_id}/enrich — the "Refresh
   * metadata" action. Looks the document's DOI up against Crossref and
   * fills/corrects fields that are missing or came from a less-trusted
   * source (embedded file metadata, extracted text, or the filename);
   * NEVER overwrites a field the caller (or a previous enrichment) has
   * confirmed as "user"-sourced (see UpdateDocumentMetadataRequest's own
   * docs on provenance).
   *
   * Always resolves to a 200 with a `status` describing what happened —
   * "no_doi"/"disabled"/a Crossref failure reason are ordinary, expected
   * outcomes, never a thrown error; existing metadata is guaranteed
   * untouched whenever `ok` is false. Rejects with NotFoundError (404)
   * only if the document itself doesn't exist or isn't the caller's.
   */
  async enrichDocumentMetadata(
    documentId: string,
    options: RequestOptions = {}
  ): Promise<DocumentEnrichmentResponse> {
    const { data } = await requestJson<DocumentEnrichmentResponse>(this.context, {
      method: 'POST',
      path: `/documents/${encodeURIComponent(documentId)}/enrich`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 4.2 (Citation & BibTeX Foundation): GET
   * /documents/{document_id}/citation?style=... — a deterministic,
   * formatted APA 7 / IEEE citation built from the document's CURRENT
   * canonical metadata. No LLM, no Crossref, no third-party service —
   * pure local formatting (see the backend's app/core/
   * citation_formatting.py), so this works identically regardless of
   * whether bibliographic enrichment is enabled. Rejects with
   * NotFoundError (404) if the document doesn't exist or isn't the
   * caller's.
   */
  async getDocumentCitation(
    documentId: string,
    style: CitationStyle,
    options: RequestOptions = {}
  ): Promise<DocumentCitationResponse> {
    const { data } = await requestJson<DocumentCitationResponse>(this.context, {
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}/citation`,
      query: { style },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 4.2: GET /documents/{document_id}/bibtex — one complete,
   * valid BibTeX entry using the document's PERSISTED citation key
   * (generated once and reused on every subsequent call — see the
   * backend's DocumentsRepository.get_or_create_citation_key for the
   * stability guarantee: a key already pasted into a manuscript never
   * changes just because the title was later corrected). Rejects with
   * NotFoundError (404) if the document doesn't exist or isn't the
   * caller's.
   */
  async getDocumentBibtex(
    documentId: string,
    options: RequestOptions = {}
  ): Promise<DocumentBibtexResponse> {
    const { data } = await requestJson<DocumentBibtexResponse>(this.context, {
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}/bibtex`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 4.2: POST /documents/bibtex-export — multi-reference `.bib`
   * export, reusing Documents' existing multi-selection UI. Every id is
   * ownership-checked individually server-side; an id that doesn't exist
   * or belongs to another user is silently skipped and reported back in
   * `skippedDocumentIds`, never a reason to fail the whole export or leak
   * whether that id belongs to someone else. Duplicate ids collapse to
   * one entry; two documents sharing a DOI (Milestone 4.1's "Keep Both")
   * each export as their own distinct, valid entry.
   */
  async exportBibtex(
    request: BibtexExportRequest,
    options: RequestOptions = {}
  ): Promise<BibtexExportResponse> {
    const { data } = await requestJson<BibtexExportResponse>(this.context, {
      method: 'POST',
      path: '/documents/bibtex-export',
      body: { document_ids: request.documentIds },
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /documents/{document_id}/content — Frontend Milestone 3 (Document
   * Reader). Returns the document's extracted text in reading order, NOT
   * the original file (no upload is retained anywhere past ingestion —
   * see DocumentContentResponse's docstring). Rejects with NotFoundError
   * (404) if the document doesn't exist or isn't the caller's.
   */
  async getDocumentContent(
    documentId: string,
    options: RequestOptions = {}
  ): Promise<DocumentContentResponse> {
    const { data } = await requestJson<DocumentContentResponse>(this.context, {
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}/content`,
      signal: options.signal,
    });
    return data;
  }

  /** GET /documents/{document_id}/highlights — every saved highlight for
   * this document, in reading order. */
  async listDocumentHighlights(
    documentId: string,
    options: RequestOptions = {}
  ): Promise<DocumentHighlightListResponse> {
    const { data } = await requestJson<DocumentHighlightListResponse>(this.context, {
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}/highlights`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /documents/{document_id}/highlights — the anchor
   * (chunkId/chunkIndex/pageNumber) must describe a real chunk of this
   * document; the backend validates it against the document's actual
   * current content and rejects (422) a fabricated or mismatched anchor.
   */
  async createDocumentHighlight(
    documentId: string,
    request: CreateHighlightRequest,
    options: RequestOptions = {}
  ): Promise<DocumentHighlight> {
    const { data } = await requestJson<DocumentHighlight>(this.context, {
      method: 'POST',
      path: `/documents/${encodeURIComponent(documentId)}/highlights`,
      body: {
        chunk_id: request.chunkId ?? null,
        chunk_index: request.chunkIndex ?? null,
        page_number: request.pageNumber,
        selected_text: request.selectedText,
        note_text: request.noteText ?? null,
        visual_anchor: request.visualAnchor ?? null,
      },
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /documents/{document_id}/highlights/{highlight_id}/notebooks —
   * which of the caller's own notebooks this highlight has already been
   * saved into. Backs the Reader's "Saved to N notebook(s)" indicator and
   * the add-to-notebook picker's checkmarks.
   */
  async getHighlightNotebookMembership(
    documentId: string,
    highlightId: string,
    options: RequestOptions = {}
  ): Promise<NotebookMembershipResponse> {
    const { data } = await requestJson<NotebookMembershipResponse>(this.context, {
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}/highlights/${encodeURIComponent(highlightId)}/notebooks`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Frontend Milestone 3.1 (Original Document Reader): resolves the
   * authenticated fetch parameters for GET /documents/{document_id}/file —
   * the original file's real bytes (a real PDF for a PDF, never
   * server-rendered images or OCR output). There is no unauthenticated/
   * public URL for this: hand the returned `url` + `httpHeaders` straight
   * to pdf.js's `getDocument({ url, httpHeaders })`, which also gets
   * pdf.js native Range-request support for large-PDF lazy page loading
   * for free. Does not itself verify the file exists or is available —
   * callers should only call this when
   * DocumentSummary/DocumentContentResponse.original_file_available is
   * true; a 404 from the resulting fetch means "no original file" (legacy
   * document) or "not this caller's document."
   */
  async getDocumentFileRequestInit(documentId: string): Promise<DocumentFileRequestInit> {
    const token = await this.context.getAccessToken();
    const httpHeaders: Record<string, string> = {};
    if (token) httpHeaders.Authorization = `Bearer ${token}`;
    return {
      url: `${this.baseUrl}/documents/${encodeURIComponent(documentId)}/file`,
      httpHeaders,
    };
  }

  /** PATCH /documents/{document_id}/highlights/{highlight_id} — the note
   * is the only mutable field; `noteText: null` clears it. */
  async updateDocumentHighlight(
    documentId: string,
    highlightId: string,
    request: UpdateHighlightRequest,
    options: RequestOptions = {}
  ): Promise<DocumentHighlight> {
    const { data } = await requestJson<DocumentHighlight>(this.context, {
      method: 'PATCH',
      path: `/documents/${encodeURIComponent(documentId)}/highlights/${encodeURIComponent(highlightId)}`,
      body: { note_text: request.noteText },
      signal: options.signal,
    });
    return data;
  }

  /** DELETE /documents/{document_id}/highlights/{highlight_id}. Rejects
   * with NotFoundError (404) if the highlight doesn't exist or isn't the
   * caller's. */
  async deleteDocumentHighlight(
    documentId: string,
    highlightId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/documents/${encodeURIComponent(documentId)}/highlights/${encodeURIComponent(highlightId)}`,
      signal: options.signal,
    });
  }

  // --- Frontend Milestone 3.1: Notebook ("Research Notes Workspace") ---
  // Never touches Qdrant/embeddings/retrieval — see notebooks.ts's module
  // docstring. There is deliberately no "ask" method here: Ask EduM8 from
  // a Notebook entry reuses the ordinary conversation-message flow (see
  // the frontend's TransientAIContext), never a second AI endpoint.

  /** GET /notebooks */
  async listNotebooks(
    params: ListNotebooksParams = {},
    options: RequestOptions = {}
  ): Promise<NotebookListResponse> {
    const { data } = await requestJson<NotebookListResponse>(this.context, {
      method: 'GET',
      path: '/notebooks',
      query: { limit: params.limit, offset: params.offset },
      signal: options.signal,
    });
    return data;
  }

  /** POST /notebooks */
  async createNotebook(
    request: CreateNotebookRequest,
    options: RequestOptions = {}
  ): Promise<Notebook> {
    const { data } = await requestJson<Notebook>(this.context, {
      method: 'POST',
      path: '/notebooks',
      body: { name: request.name },
      signal: options.signal,
    });
    return data;
  }

  /** PATCH /notebooks/{id} — renames the notebook; nothing else about it changes. */
  async renameNotebook(
    notebookId: string,
    request: RenameNotebookRequest,
    options: RequestOptions = {}
  ): Promise<Notebook> {
    const { data } = await requestJson<Notebook>(this.context, {
      method: 'PATCH',
      path: `/notebooks/${encodeURIComponent(notebookId)}`,
      body: { name: request.name },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /notebooks/{id} — deletes the notebook and only its own
   * entries. Never deletes the source documents, highlights, or
   * conversations any entry pointed at. Rejects with NotFoundError (404)
   * if the notebook doesn't exist or isn't the caller's.
   */
  async deleteNotebook(notebookId: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/notebooks/${encodeURIComponent(notebookId)}`,
      signal: options.signal,
    });
  }

  /** GET /notebooks/{id}/entries */
  async listNotebookEntries(
    notebookId: string,
    params: ListNotebookEntriesParams = {},
    options: RequestOptions = {}
  ): Promise<NotebookEntryListResponse> {
    const { data } = await requestJson<NotebookEntryListResponse>(this.context, {
      method: 'GET',
      path: `/notebooks/${encodeURIComponent(notebookId)}/entries`,
      query: { limit: params.limit, offset: params.offset },
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /notebooks/{id}/entries — either `{ entryType: "highlight",
   * documentId, highlightId }` (server derives every snapshot field from
   * the caller's own highlight; idempotent — adding the same highlight to
   * the same notebook twice returns the existing entry, never a
   * duplicate) or `{ entryType: "manual", noteText }`.
   */
  async addNotebookEntry(
    notebookId: string,
    request: AddNotebookEntryRequest,
    options: RequestOptions = {}
  ): Promise<NotebookEntry> {
    const body =
      request.entryType === 'highlight'
        ? {
            entry_type: 'highlight' as const,
            document_id: request.documentId,
            highlight_id: request.highlightId,
            note_text: request.noteText ?? null,
          }
        : { entry_type: 'manual' as const, note_text: request.noteText };
    const { data } = await requestJson<NotebookEntry>(this.context, {
      method: 'POST',
      path: `/notebooks/${encodeURIComponent(notebookId)}/entries`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /** PATCH /notebooks/{id}/entries/{entryId} — the note is the only
   * mutable field, for both highlight-derived and manual entries. */
  async updateNotebookEntry(
    notebookId: string,
    entryId: string,
    request: UpdateNotebookEntryRequest,
    options: RequestOptions = {}
  ): Promise<NotebookEntry> {
    const { data } = await requestJson<NotebookEntry>(this.context, {
      method: 'PATCH',
      path: `/notebooks/${encodeURIComponent(notebookId)}/entries/${encodeURIComponent(entryId)}`,
      body: { note_text: request.noteText },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /notebooks/{id}/entries/{entryId} — removes this entry from
   * this notebook only. Never deletes the source DocumentHighlight,
   * Document, or any other notebook's own copy of the same highlight.
   */
  async removeNotebookEntry(
    notebookId: string,
    entryId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/notebooks/${encodeURIComponent(notebookId)}/entries/${encodeURIComponent(entryId)}`,
      signal: options.signal,
    });
  }

  /**
   * POST /documents/metadata-preview (multipart) — extraction only: reads
   * embedded file metadata and runs the same structured-text/filename
   * fallbacks the backend would use during a real upload, but never
   * chunks, embeds, or writes anything to the index. Call this once a
   * file is picked so the caller can show the user editable detected
   * fields (title, authors, publication year, venue, DOI, source URL)
   * before they confirm the upload via uploadDocument() — safe to call
   * repeatedly (e.g. once per file picked) since nothing is ever indexed
   * twice as a result.
   */
  async previewDocumentMetadata(
    file: UploadableFile,
    options: RequestOptions = {}
  ): Promise<DocumentMetadataPreviewResponse> {
    const formData = new FormData();
    appendUploadableFile(formData, 'file', file);

    const { data } = await requestMultipart<DocumentMetadataPreviewResponse>(this.context, {
      method: 'POST',
      path: '/documents/metadata-preview',
      formData,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /documents (multipart), then polls GET /documents/jobs/{job_id}
   * until ingestion finishes. The initial POST returns almost immediately
   * (duplicate check, parsing, and chunking are the only synchronous parts
   * on the backend) — embedding + Qdrant indexing happen in a background
   * job afterward, since that can take minutes on CPU-only hardware and
   * must never hold one HTTP request open for it. The promise this returns
   * still resolves only once ingestion is fully complete (same contract as
   * before this became async), or rejects — with a NotFoundError if the
   * job disappears, or a BackendError carrying the backend's failure
   * reason if ingestion itself failed. Pass `options.onProgress` to
   * observe stage/chunk-count updates while it's in flight.
   */
  async uploadDocument(
    file: UploadableFile,
    metadata: DocumentUploadMetadata,
    options: RequestOptions = {}
  ): Promise<DocumentUploadResponse> {
    const formData = new FormData();
    appendUploadableFile(formData, 'file', file);
    if (metadata.documentType !== undefined) {
      formData.append('document_type', metadata.documentType);
    }
    if (metadata.journalQuartile) {
      formData.append('journal_quartile', metadata.journalQuartile);
    }
    if (metadata.title !== undefined) formData.append('title', metadata.title);
    if (metadata.authors !== undefined) formData.append('authors', metadata.authors.join(', '));
    if (metadata.publicationYear !== undefined) {
      formData.append('publication_year', String(metadata.publicationYear));
    }
    if (metadata.sourceVenue !== undefined) formData.append('source_venue', metadata.sourceVenue);
    if (metadata.doi !== undefined) formData.append('doi', metadata.doi);
    if (metadata.sourceUrl !== undefined) formData.append('source_url', metadata.sourceUrl);
    if (metadata.folderId !== undefined) formData.append('folder_id', metadata.folderId);

    const { data: accepted } = await requestMultipart<{ job_id: string }>(this.context, {
      method: 'POST',
      path: '/documents',
      formData,
      signal: options.signal,
    });

    for (;;) {
      const { data: job } = await requestJson<DocumentJobResponse>(this.context, {
        method: 'GET',
        path: `/documents/jobs/${encodeURIComponent(accepted.job_id)}`,
        signal: options.signal,
      });

      if (job.status === 'completed' && job.document) {
        return job.document;
      }
      if (job.status === 'failed') {
        throw new BackendError(job.error ?? 'Document ingestion failed', {
          statusCode: null,
          requestId: null,
        });
      }

      options.onProgress?.(job);
      await sleep(DOCUMENT_JOB_POLL_INTERVAL_MS);
    }
  }

  /**
   * POST /folders — Milestone 1 (Document Library / Folder Management).
   * Rejects with a 409 BackendError if a sibling folder already has this
   * name, or NotFoundError (404) if `parentId` doesn't exist / isn't the
   * caller's.
   */
  async createFolder(
    request: CreateFolderRequest,
    options: RequestOptions = {}
  ): Promise<FolderResponse> {
    const { data } = await requestJson<FolderResponse>(this.context, {
      method: 'POST',
      path: '/folders',
      body: { name: request.name, parent_id: request.parentId ?? null },
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /folders/contents — one round trip for a folder library screen:
   * the folder itself (omit `folderId`/pass null for root), its breadcrumb
   * chain, its direct child folders, and a page of its direct documents.
   */
  async getFolderContents(
    params: GetFolderContentsParams = {},
    options: RequestOptions = {}
  ): Promise<FolderContentsResponse> {
    const { data } = await requestJson<FolderContentsResponse>(this.context, {
      method: 'GET',
      path: '/folders/contents',
      query: {
        folder_id: params.folderId ?? undefined,
        limit: params.limit,
        offset: params.offset,
      },
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /folders/{folder_id} — partial update (see UpdateFolderRequest):
   * pass `name` to rename, `parentId` to move (null = root), or both at
   * once. Rejects with a 409 BackendError on a name conflict, or a 400
   * BackendError if `parentId` would create a circular reference.
   */
  async updateFolder(
    folderId: string,
    request: UpdateFolderRequest,
    options: RequestOptions = {}
  ): Promise<FolderResponse> {
    const body: Record<string, unknown> = {};
    if ('name' in request) body.name = request.name;
    if ('parentId' in request) body.parent_id = request.parentId;
    const { data } = await requestJson<FolderResponse>(this.context, {
      method: 'PATCH',
      path: `/folders/${encodeURIComponent(folderId)}`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /folders/{folder_id} — safe by default: rejects with a 409
   * BackendError if the folder directly contains a subfolder or a
   * document, unless `moveContentsToRoot: true` is passed, in which case
   * those direct contents are moved to root instead of the folder itself
   * ever being blocked from deletion. Never deletes contained documents.
   */
  async deleteFolder(
    folderId: string,
    params: DeleteFolderParams = {},
    options: RequestOptions = {}
  ): Promise<DeleteFolderResponse> {
    const { data } = await requestJson<DeleteFolderResponse>(this.context, {
      method: 'DELETE',
      path: `/folders/${encodeURIComponent(folderId)}`,
      query: { move_contents_to_root: params.moveContentsToRoot },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Incremental SSE stream of chat events (token/sources/done/error), in
   * the exact order the backend emits them. Throws StreamingUnsupportedError
   * if this runtime cannot deliver a response body incrementally — use
   * chat() as the documented fallback in that case. No conversation memory:
   * each call is a single, independent turn.
   */
  async *streamChat(
    request: ChatRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<ChatEvent, void, void> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/chat`;
    yield* streamChatEvents({
      url,
      token,
      body: request,
      signal: options.signal,
      timeoutMs: this.context.timeoutMs,
    });
  }

  /**
   * Buffered convenience wrapper around the same /chat SSE stream
   * streamChat() consumes: waits for the full response, then assembles one
   * ChatResult. Works in every runtime fetch works in (no ReadableStream
   * required), so this is also the correct fallback when streamChat()
   * throws StreamingUnsupportedError. Does not re-implement or second-guess
   * any backend decision (citations, insufficient_evidence, warnings are
   * passed through exactly as received).
   */
  async chat(request: ChatRequest, options: RequestOptions = {}): Promise<ChatResult> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/chat`;
    const startedAt = Date.now();

    const events = await fetchAllChatEvents({
      url,
      token,
      body: request,
      signal: options.signal,
      timeoutMs: this.context.timeoutMs,
    });

    return assembleChatResult(events, Date.now() - startedAt);
  }

  /**
   * GET /auth/providers — unauthenticated. Lists only the OAuth providers
   * that actually have credentials configured server-side, plus whether
   * the dev-only test-login endpoint is available. Never exposes a
   * provider's client secret or any other configuration detail.
   *
   * Normalizes the raw snake_case wire response into AuthProviders (see
   * that type's own docs) exactly once, here — every caller (AuthProvider.tsx,
   * the login screen, tests) works with `providers`/`devLoginEnabled`
   * directly and never re-derives "is dev login actually enabled" from a
   * raw, possibly-missing `dev_login_enabled` field itself.
   */
  async getAuthProviders(options: RequestOptions = {}): Promise<AuthProviders> {
    const { data } = await requestJson<AuthProvidersResponse>(this.context, {
      method: 'GET',
      path: '/auth/providers',
      signal: options.signal,
    });
    // TEMPORARY (see EduM8's frontend-login-empty-state debugging
    // session) — the raw, pre-normalization wire body, so a caller with
    // devtools open can compare exactly what the backend sent against the
    // normalized value logged in AuthProvider.tsx. Safe to remove once
    // this class of bug is confirmed fixed; never logs a token or any
    // auth-secret value, only the providers list + dev_login_enabled flag.
    if (process.env.NODE_ENV !== 'production') {
      console.log('[EducationAssistantClient] GET /auth/providers raw response:', data);
    }
    return {
      providers: data.providers ?? [],
      devLoginEnabled: data.dev_login_enabled === true,
      localAuthEnabled: data.local_auth_enabled === true,
    };
  }

  /**
   * POST /auth/register — creates a local (email/password) account.
   * Returns a RegisterResult, not a bare AuthTokenResponse: when email
   * verification is required (the default — see
   * `result.email_verification_required`), no tokens are issued yet and
   * every token/user field is null; the caller should route to
   * /check-email. Only when an operator has disabled verification are
   * tokens populated immediately. `password` is read once from `body` and
   * handed straight to the request body; never logged, never included in
   * a thrown error (see errors.ts's safeMessage, which only ever surfaces
   * the backend's own `detail` string).
   */
  async register(body: RegisterRequestBody, options: RequestOptions = {}): Promise<RegisterResult> {
    const { data } = await requestJson<RegisterResult>(this.context, {
      method: 'POST',
      path: '/auth/register',
      body,
      signal: options.signal,
      credentials: 'include',
    });
    return data;
  }

  /**
   * POST /auth/login — local email/password sign-in, reusing the exact
   * same session/token architecture as OAuth (see `register` above).
   * Always fails with a generic AuthenticationError message ("Invalid
   * email or password") regardless of *why* — unknown email, wrong
   * password, or an OAuth-only account with no password set — see
   * rag-backend's app/core/auth_service.py::authenticate_local_user. For
   * a correct password on an unverified local account, fails instead with
   * an AuthorizationError (HTTP 403) whose message is the stable code
   * "email_verification_required" — never a full sentence, so callers can
   * branch on it reliably (see rag-backend's POST /auth/login docstring).
   */
  async login(body: LoginRequestBody, options: RequestOptions = {}): Promise<AuthTokenResponse> {
    const { data } = await requestJson<AuthTokenResponse>(this.context, {
      method: 'POST',
      path: '/auth/login',
      body,
      signal: options.signal,
      credentials: 'include',
    });
    return data;
  }

  /**
   * POST /auth/resend-verification — always resolves with the same
   * generic message regardless of whether the address is registered,
   * already verified, or OAuth-only (see rag-backend's
   * GenericMessageResponse) — never throws to signal "no such account".
   */
  async resendVerification(
    email: string,
    options: RequestOptions = {}
  ): Promise<GenericMessageResult> {
    const { data } = await requestJson<GenericMessageResult>(this.context, {
      method: 'POST',
      path: '/auth/resend-verification',
      body: { email },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Builds (but does not navigate to) the URL that starts one provider's
   * OAuth flow: GET /auth/{provider}/authorize. The caller is responsible
   * for actually opening it — a top-level web navigation, or
   * expo-web-browser's openAuthSessionAsync() on native — since this SDK
   * has no browser/WebView dependency of its own. `redirectUri` must be on
   * the backend's ALLOWED_AUTH_REDIRECT_URIS allowlist or the authorize
   * call itself will 400.
   */
  buildOAuthAuthorizeUrl(provider: string, redirectUri: string): string {
    const url = new URL(`${this.baseUrl}/auth/${encodeURIComponent(provider)}/authorize`);
    url.searchParams.set('redirect_uri', redirectUri);
    return url.toString();
  }

  /**
   * POST /auth/session/exchange — redeems the single-use `auth_code` from
   * the OAuth callback's redirect for real tokens. This is the only place
   * tokens are ever transmitted outside a header, and only as a direct
   * JSON response body (never a URL) — see rag-backend's
   * app/api/routes_auth.py for the full rationale. Sends credentials so a
   * web caller also receives the backend's HttpOnly refresh cookie.
   */
  async exchangeAuthCode(
    authCode: string,
    options: RequestOptions = {}
  ): Promise<AuthTokenResponse> {
    const { data } = await requestJson<AuthTokenResponse>(this.context, {
      method: 'POST',
      path: '/auth/session/exchange',
      body: { auth_code: authCode },
      signal: options.signal,
      credentials: 'include',
    });
    return data;
  }

  /**
   * POST /auth/refresh — redeems a refresh token (or, on web, relies
   * entirely on the HttpOnly cookie already attached via `credentials:
   * 'include'`) for a new access+refresh token pair. The backend rotates
   * the refresh token on every call; the caller must persist the new one
   * and discard the old.
   */
  async refreshSession(
    refreshToken?: string,
    options: RequestOptions = {}
  ): Promise<AuthTokenResponse> {
    const { data } = await requestJson<AuthTokenResponse>(this.context, {
      method: 'POST',
      path: '/auth/refresh',
      body: { refresh_token: refreshToken ?? null },
      signal: options.signal,
      credentials: 'include',
    });
    return data;
  }

  /**
   * POST /auth/logout — revokes the given (or cookie-supplied) refresh
   * token session. Idempotent: succeeds even if the token is already
   * unknown or revoked. Never touches any other user data — see
   * rag-backend's app/core/auth_service.py.
   */
  async logout(refreshToken?: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'POST',
      path: '/auth/logout',
      body: { refresh_token: refreshToken ?? null },
      signal: options.signal,
      credentials: 'include',
    });
  }

  /**
   * GET /auth/me — protected. Returns the authenticated user's current
   * profile. Useful to re-validate/refresh profile fields independently of
   * a login response.
   */
  async getMe(options: RequestOptions = {}): Promise<AuthUser> {
    const { data } = await requestJson<AuthUser>(this.context, {
      method: 'GET',
      path: '/auth/me',
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /auth/dev-login — development/test convenience only; the backend
   * refuses this with 404 unless AUTH_DEV_LOGIN_ENABLED is set and
   * APP_ENV != "production". Never call this from production UI code
   * without a build-time flag gating its visibility (see the Expo app's
   * AuthProvider for that gate).
   */
  async devLogin(
    email: string,
    displayName?: string,
    options: RequestOptions = {}
  ): Promise<AuthTokenResponse> {
    const { data } = await requestJson<AuthTokenResponse>(this.context, {
      method: 'POST',
      path: '/auth/dev-login',
      body: { email, display_name: displayName ?? null },
      signal: options.signal,
      credentials: 'include',
    });
    return data;
  }

  /** POST /conversations — creates a new, empty conversation. */
  async createConversation(options: RequestOptions = {}): Promise<ConversationDetail> {
    const { data } = await requestJson<ConversationDetail>(this.context, {
      method: 'POST',
      path: '/conversations',
      signal: options.signal,
    });
    return data;
  }

  /** GET /conversations — paginated, most-recently-active first. */
  async listConversations(
    params: ListConversationsParams = {},
    options: RequestOptions = {}
  ): Promise<ConversationListResponse> {
    const { data } = await requestJson<ConversationListResponse>(this.context, {
      method: 'GET',
      path: '/conversations',
      query: { limit: params.limit, offset: params.offset },
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /conversations/{id} — full detail including every message and its
   * sources. Rejects with NotFoundError (404) for an unknown conversation
   * or one belonging to a different user — the backend never distinguishes
   * the two, so this client can't either.
   */
  async getConversation(
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<ConversationDetail> {
    const { data } = await requestJson<ConversationDetail>(this.context, {
      method: 'GET',
      path: `/conversations/${encodeURIComponent(conversationId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /conversations/{id} — renames a conversation. Once renamed, the
   * backend's auto-title generator never overwrites the title again.
   */
  async renameConversation(
    conversationId: string,
    title: string,
    options: RequestOptions = {}
  ): Promise<ConversationSummary> {
    const { data } = await requestJson<ConversationSummary>(this.context, {
      method: 'PATCH',
      path: `/conversations/${encodeURIComponent(conversationId)}`,
      body: { title },
      signal: options.signal,
    });
    return data;
  }

  /** DELETE /conversations/{id} — hard delete; cascades to its messages/sources only, never to `documents`. */
  async deleteConversation(conversationId: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/conversations/${encodeURIComponent(conversationId)}`,
      signal: options.signal,
    });
  }

  /**
   * GET /conversations/{id}/documents — Milestone 2 (conversation document
   * scope): the conversation's current chat-scope document selection, what
   * retrieval's "chat" tier actually draws from for this conversation's
   * next turn. 404s (NotFoundError) if conversation_scope_enabled is off
   * on the backend, or the conversation doesn't exist / isn't the
   * caller's.
   */
  async listConversationDocuments(
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<ConversationDocumentListResponse> {
    const { data } = await requestJson<ConversationDocumentListResponse>(this.context, {
      method: 'GET',
      path: `/conversations/${encodeURIComponent(conversationId)}/documents`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /conversations/{id}/documents — associates one or more
   * already-ingested documents (see uploadDocument()) with this
   * conversation as chat-scope retrieval evidence in a single call; never
   * re-embeds anything. Idempotent per id and de-duplicated within
   * `documentIds`. Rejects with NotFoundError (404) if the conversation,
   * or any one of `documentIds`, doesn't exist / isn't the caller's — the
   * backend applies nothing at all in that case (never a partial add).
   * Returns the conversation's full current selection, not just the
   * newly-added ids.
   */
  async addConversationDocuments(
    conversationId: string,
    documentIds: string[],
    options: RequestOptions = {}
  ): Promise<ConversationDocumentListResponse> {
    const { data } = await requestJson<ConversationDocumentListResponse>(this.context, {
      method: 'POST',
      path: `/conversations/${encodeURIComponent(conversationId)}/documents`,
      body: { document_ids: documentIds },
      signal: options.signal,
    });
    return data;
  }

  /**
   * PUT /conversations/{id}/documents — makes `documentIds` this
   * conversation's ENTIRE chat-scope selection: documents not listed are
   * removed, documents listed but not yet associated are added, documents
   * in both are left untouched (no redundant Qdrant resync). Pass `[]` to
   * clear the selection entirely — see clearConversationDocuments(), a
   * thin convenience wrapper over exactly this call.
   */
  async replaceConversationDocuments(
    conversationId: string,
    documentIds: string[],
    options: RequestOptions = {}
  ): Promise<ConversationDocumentListResponse> {
    const { data } = await requestJson<ConversationDocumentListResponse>(this.context, {
      method: 'PUT',
      path: `/conversations/${encodeURIComponent(conversationId)}/documents`,
      body: { document_ids: documentIds },
      signal: options.signal,
    });
    return data;
  }

  /** Convenience wrapper over replaceConversationDocuments(id, []) — clears the conversation's entire chat-scope selection. There is no separate backend "clear" endpoint. */
  async clearConversationDocuments(
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<ConversationDocumentListResponse> {
    return this.replaceConversationDocuments(conversationId, [], options);
  }

  /**
   * DELETE /conversations/{id}/documents/{document_id} — removes only the
   * association, never the document itself (it may still be part of the
   * caller's general corpus or another conversation's/project's scope).
   * Pre-dates conversation_scope_enabled and is never gated by it (see
   * the backend's _require_conversation_scope_enabled docstring).
   */
  async removeConversationDocument(
    conversationId: string,
    documentId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(documentId)}`,
      signal: options.signal,
    });
  }

  /**
   * GET /conversations/{id}/scope — the conversation's "active scope"
   * toggle bar, including `zoomInMode` (Milestone 4: Zoom-In / strict
   * selected-source mode). Lazily created server-side on first read, so
   * this always resolves to a well-defined value even for a conversation
   * that has never touched its scope settings.
   */
  async getConversationScope(
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<ConversationScope> {
    const { data } = await requestJson<ConversationScope>(this.context, {
      method: 'GET',
      path: `/conversations/${encodeURIComponent(conversationId)}/scope`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /conversations/{id}/scope — partial update; only fields actually
   * present on `request` are sent (see UpdateConversationScopeRequest).
   * Setting `zoomInMode: true` rejects with a BackendError (422) if this
   * conversation currently has zero selected chat-scope documents (see
   * addConversationDocuments/replaceConversationDocuments) — Zoom-In
   * always requires at least one selected source. Turning `zoomInMode`
   * back off, or a request that never mentions it, is never subject to
   * that check.
   */
  async updateConversationScope(
    conversationId: string,
    request: UpdateConversationScopeRequest,
    options: RequestOptions = {}
  ): Promise<ConversationScope> {
    const body: Record<string, unknown> = {};
    if ('chatEnabled' in request) body.chat_enabled = request.chatEnabled;
    if ('projectEnabled' in request) body.project_enabled = request.projectEnabled;
    if ('generalEnabled' in request) body.general_enabled = request.generalEnabled;
    if ('includeOtherProjectSummaries' in request) {
      body.include_other_project_summaries = request.includeOtherProjectSummaries;
    }
    if ('zoomInMode' in request) body.zoom_in_mode = request.zoomInMode;

    const { data } = await requestJson<ConversationScope>(this.context, {
      method: 'PATCH',
      path: `/conversations/${encodeURIComponent(conversationId)}/scope`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Explicit cancellation of a message still generating (status
   * 'generating') — distinct from merely aborting the local fetch/SSE
   * read: this actually stops the backend's detached background worker
   * (see rag-backend's app/core/generation_manager.py), so the message
   * is persisted as 'cancelled' rather than left running to completion
   * unseen. A no-op (still returns normally) if the generation already
   * finished by the time this reaches the backend — see that route's
   * own docstring.
   */
  async cancelMessage(
    conversationId: string,
    messageId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'POST',
      path: `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      signal: options.signal,
    });
  }

  /**
   * Incremental SSE stream of one conversation turn's events (token/sources/
   * done/error) — same event shapes and ordering as streamChat(), except
   * the backend also persists the user's message immediately and the
   * assistant's message once the stream completes (see
   * app/api/routes_conversations.py). Throws StreamingUnsupportedError in
   * runtimes without incremental streaming — use postConversationMessage()
   * as the buffered fallback.
   */
  async *streamConversationMessage(
    conversationId: string,
    request: PostConversationMessageRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<ChatEvent, void, void> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/conversations/${encodeURIComponent(conversationId)}/messages`;
    const hasAttachments = (request.attachments?.length ?? 0) > 0;
    yield* streamChatEvents({
      url,
      token,
      body: request,
      formData: hasAttachments ? buildConversationMessageFormData(request) : undefined,
      signal: options.signal,
      timeoutMs: this.context.timeoutMs,
    });
  }

  /** Buffered convenience wrapper around streamConversationMessage() — see chat() for the same tradeoff. */
  async postConversationMessage(
    conversationId: string,
    request: PostConversationMessageRequest,
    options: RequestOptions = {}
  ): Promise<ChatResult> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/conversations/${encodeURIComponent(conversationId)}/messages`;
    const startedAt = Date.now();
    const hasAttachments = (request.attachments?.length ?? 0) > 0;

    const events = await fetchAllChatEvents({
      url,
      token,
      body: request,
      formData: hasAttachments ? buildConversationMessageFormData(request) : undefined,
      signal: options.signal,
      timeoutMs: this.context.timeoutMs,
    });

    return assembleChatResult(events, Date.now() - startedAt);
  }

  /**
   * Convenience entry point over streamConversationMessage() specifically
   * for a vision-routed turn (milestone V3): any attached image/PDF
   * routes the message to the vision model instead of the text model
   * (see rag-backend's app/core/model_routing.py), and `useCorpus`
   * decides whether retrieval also runs alongside it. Rejects with a
   * plain TypeError, before any network request is made, if `images` is
   * empty — a vision call with nothing to look at is always a caller
   * bug, not something worth a round trip to have the backend reject.
   * Like any async generator, this surfaces on the first `.next()` (e.g.
   * the first iteration of a `for await` loop over the result), not at
   * the point this method is called — async functions/generators never
   * throw synchronously in JavaScript, regardless of how early the error
   * originates.
   */
  async *sendVisionMessage(
    conversationId: string,
    request: SendVisionMessageRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<ChatEvent, void, void> {
    yield* this.streamConversationMessage(
      conversationId,
      visionRequestToPostRequest(request),
      options
    );
  }

  /** Buffered convenience wrapper around sendVisionMessage() — see chat() for the same tradeoff. */
  async postVisionMessage(
    conversationId: string,
    request: SendVisionMessageRequest,
    options: RequestOptions = {}
  ): Promise<ChatResult> {
    return this.postConversationMessage(
      conversationId,
      visionRequestToPostRequest(request),
      options
    );
  }

  /**
   * Builds the URL for GET .../attachments/{attachmentId} (milestone V3),
   * or its .../preview?page=N variant (milestone V4) when `page` is
   * given — pure string construction, no auth or network I/O. Useful on
   * its own for a native <Image> source (paired with
   * getAttachmentImageSource()'s headers) but NOT usable as a bare web
   * `<img src>`: the endpoint requires a Bearer token, and a browser's
   * `<img>` tag cannot attach custom headers — use fetchAttachmentBlob()
   * on web instead. `page` only makes sense for a PDF attachment — the
   * backend 400s if the attachment isn't one (see routes_conversations.py).
   */
  buildAttachmentUrl(
    conversationId: string,
    messageId: string,
    attachmentId: string,
    page?: number
  ): string {
    const base =
      `${this.baseUrl}/conversations/${encodeURIComponent(conversationId)}` +
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    return page === undefined ? base : `${base}/preview?page=${encodeURIComponent(page)}`;
  }

  /**
   * GET .../attachments/{attachmentId} (milestone V3), or its page
   * preview variant when `page` is given (milestone V4) — fetches the
   * bytes as a Blob, for a **web** caller to turn into an object URL
   * (`URL.createObjectURL(blob)`) for an `<img src>` or similar. Native
   * (React Native) callers should prefer getAttachmentImageSource()
   * instead and let `<Image>` fetch the URL itself — RN's Image
   * component supports a `headers` field on its source and fetching a
   * Blob first isn't the natural fit there.
   */
  async fetchAttachmentBlob(
    conversationId: string,
    messageId: string,
    attachmentId: string,
    options: RequestOptions & { page?: number } = {}
  ): Promise<Blob> {
    const token = await this.context.getAccessToken();
    const url = this.buildAttachmentUrl(conversationId, messageId, attachmentId, options.page);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const { signal, dispose, didTimeOut } = combineSignals(options.signal, this.context.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (cause) {
      dispose();
      if (isAbortError(cause)) {
        if (didTimeOut()) {
          throw new TimeoutError(
            `Fetching attachment ${attachmentId} timed out after ${this.context.timeoutMs}ms`
          );
        }
        throw new RequestCancelledError(`Fetching attachment ${attachmentId} was cancelled`);
      }
      throw new NetworkError(`Network request to fetch attachment ${attachmentId} failed`, {
        cause,
      });
    }
    dispose();

    if (!response.ok) {
      const requestId = extractRequestId(response.headers);
      const bodyText = await safeReadText(response);
      const { detail, rawBody } = parseErrorBody(bodyText);
      throw errorFromResponse({ status: response.status, detail, requestId, rawBody });
    }

    return response.blob();
  }

  /**
   * Resolves to a value usable directly as a React Native `<Image>`
   * source (`<Image source={await client.getAttachmentImageSource(...)}
   * />`) — RN's Image component fetches the URI itself and supports a
   * `headers` field for exactly this "authenticated image" case. Pass
   * `page` (milestone V4) to request a PDF attachment's rendered page
   * preview instead of its raw bytes. Never use this on web: a browser
   * `<img>` tag ignores a `source.headers`-style field entirely (there is
   * no such concept for a plain `<img>`) — use fetchAttachmentBlob() +
   * `URL.createObjectURL()` there instead.
   */
  async getAttachmentImageSource(
    conversationId: string,
    messageId: string,
    attachmentId: string,
    page?: number
  ): Promise<{ uri: string; headers: Record<string, string> }> {
    const token = await this.context.getAccessToken();
    return {
      uri: this.buildAttachmentUrl(conversationId, messageId, attachmentId, page),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    };
  }

  /** POST /projects — creates a project owned by the authenticated user. */
  async createProject(
    request: CreateProjectRequest,
    options: RequestOptions = {}
  ): Promise<ProjectSummary> {
    const { data } = await requestJson<ProjectSummary>(this.context, {
      method: 'POST',
      path: '/projects',
      body: { name: request.name, description: request.description ?? null },
      signal: options.signal,
    });
    return data;
  }

  /** GET /projects — only the authenticated user's own projects. */
  async listProjects(
    params: ListProjectsParams = {},
    options: RequestOptions = {}
  ): Promise<ProjectListResponse> {
    const { data } = await requestJson<ProjectListResponse>(this.context, {
      method: 'GET',
      path: '/projects',
      query: { limit: params.limit, offset: params.offset },
      signal: options.signal,
    });
    return data;
  }

  /** GET /projects/{id} — 404 for a missing or unauthorized project. */
  async getProject(projectId: string, options: RequestOptions = {}): Promise<ProjectSummary> {
    const { data } = await requestJson<ProjectSummary>(this.context, {
      method: 'GET',
      path: `/projects/${encodeURIComponent(projectId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /projects/{id} — partial update. Only fields actually present on
   * `request` are sent, so omitting `description` never clears it and
   * omitting `name` never touches the existing name (see
   * UpdateProjectRequest's docs).
   */
  async updateProject(
    projectId: string,
    request: UpdateProjectRequest,
    options: RequestOptions = {}
  ): Promise<ProjectSummary> {
    const body: Record<string, unknown> = {};
    if ('name' in request) body.name = request.name;
    if ('description' in request) body.description = request.description;

    const { data } = await requestJson<ProjectSummary>(this.context, {
      method: 'PATCH',
      path: `/projects/${encodeURIComponent(projectId)}`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /projects/{id} — deletes only the project and its conversation
   * associations; every conversation that was in it remains fully intact
   * in the user's normal conversation history.
   */
  async deleteProject(projectId: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(projectId)}`,
      signal: options.signal,
    });
  }

  /** GET /projects/{id}/conversations — the conversations currently assigned to this project. */
  async listProjectConversations(
    projectId: string,
    params: ListProjectConversationsParams = {},
    options: RequestOptions = {}
  ): Promise<ProjectConversationListResponse> {
    const { data } = await requestJson<ProjectConversationListResponse>(this.context, {
      method: 'GET',
      path: `/projects/${encodeURIComponent(projectId)}/conversations`,
      query: { limit: params.limit, offset: params.offset },
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /projects/{id}/conversations — assigns an existing conversation
   * (which must belong to the caller) to this project (which must also
   * belong to the caller). Idempotent: re-adding a conversation already in
   * the project succeeds and returns the existing association unchanged,
   * rather than erroring or duplicating it.
   */
  async addProjectConversation(
    projectId: string,
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<ProjectConversation> {
    const { data } = await requestJson<ProjectConversation>(this.context, {
      method: 'POST',
      path: `/projects/${encodeURIComponent(projectId)}/conversations`,
      body: { conversation_id: conversationId },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /projects/{id}/conversations/{conversationId} — removes only
   * the project association; the conversation itself is untouched and
   * stays exactly as visible in normal conversation history as before.
   */
  async removeProjectConversation(
    projectId: string,
    conversationId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
      signal: options.signal,
    });
  }

  /**
   * Milestone 5 (Academic Writing & LaTeX Foundation): POST
   * /writing-projects — creates a new LaTeX writing project, seeded with
   * the backend's minimal honest starting template (no fake authors,
   * affiliations, references, or content — see DEFAULT_MAIN_TEX_TEMPLATE
   * server-side).
   */
  async createWritingProject(
    request: CreateWritingProjectRequest,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: '/writing-projects',
      body: { title: request.title, description: request.description ?? null },
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /writing-projects — every writing project owned by the
   * authenticated user. Summaries only — never includes
   * main_tex_content (see WritingProject vs WritingProjectSummary).
   *
   * Milestone 5.3 Part 26/27/28/30 — `query.q` searches title/
   * description only (no AI search). `query.sort` defaults to
   * "updated_at" (newest-updated first, the pre-M5.3 behavior).
   * `query.archived: true` returns ONLY archived projects — never a
   * mixed active+archived view.
   */
  async listWritingProjects(
    query: { q?: string; sort?: 'updated_at' | 'name' | 'created_at'; archived?: boolean } = {},
    options: RequestOptions = {}
  ): Promise<WritingProjectListResponse> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    // "updated_at" is the backend's own default — omitted here (not
    // just falling out of `if (query.sort)`, since a caller's hook may
    // always pass its current sort state explicitly) so an ordinary,
    // unfiltered dashboard load still hits the exact same
    // `/writing-projects` URL it did before Milestone 5.3, never a
    // gratuitous `?sort=updated_at` query string.
    if (query.sort && query.sort !== 'updated_at') params.set('sort', query.sort);
    if (query.archived) params.set('archived', 'true');
    const qs = params.toString();
    const { data } = await requestJson<WritingProjectListResponse>(this.context, {
      method: 'GET',
      path: qs ? `/writing-projects?${qs}` : '/writing-projects',
      signal: options.signal,
    });
    return data;
  }

  /** GET /writing-projects/{id} — the full project, including its LaTeX
   * source. Rejects with NotFoundError (404) if the project doesn't
   * exist or isn't the caller's. */
  async getWritingProject(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * PATCH /writing-projects/{id} — the editor's autosave endpoint
   * (`mainTexContent`), and also how title/description are renamed.
   * Partial update: only a field actually present in `request` is
   * touched — omit a field entirely to leave it unchanged; `title`
   * cannot be cleared, `description` can be explicitly cleared with
   * `null`.
   */
  async updateWritingProject(
    projectId: string,
    request: UpdateWritingProjectRequest,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const body: Record<string, unknown> = {};
    if ('title' in request) body.title = request.title;
    if ('description' in request) body.description = request.description;
    if ('mainTexContent' in request) body.main_tex_content = request.mainTexContent;

    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'PATCH',
      path: `/writing-projects/${encodeURIComponent(projectId)}`,
      body,
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /writing-projects/{id} — deletes only this project's own row
   * and its reference associations. Never deletes any referenced
   * Document, its highlights, Notebook entries, or chat conversations.
   */
  async deleteWritingProject(projectId: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/writing-projects/${encodeURIComponent(projectId)}`,
      signal: options.signal,
    });
  }

  /**
   * GET /writing-projects/{id}/references — every current reference,
   * with the associated document's live canonical bibliographic identity
   * plus whether its citation key currently appears in the manuscript
   * (`cited`). `missingCitationKeys` lists any `\cite{}` key in the
   * manuscript that doesn't match any current reference.
   */
  async listWritingProjectReferences(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectReferencesResponse> {
    const { data } = await requestJson<WritingProjectReferencesResponse>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}/references`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /writing-projects/{id}/references — adds one or more existing
   * library Documents as project references (reuses Documents' existing
   * multi-selection UX). Every document_id is ownership-checked
   * individually server-side; never a hard failure for a
   * duplicate/nonexistent/another-user's id — see each result's own
   * `outcome`.
   */
  async addWritingProjectReferences(
    projectId: string,
    documentIds: string[],
    options: RequestOptions = {}
  ): Promise<AddWritingProjectReferencesResponse> {
    const { data } = await requestJson<AddWritingProjectReferencesResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/references`,
      body: { document_ids: documentIds },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /writing-projects/{id}/references/{documentId} — removes only
   * the reference association. Never deletes the Document itself, its
   * highlights, or any Notebook entry.
   */
  async removeWritingProjectReference(
    projectId: string,
    documentId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/writing-projects/${encodeURIComponent(projectId)}/references/${encodeURIComponent(documentId)}`,
      signal: options.signal,
    });
  }

  /**
   * GET /writing-projects/{id}/bibliography — a BibTeX bibliography
   * generated fresh from the project's current references, via the exact
   * same Milestone 4.2 engine every other BibTeX surface uses. Read-only
   * (Milestone 5 §13): never a second, independently-editable
   * bibliography store.
   */
  async getWritingProjectBibliography(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectBibliography> {
    const { data } = await requestJson<WritingProjectBibliography>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}/bibliography`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /writing-projects/{id}/export — fetches the portable project ZIP
   * (main.tex + references.bib) as a Blob, for a caller to save/share
   * (see lib/downloadWritingProjectExport.ts in the example app for the
   * web-download / native-share-sheet split, mirroring
   * fetchAttachmentBlob's own established pattern). Rejects with
   * NotFoundError (404) if the project doesn't exist or isn't the
   * caller's.
   */
  async fetchWritingProjectExportBlob(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<Blob> {
    const token = await this.context.getAccessToken();
    const url = `${this.baseUrl}/writing-projects/${encodeURIComponent(projectId)}/export`;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const { signal, dispose, didTimeOut } = combineSignals(options.signal, this.context.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (cause) {
      dispose();
      if (isAbortError(cause)) {
        if (didTimeOut()) {
          throw new TimeoutError(
            `Fetching writing project export ${projectId} timed out after ${this.context.timeoutMs}ms`
          );
        }
        throw new RequestCancelledError(
          `Fetching writing project export ${projectId} was cancelled`
        );
      }
      throw new NetworkError(
        `Network request to fetch writing project export ${projectId} failed`,
        { cause }
      );
    }
    dispose();

    if (!response.ok) {
      const requestId = extractRequestId(response.headers);
      const bodyText = await safeReadText(response);
      const { detail, rawBody } = parseErrorBody(bodyText);
      throw errorFromResponse({ status: response.status, detail, requestId, rawBody });
    }

    return response.blob();
  }

  /**
   * Milestone 5.1 — POST /writing-projects/{id}/compile. Compiles the
   * project's CURRENT saved main_tex_content server-side (never a
   * client-supplied body — the caller is responsible for flushing any
   * pending autosave and awaiting a successful save FIRST, e.g. via
   * useWritingProject's own flush-before-compile helper). Never throws
   * for an ordinary "couldn't compile" outcome — `status` on the
   * returned CompileWritingProjectResponse covers "success" | "error" |
   * "timeout" | "busy" | "unavailable" as plain, renderable values; this
   * only rejects for a genuine transport failure (network down) or an
   * ownership/not-found 404, same as every other writing-project call.
   * Uses DEFAULT_COMPILE_TIMEOUT_MS, not this client's normal 30s
   * default — see that constant's docs.
   */
  async compileWritingProject(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<CompileWritingProjectResponse> {
    const { data } = await requestJson<CompileWritingProjectResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/compile`,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS,
    });
    return data;
  }

  /**
   * Milestone 5.1 — GET /writing-projects/{id}/compile/{compileId}/pdf,
   * fetched as a Blob for the PDF preview panel (pdf.js) or a "Download
   * PDF" action. Mirrors fetchWritingProjectExportBlob's own manual-
   * fetch shape (a Blob response can't go through requestJson's
   * JSON-only parsing). The artifact is short-lived (see the backend's
   * CompileArtifactCache TTL) — a 404 here means "expired or never
   * existed," not necessarily a real error; the caller should treat it
   * as "compile again."
   */
  async fetchCompiledPdfBlob(
    projectId: string,
    compileId: string,
    options: RequestOptions = {}
  ): Promise<Blob> {
    const token = await this.context.getAccessToken();
    const url = `${this.baseUrl}/writing-projects/${encodeURIComponent(projectId)}/compile/${encodeURIComponent(compileId)}/pdf`;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const { signal, dispose, didTimeOut } = combineSignals(options.signal, this.context.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (cause) {
      dispose();
      if (isAbortError(cause)) {
        if (didTimeOut()) {
          throw new TimeoutError(
            `Fetching compiled PDF for writing project ${projectId} timed out after ${this.context.timeoutMs}ms`
          );
        }
        throw new RequestCancelledError(
          `Fetching compiled PDF for writing project ${projectId} was cancelled`
        );
      }
      throw new NetworkError(
        `Network request to fetch compiled PDF for writing project ${projectId} failed`,
        { cause }
      );
    }
    dispose();

    if (!response.ok) {
      const requestId = extractRequestId(response.headers);
      const bodyText = await safeReadText(response);
      const { detail, rawBody } = parseErrorBody(bodyText);
      throw errorFromResponse({ status: response.status, detail, requestId, rawBody });
    }

    return response.blob();
  }

  /**
   * SyncTeX implementation (Writing UX Refinement milestone) — POST
   * /writing-projects/{id}/compile/{compileId}/inverse-search. A
   * rendered-PDF double-click's page + coordinates (already converted
   * from pdf.js viewport pixels to PDF points by the caller — see
   * CompiledPdfPreview's own click handler), resolved server-side via
   * real SyncTeX to an exact source file + line. Never throws for an
   * ordinary "couldn't resolve a location" outcome — `resolved: false`
   * on the returned InverseSearchResult covers that as a plain,
   * renderable value (the caller must decline navigation, never guess);
   * this only rejects for a genuine transport failure or an ownership/
   * not-found 404, same as every other writing-project call.
   */
  async inverseSearchCompiledPdf(
    projectId: string,
    compileId: string,
    location: { page: number; x: number; y: number },
    options: RequestOptions = {}
  ): Promise<InverseSearchResult> {
    const { data } = await requestJson<InverseSearchResult>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/compile/${encodeURIComponent(compileId)}/inverse-search`,
      body: location,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return data;
  }

  /**
   * Milestone 5.3 Part 30 — hides the project from the default dashboard
   * view (`listWritingProjects()` with no `archived` option). Always
   * reversible via restoreWritingProject().
   */
  async archiveWritingProject(projectId: string, options: RequestOptions = {}): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/archive`,
      signal: options.signal,
    });
    return data;
  }

  async restoreWritingProject(projectId: string, options: RequestOptions = {}): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/restore`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 5.3 Part 29 — duplicates project metadata, the full file
   * tree (including binary asset bytes), and project-reference
   * associations. Never duplicates the referenced Documents, Notebook
   * entries, or Chat conversations — see the backend route's own
   * docstring. Omit `title` for the backend's default
   * "{original title} (copy)".
   */
  async duplicateWritingProject(
    projectId: string,
    title?: string,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/duplicate`,
      body: { title: title ?? null },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Milestone 5.3 Part 4/41 — GET /writing-projects/{id}/files. Metadata
   * only for every real file/folder (never `contentText`/binary bytes —
   * see getWritingProjectFileContent for that), plus the synthesized
   * read-only `references.bib` entry.
   */
  async listWritingProjectFiles(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileTree> {
    const { data } = await requestJson<WritingProjectFileTree>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files`,
      signal: options.signal,
    });
    return data;
  }

  /** Part 6 — validated server-side: safe name, no path separators/'..'. */
  async createWritingProjectFolder(
    projectId: string,
    request: CreateWritingProjectFolderRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/folders`,
      body: { parent_id: request.parentId ?? null, name: request.name },
      signal: options.signal,
    });
    return data;
  }

  /** Part 5 — a new, empty (or seeded) `.tex`/`.txt`/`.cls`/`.sty` file. */
  async createWritingProjectTextFile(
    projectId: string,
    request: CreateWritingProjectTextFileRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/text`,
      body: { parent_id: request.parentId ?? null, name: request.name, content_text: request.contentText ?? '' },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Part 10/11 — a safe, bounded project-asset upload
   * (.tex/.cls/.sty/.png/.jpg/.jpeg/.pdf only; the backend re-sniffs real
   * bytes for binary files, never trusting the extension/declared MIME
   * alone).
   */
  async uploadWritingProjectFile(
    projectId: string,
    file: UploadableFile,
    fileOptions: { parentId?: string | null; name?: string } = {},
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const formData = new FormData();
    appendUploadableFile(formData, 'file', file);
    if (fileOptions.parentId) formData.append('parent_id', fileOptions.parentId);
    if (fileOptions.name) formData.append('name', fileOptions.name);

    const { data } = await requestMultipart<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/upload`,
      formData,
      signal: options.signal,
    });
    return data;
  }

  /**
   * GET /writing-projects/{id}/files/{fileId} — a text file's content
   * inline; for a binary file, `contentText` is null (use
   * fetchWritingProjectFileBinaryBlob for those bytes).
   */
  async getWritingProjectFileContent(
    projectId: string,
    fileId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileContent> {
    const { data } = await requestJson<WritingProjectFileContent>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Part 21 — a binary asset's raw bytes as a Blob, for a small
   * image/PDF preview pane. Mirrors fetchWritingProjectExportBlob's own
   * manual-fetch shape.
   */
  async fetchWritingProjectFileBinaryBlob(
    projectId: string,
    fileId: string,
    options: RequestOptions = {}
  ): Promise<Blob> {
    const token = await this.context.getAccessToken();
    const url = `${this.baseUrl}/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/content`;
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const { signal, dispose, didTimeOut } = combineSignals(options.signal, this.context.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (cause) {
      dispose();
      if (isAbortError(cause)) {
        if (didTimeOut()) {
          throw new TimeoutError(
            `Fetching writing project file ${fileId} timed out after ${this.context.timeoutMs}ms`
          );
        }
        throw new RequestCancelledError(`Fetching writing project file ${fileId} was cancelled`);
      }
      throw new NetworkError(`Network request to fetch writing project file ${fileId} failed`, {
        cause,
      });
    }
    dispose();

    if (!response.ok) {
      const requestId = extractRequestId(response.headers);
      const bodyText = await safeReadText(response);
      const { detail, rawBody } = parseErrorBody(bodyText);
      throw errorFromResponse({ status: response.status, detail, requestId, rawBody });
    }

    return response.blob();
  }

  /**
   * Part 13/39 — the multi-file autosave endpoint for whichever text
   * file is currently active in the editor. Same debounced-PATCH
   * discipline as updateWritingProject's `mainTexContent` (never
   * per-keystroke).
   */
  async updateWritingProjectFileContent(
    projectId: string,
    fileId: string,
    request: UpdateWritingProjectFileContentRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'PATCH',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
      body: { content_text: request.contentText },
      signal: options.signal,
    });
    return data;
  }

  async renameWritingProjectFile(
    projectId: string,
    fileId: string,
    request: RenameWritingProjectFileRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/rename`,
      body: { name: request.name },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Part 8 — moves a file/folder within the project tree. The backend
   * rejects a folder moved into itself or one of its own descendants
   * (409/422 — see errorFromResponse's own mapping), and any name
   * collision at the destination.
   */
  async moveWritingProjectFile(
    projectId: string,
    fileId: string,
    request: MoveWritingProjectFileRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/move`,
      body: { new_parent_id: request.newParentId },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Part 9/16 — deletes a file, or a folder AND everything under it.
   * Rejects (409) if this file is (or contains) the project's current
   * root file — reassign the root first.
   */
  async deleteWritingProjectFile(
    projectId: string,
    fileId: string,
    options: RequestOptions = {}
  ): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/writing-projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
      signal: options.signal,
    });
  }

  /** Part 15 — the user chooses a different `.tex` file as the project's
   * root/main document. */
  async setWritingProjectRootFile(
    projectId: string,
    fileId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'PUT',
      path: `/writing-projects/${encodeURIComponent(projectId)}/root-file`,
      body: { file_id: fileId },
      signal: options.signal,
    });
    return data;
  }

  /**
   * Bibliography Source Detection — how this project ACTUALLY manages
   * its citations/references right now (never assumed EduM8-library
   * just because references.bib exists — see rag-backend's
   * app/core/reference_mode.py). Re-fetch after any file
   * create/rename/delete/content change that could plausibly affect a
   * project's `\bibliography{}`/`\input`/`\include` structure — same
   * "computed fresh server-side on every call" convention as
   * listWritingProjectFiles' own references.bib entry.
   */
  async getWritingProjectReferenceMode(
    projectId: string,
    options: RequestOptions = {}
  ): Promise<WritingProjectReferenceMode> {
    const { data } = await requestJson<WritingProjectReferenceMode>(this.context, {
      method: 'GET',
      path: `/writing-projects/${encodeURIComponent(projectId)}/reference-mode`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * Applies EXACTLY the substitution named by an
   * `edum8_switch_proposal` from getWritingProjectReferenceMode() —
   * never a general "switch to EduM8" action, and never called with a
   * hand-constructed find/replace the user hasn't actually been shown.
   * The backend re-verifies `find` is still present in the root file's
   * CURRENT content first (409 if the file changed since the proposal
   * was shown) and that `filePath` still names the current root file
   * (422 if it changed) — never silently applied against stale text,
   * and never deletes the old `.bib` file (it simply stops being
   * referenced).
   */
  async switchWritingProjectToEdum8References(
    projectId: string,
    request: SwitchWritingProjectToEdum8ReferencesRequest,
    options: RequestOptions = {}
  ): Promise<WritingProjectFileMutationResponse> {
    const { data } = await requestJson<WritingProjectFileMutationResponse>(this.context, {
      method: 'POST',
      path: `/writing-projects/${encodeURIComponent(projectId)}/reference-mode/switch-to-edum8`,
      body: { file_path: request.filePath, find: request.find, replace: request.replace },
      signal: options.signal,
    });
    return data;
  }

  // --- Milestone 5.4 (LaTeX Templates & Project Import) ---------------

  /**
   * GET /writing-templates — the curated template gallery. No file
   * bodies (Part 48) — cheap to call on every visit to the gallery.
   */
  async listWritingTemplates(
    options: RequestOptions = {}
  ): Promise<WritingTemplateListResponse> {
    const { data } = await requestJson<WritingTemplateListResponse>(this.context, {
      method: 'GET',
      path: '/writing-templates',
      signal: options.signal,
    });
    return data;
  }

  /** GET /writing-templates/{id} — the file tree + root document for a
   * template's "Preview" screen. */
  async getWritingTemplate(
    templateId: string,
    options: RequestOptions = {}
  ): Promise<WritingTemplateDetail> {
    const { data } = await requestJson<WritingTemplateDetail>(this.context, {
      method: 'GET',
      path: `/writing-templates/${encodeURIComponent(templateId)}`,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /writing-templates/{id}/create — clones the template's files
   * into a brand-new, completely normal WritingProject (Part 16: no
   * template-specific behavior remains after this call returns).
   */
  async createWritingProjectFromTemplate(
    templateId: string,
    request: CreateWritingProjectFromTemplateRequest,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: `/writing-templates/${encodeURIComponent(templateId)}/create`,
      body: { title: request.title, description: request.description ?? null },
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /writing-projects/import/inspect (multipart) — the ENTIRE
   * zip-bomb/zip-slip/symlink/etc. security pipeline runs before this
   * call returns; a rejected archive throws (ValidationError, 422) and
   * never creates a session. On success, present `files`/`warnings`/
   * `rootCandidates` for user review — never call
   * confirmWritingProjectImport() without that review (Part 9).
   */
  async inspectWritingProjectImport(
    file: UploadableFile,
    options: RequestOptions = {}
  ): Promise<WritingProjectImportInspection> {
    const formData = new FormData();
    appendUploadableFile(formData, 'file', file);

    const { data } = await requestMultipart<WritingProjectImportInspection>(this.context, {
      method: 'POST',
      path: '/writing-projects/import/inspect',
      formData,
      signal: options.signal,
    });
    return data;
  }

  /**
   * POST /writing-projects/import/{sessionId}/confirm — creates the
   * project atomically from a previously inspected session (Part 15: the
   * whole project is created, or nothing is). `rootPath` is required
   * whenever the inspection had multiple root candidates and none was
   * preselected; omitting it in that case rejects with a 422
   * ValidationError. Deletes the session and its staged bytes on
   * success.
   */
  async confirmWritingProjectImport(
    sessionId: string,
    request: ConfirmWritingProjectImportRequest,
    options: RequestOptions = {}
  ): Promise<WritingProject> {
    const { data } = await requestJson<WritingProject>(this.context, {
      method: 'POST',
      path: `/writing-projects/import/${encodeURIComponent(sessionId)}/confirm`,
      body: {
        title: request.title,
        description: request.description ?? null,
        root_path: request.rootPath ?? null,
      },
      signal: options.signal,
    });
    return data;
  }

  /**
   * DELETE /writing-projects/import/{sessionId} — discards a staged
   * upload without creating a project (Part 32: no unbounded
   * accumulation). Safe to call even after the session has already
   * expired/been confirmed — both cases 404, which callers should treat
   * as "already gone", not an error worth surfacing.
   */
  async cancelWritingProjectImport(sessionId: string, options: RequestOptions = {}): Promise<void> {
    await requestJson<undefined>(this.context, {
      method: 'DELETE',
      path: `/writing-projects/import/${encodeURIComponent(sessionId)}`,
      signal: options.signal,
    });
  }

  /**
   * POST /images/generate — streams real per-image progress as the
   * backend generates each image strictly sequentially (see rag-backend's
   * app/api/routes_images.py's stream_generate_images), finishing with a
   * `done` event carrying the persisted message + attachments — the exact
   * same shape as any other persisted attachment (see types/images.ts's
   * GeneratedImageAttachment), so an existing caller that already renders
   * ConversationMessageAttachment (AttachmentChip,
   * AuthenticatedAttachmentImage) needs no special case for one.
   * Deliberately plain JSON, never multipart — unlike a chat attachment,
   * nothing is being uploaded here.
   *
   * Uses DEFAULT_IMAGE_GENERATION_TIMEOUT_MS (5 minutes), not this
   * client's own (30s) timeoutMs — see that constant's docs for why a much
   * longer allowance is needed here specifically, and why it doesn't mean
   * a hung request actually waits 5 minutes. Pass `options.timeoutMs` to
   * override.
   *
   * Like any async generator, a rejection (including a `type: "error"`
   * event, which this method — unlike the SSE stream itself — turns into
   * a real thrown BackendError, mirroring streamConversationMessage's own
   * `case 'error'` handling) surfaces on the first `.next()` (e.g. the
   * first iteration of a `for await` loop), never synchronously at the
   * point this method is called.
   */
  async *streamImageGeneration(
    request: GenerateImagesRequest,
    options: RequestOptions = {}
  ): AsyncGenerator<ImageGenerationEvent, void, void> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/images/generate`;
    yield* streamImageGenerationEvents({
      url,
      token,
      body: request,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
    });
  }

  /**
   * Buffered convenience wrapper around streamImageGeneration() — see
   * chat()/postConversationMessage() for the same buffered-vs-streaming
   * tradeoff. Awaits the *entire* batch (every requested image) before
   * resolving, with no progress in between; prefer
   * streamImageGeneration() directly whenever the caller can show real
   * per-image progress (see ImageGenerationModal.tsx).
   */
  async generateImages(
    request: GenerateImagesRequest,
    options: RequestOptions = {}
  ): Promise<GenerateImagesResponse> {
    const token = await this.context.getAccessToken();
    const url = `${this.context.baseUrl}/images/generate`;
    const events = await fetchAllImageGenerationEvents({
      url,
      token,
      body: request,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
    });
    return assembleImageGenerationResult(events);
  }

  /**
   * PATCH /attachments/{id}/project — saves (or, with `projectId: null`,
   * un-saves) an attachment — in practice always a generated image — to
   * one of the caller's Projects, as a simple gallery bookmark. Never
   * ingests anything or affects RAG scope/retrieval.
   */
  async saveAttachmentToProject(
    attachmentId: string,
    projectId: string | null,
    options: RequestOptions = {}
  ): Promise<GeneratedImageAttachment> {
    const { data } = await requestJson<GeneratedImageAttachment>(this.context, {
      method: 'PATCH',
      path: `/attachments/${encodeURIComponent(attachmentId)}/project`,
      body: { project_id: projectId },
      signal: options.signal,
    });
    return data;
  }
}

/**
 * Builds the multipart/form-data body for POST /conversations/{id}/messages
 * when `request.attachments` is non-empty — see rag-backend's
 * app/api/routes_conversations.py's `_parse_multipart_message_request` for
 * the exact field names/shapes this must match: `query`/`top_k`/`filters`/
 * `client_message_id` as plain form fields (filters JSON-stringified, same
 * as the JSON body's shape), a repeated `files` field (one part per
 * attachment, in order), and a `page_ranges` field: a JSON array with one
 * entry per file — `{"start", "end"}` or null — aligned by index to `files`.
 */
function buildConversationMessageFormData(request: PostConversationMessageRequest): FormData {
  const formData = new FormData();
  formData.append('query', request.query);
  if (request.top_k !== undefined) formData.append('top_k', String(request.top_k));
  if (request.filters) formData.append('filters', JSON.stringify(request.filters));
  if (request.client_message_id !== undefined) {
    formData.append('client_message_id', request.client_message_id);
  }
  if (request.use_corpus !== undefined) {
    formData.append('use_corpus', String(request.use_corpus));
  }

  const attachments = request.attachments ?? [];
  formData.append(
    'page_ranges',
    JSON.stringify(attachments.map((attachment) => attachment.pageRange ?? null))
  );
  for (const attachment of attachments) {
    appendUploadableFile(formData, 'files', attachment.file);
  }
  return formData;
}

/**
 * Converts a vision-specific request (see sendVisionMessage()/
 * postVisionMessage()) into the general PostConversationMessageRequest
 * shape both of those delegate to. Throws a plain (synchronous)
 * TypeError if `images` is empty — see sendVisionMessage()'s docs.
 */
function visionRequestToPostRequest(
  request: SendVisionMessageRequest
): PostConversationMessageRequest {
  if (request.images.length === 0) {
    throw new TypeError('sendVisionMessage()/postVisionMessage() require at least one image.');
  }
  return {
    query: request.query,
    top_k: request.topK,
    filters: request.filters,
    client_message_id: request.clientMessageId,
    use_corpus: request.useCorpus ?? false,
    attachments: request.images.map((file) => ({ file })),
  };
}

function appendUploadableFile(formData: FormData, field: string, file: UploadableFile): void {
  if (typeof File !== 'undefined' && file instanceof File) {
    formData.append(field, file);
    return;
  }
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    formData.append(field, file);
    return;
  }
  if ('uri' in file) {
    // React Native's FormData polyfill accepts { uri, name, type } directly —
    // it is not a web Blob/File and TypeScript's DOM lib has no type for it,
    // hence the narrow, documented cast. The `'uri' in file` check (rather
    // than relying on the instanceof branches above to have excluded it) is
    // what actually narrows the type here: TS can't narrow past a
    // `typeof X !== 'undefined' && file instanceof X` guard, since skipping
    // the early return could mean either "not an X" or "X is undefined in
    // this runtime" — the guard exists precisely because RN has no global
    // File/Blob constructor to safely call instanceof against.
    formData.append(field, file as unknown as Blob, file.name);
    return;
  }
  throw new TypeError(`Unsupported file value passed for form field "${field}".`);
}

function assembleChatResult(events: ChatEvent[], clientElapsedMs: number): ChatResult {
  let answer = '';
  let sources: ChatResult['sources'] = [];
  let citations: ChatResult['citations'] = [];
  let citationWarnings: string[] = [];
  let insufficientEvidence = false;
  let writingContextSummary: ChatResult['writingContextSummary'] = null;
  let sawDone = false;

  for (const event of events) {
    switch (event.type) {
      case 'token':
        answer += event.content;
        break;
      case 'sources':
        sources = event.sources;
        break;
      case 'done':
        citations = event.citations;
        citationWarnings = event.citation_warnings;
        insufficientEvidence = event.insufficient_evidence;
        writingContextSummary = event.writing_context_summary ?? null;
        sawDone = true;
        break;
      case 'error':
        throw new BackendError(event.message);
    }
  }

  if (!sawDone) {
    throw new BackendError(
      'The /chat stream ended without a "done" event. The response may have been truncated.'
    );
  }

  return {
    answer,
    sources,
    citations,
    citationWarnings,
    insufficientEvidence,
    clientElapsedMs,
    requestId: null,
    writingContextSummary,
  };
}

function assembleImageGenerationResult(events: ImageGenerationEvent[]): GenerateImagesResponse {
  for (const event of events) {
    if (event.type === 'error') throw new BackendError(event.message);
    if (event.type === 'done') {
      return {
        message_id: event.message_id,
        conversation_id: event.conversation_id,
        images: event.images,
      };
    }
  }
  throw new BackendError(
    'The /images/generate stream ended without a "done" event. The response may have been truncated.'
  );
}
