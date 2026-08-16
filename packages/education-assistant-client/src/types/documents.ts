import type { DocumentType, JournalQuartile } from './citations';
import type { components } from './generated';

export type DocumentUploadResponse = components['schemas']['DocumentUploadResponse'];
export type DocumentUploadAcceptedResponse =
  components['schemas']['DocumentUploadAcceptedResponse'];
export type DocumentJobResponse = components['schemas']['DocumentJobResponse'];
export type DocumentSummary = components['schemas']['DocumentSummary'];
export type DocumentListResponse = components['schemas']['DocumentListResponse'];
export type DocumentDeleteResponse = components['schemas']['DocumentDeleteResponse'];
export type DocumentMetadataPreviewResponse =
  components['schemas']['DocumentMetadataPreviewResponse'];
export type ExtractionSource = components['schemas']['ExtractionSource'];
/**
 * Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness):
 * POST /documents/{id}/enrich's response — the outcome of one "Refresh
 * metadata" attempt (`status`/`fieldsUpdated`/`manualFieldsPreserved`)
 * plus the document's current, post-attempt state (`document`), so the
 * caller never needs a second request just to redraw the metadata panel.
 */
export type DocumentEnrichmentResponse = components['schemas']['DocumentEnrichmentResponse'];
/**
 * Every value DocumentEnrichmentResponse.status / DocumentSummary.
 * enrichmentStatus can hold. "succeeded" plus Crossref lookup failure
 * modes, plus three "never even attempted a lookup" values ("disabled",
 * "no_doi", "not_found_document") that are never persisted server-side —
 * see the backend's EnrichmentRunStatus for the authoritative source.
 */
export type EnrichmentRunStatus = components['schemas']['DocumentEnrichmentResponse']['status'];
/**
 * Milestone 4.1 §23/§24 — a non-destructive pointer at another document
 * this same user already owns, surfaced on
 * DocumentMetadataPreviewResponse.duplicateCandidate when the extracted
 * DOI exactly matches. Never blocks the upload by itself.
 */
export type DuplicateDocumentCandidate = components['schemas']['DuplicateDocumentCandidate'];

/**
 * GET /documents/{id}/citation?style=... — a deterministic, formatted
 * APA 7 / IEEE citation built from the document's current canonical
 * metadata (never a cached snapshot, never Crossref/an LLM — see the
 * backend's app/core/citation_formatting.py). `formatted` degrades
 * gracefully for incomplete records rather than erroring.
 */
export type DocumentCitationResponse = components['schemas']['DocumentCitationResponse'];
/**
 * Milestone 4.2 (Citation & BibTeX Foundation) Section 5 — the exactly-two
 * initial citation styles, derived from DocumentCitationResponse's own
 * `style` field (the backend has no separately-named CitationStyleValue
 * schema — a bare Literal used only as a query param / response field is
 * inlined by openapi-typescript rather than hoisted into
 * components['schemas']).
 */
export type CitationStyle = DocumentCitationResponse['style'];
/**
 * GET /documents/{id}/bibtex — one complete, valid BibTeX entry plus the
 * document's PERSISTED, stable `citation_key` (see
 * DocumentSummary.citationKey's own docs — same key, surfaced here too so
 * a caller that only wants BibTeX never needs a second request).
 */
export type DocumentBibtexResponse = components['schemas']['DocumentBibtexResponse'];

/** POST /documents/bibtex-export — reuses Documents' existing
 * multi-selection UI (Section 20); every id is ownership-checked
 * individually server-side. */
export interface BibtexExportRequest {
  documentIds: string[];
}
/**
 * `bibtex` is the concatenation of one valid entry per successfully
 * resolved id, in deterministic citation_key order (Section 22).
 * `skippedDocumentIds` lists any requested id that doesn't exist or isn't
 * the caller's own — reported honestly rather than silently dropped or
 * failing the whole export (Section 34).
 */
export type BibtexExportResponse = components['schemas']['BibtexExportResponse'];

/**
 * Metadata fields accepted by POST /documents (multipart form). `file` is
 * passed separately to uploadDocument() — see EducationAssistantClient.ts.
 * `authors` here is an array for ergonomics; the SDK joins it into the
 * backend's expected comma-separated string internally.
 */
export interface DocumentUploadMetadata {
  /**
   * Frontend/Platform Milestone 3.2.1 Part C — optional: the normal
   * upload UI no longer asks the caller to classify a document before
   * uploading. Omit it and the backend defaults to "unknown" (never
   * fabricating a specific category) rather than requiring one.
   */
  documentType?: DocumentType;
  journalQuartile?: JournalQuartile;
  title?: string;
  authors?: string[];
  publicationYear?: number;
  sourceVenue?: string;
  doi?: string;
  sourceUrl?: string;
  /**
   * Milestone 1 (Document Library / Folder Management): uploads directly
   * into this folder instead of root. Ignored by the backend (document
   * lands at root) when folder_library_enabled is false — see
   * useFeatureFlags().folderLibrary.
   */
  folderId?: string;
}

/** PATCH /documents/{id} — moves a document to a different folder, or to
 * root when `folderId` is null. */
export interface MoveDocumentRequest {
  folderId: string | null;
}

