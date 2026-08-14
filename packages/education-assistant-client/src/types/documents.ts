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
