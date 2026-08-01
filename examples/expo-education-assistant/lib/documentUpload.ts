import { ACCEPTED_UPLOAD_EXTENSIONS } from './enums';

/**
 * Frontend-only guard. The backend enforces no upload size limit today
 * (see rag-backend/app/ingestion/metadata_schema.py — file_size_bytes is
 * only validated as non-negative) — this exists purely to reject an
 * obviously-doomed upload early (excessive browser memory pressure while
 * building the multipart body, or a multi-minute raw transfer) rather than
 * to mirror a real server-side cap. Ingestion itself (embedding + indexing)
 * runs as a backend background job and isn't bounded by this at all — see
 * EducationAssistantClient.uploadDocument()'s doc comment.
 */
export const MAX_UPLOAD_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Extensions the backend's ingestion pipeline can actually parse (app/ingestion/loaders/dispatch.py) — same list the picker and the web drop zone both validate against, so neither can drift from the other. */
export function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** ".pdf", ".docx", etc. — lowercased, including the dot; "" if the name has no extension. Used only for display when a MIME type isn't available (native pickers don't always report one). */
export function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

const SIZE_UNITS = ['KB', 'MB', 'GB'];

/** "512 B", "3.4 MB", "20.0 MB" — never a bare byte count once it's in the thousands, and never more than one decimal place. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${SIZE_UNITS[unitIndex]}`;
}

/**
 * Returns a readable rejection reason, or null if the candidate passes
 * every check this app can run before actually uploading. Shared by both
 * the file picker and the web drag-and-drop zone (see documents.tsx) so
 * the two can never validate differently.
 *
 * `sizeBytes: null` means "unknown" (some pickers/platforms don't report a
 * size) — this skips only the size checks, never the type check, and is
 * not itself treated as invalid.
 */
export function validateCandidateFile(name: string, sizeBytes: number | null): string | null {
  if (!hasAcceptedExtension(name)) {
    return `"${name}" is not a supported file type. Supported formats: ${ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}.`;
  }
  if (sizeBytes !== null) {
    if (sizeBytes === 0) {
      return `"${name}" is empty (0 bytes) and can't be uploaded.`;
    }
    if (sizeBytes > MAX_UPLOAD_FILE_SIZE_BYTES) {
      return `"${name}" is ${formatFileSize(sizeBytes)}, which is over the ${formatFileSize(MAX_UPLOAD_FILE_SIZE_BYTES)} limit.`;
    }
  }
  return null;
}