/**
 * Milestone 4 (Reference Library & Bibliographic Metadata Foundation):
 * PATCH /documents/{id}/metadata — the "Edit metadata" action. Partial
 * update, same convention as UpdateProjectRequest: omit a field entirely
 * to leave it unchanged; pass a field as `null` (or `[]` for a list field)
 * to explicitly clear it. Never re-uploads, re-chunks, re-embeds, or
 * touches Qdrant (SQL-only correction — see the backend's
 * UpdateDocumentMetadataRequest docstring). `title` cannot be cleared to
 * null/empty — the backend rejects that with a 422, same as
 * `documentType`. Every field sent here is recorded with "user"
 * provenance server-side (see DocumentSummary.metadataSources).
 */
export interface UpdateDocumentMetadataRequest {
  title?: string;
  authors?: string[];
  publicationYear?: number | null;
  sourceVenue?: string | null;
  doi?: string | null;
  sourceUrl?: string | null;
  documentType?: DocumentType;
  journalQuartile?: JournalQuartile;
  volume?: string | null;
  issue?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  publisher?: string | null;
  abstract?: string | null;
  keywords?: string[];
  language?: string | null;
}

export interface ListDocumentsParams {
  limit?: number;
  offset?: number;
  /**
   * Frontend/Platform Milestone 3.2.1 Part D — optional LIBRARY search
   * (title/filename substring, across every folder). Omit for the
   * ordinary unfiltered/folder-scoped list; this is NOT semantic corpus
   * retrieval (see EducationAssistantClient.search for that).
   */
  q?: string;
}

/**
 * A file to upload. React Native (Expo) has no `File`/`Blob` constructor
 * usable the way web code expects, so `expo-document-picker` /
 * `expo-image-picker` results are passed through as the
 * `{ uri, name, type }` shape RN's FormData polyfill understands natively.
 * A standard web `File`/`Blob` is also accepted so this SDK works unchanged
 * in a browser or Node 18+ test environment.
 */
export type UploadableFile = File | Blob | { uri: string; name: string; type: string };

/**
 * Frontend Milestone 3 (Document Reader): GET /documents/{id}/content —
 * see the backend's DocumentContentResponse docstring for why this is
 * EXTRACTED TEXT, not the original file (no upload is retained past the
 * synchronous parse step, anywhere in this system). `chunks` is ordered
 * by chunk_index (reading order); the reader groups consecutive chunks
 * sharing a page_number into one page section.
 */
export type DocumentContentChunk = components['schemas']['DocumentContentChunk'];
export type DocumentContentResponse = components['schemas']['DocumentContentResponse'];

/**
 * Frontend Milestone 3.1: the VISUAL half of a highlight's dual anchor —
 * one rectangle per visual line-fragment of the original PDF selection, in
 * PDF user-space points (zoom/CSS-scale invariant), NOT CSS pixels. See
 * the PDF reader's usePdfHighlightGeometry for how these are captured
 * (viewport.convertToPdfPoint) and redrawn (viewport.convertToViewportPoint)
 * at any zoom level.
 */
export type DocumentHighlightVisualAnchor = components['schemas']['HighlightVisualAnchor'];

/**
 * One saved highlight (optionally with a note) — see the backend's
 * DocumentHighlight model docstring for the dual anchor design. `chunkId`/
 * `chunkIndex` (the SEMANTIC anchor) are null for a PDF highlight whose
 * selection could not be mapped to any existing chunk — "semantic anchor
 * unavailable," never a fabricated match. `visualAnchor` (via
 * `visual_anchor`) is null for a highlight made in the extracted-text
 * reader, which has no PDF geometry.
 */
export type DocumentHighlight = components['schemas']['DocumentHighlightResponse'];
export type DocumentHighlightListResponse = components['schemas']['DocumentHighlightListResponse'];

/**
 * POST /documents/{id}/highlights. When `chunkId`/`chunkIndex` ARE given,
 * they must describe a real chunk of this document — the backend
 * validates them and rejects (422) a fabricated or mismatched anchor.
 * Frontend Milestone 3.1: both are now optional (give together or omit
 * together) — a highlight made directly on the original PDF's text layer
 * that could not be best-effort matched to any chunk still saves, as a
 * visual-only highlight, provided `visualAnchor` is given instead (a
 * highlight needs at least one real anchor).
 */
export interface CreateHighlightRequest {
  chunkId?: string | null;
  chunkIndex?: number | null;
  pageNumber: number;
  selectedText: string;
  noteText?: string | null;
  visualAnchor?: DocumentHighlightVisualAnchor | null;
}

/** PATCH /documents/{id}/highlights/{highlightId} — the note is the only
 * mutable field; `null` clears it. */
export interface UpdateHighlightRequest {
  noteText: string | null;
}

/**
 * Frontend Milestone 3.1 (Original Document Reader): what
 * EducationAssistantClient.getDocumentFileRequestInit() resolves to — the
 * absolute, authenticated URL for GET /documents/{id}/file plus the
 * Authorization header PDF.js's `getDocument({ url, httpHeaders })` needs
 * to actually fetch it (this endpoint requires auth; there is no
 * unauthenticated/public URL for an original file anywhere in this
 * system). `httpHeaders` is empty (not merely missing Authorization) if
 * the caller is currently unauthenticated — callers should treat that as
 * "cannot load," not attempt the request anyway.
 */
export interface DocumentFileRequestInit {
  url: string;
  httpHeaders: Record<string, string>;
}
