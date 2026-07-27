import type { DocumentType, JournalQuartile } from './citations';
import type { components } from './generated';

export type DocumentUploadResponse = components['schemas']['DocumentUploadResponse'];
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
  documentType: DocumentType;
  journalQuartile?: JournalQuartile;
  title?: string;
  authors?: string[];
  publicationYear?: number;
  sourceVenue?: string;
  doi?: string;
  sourceUrl?: string;
}

export interface ListDocumentsParams {
  limit?: number;
  offset?: number;
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
