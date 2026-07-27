/**
 * Mirrors rag-backend's vision config defaults purely to compute a
 * client-side, best-effort "only the first N pages will be analyzed"
 * notice for an oversized PDF — the backend's actual configured values
 * (VISION_MAX_PDF_PAGES / VISION_MAX_IMAGES_PER_MESSAGE) are always the
 * authoritative limit; this app cannot read them at runtime today (no
 * status endpoint exposes them), so this constant may drift from a
 * backend whose operator changed either setting. Same "mirror the
 * default as a guardrail, not a source of truth" pattern already used by
 * chatAttachments.ts's MAX_ATTACHMENT_FILE_SIZE_BYTES.
 */
const VISION_MAX_PDF_PAGES = 10;

/**
 * See rag-backend's app/services/vision_service.py's
 * render_attachments_to_images: when no page range is chosen (always true
 * for this app's UI), the number of pages actually analyzed is capped at
 * `min(VISION_MAX_PDF_PAGES, VISION_MAX_IMAGES_PER_MESSAGE)` — the second
 * limit exists so a large PDF is gracefully truncated rather than the
 * request being rejected outright for exceeding the image-count limit.
 * With this app's defaults (10 and 4), the effective cap is 4, not 10.
 */
const VISION_MAX_IMAGES_PER_MESSAGE = 4;

/** The number of pages of a PDF this app's default backend configuration actually analyzes when no page range is given (always the case here). */
export const EFFECTIVE_PDF_PAGE_LIMIT = Math.min(VISION_MAX_PDF_PAGES, VISION_MAX_IMAGES_PER_MESSAGE);

/**
 * A user-facing notice for a PDF whose real (backend-reported) page count
 * exceeds what will actually be analyzed, or null if the whole document
 * fits under the limit. `pageCount` is only ever known once the backend
 * has validated/persisted the attachment (see AttachmentChipInfo's docs);
 * there is nothing to show before that.
 */
export function pdfPageLimitNotice(pageCount: number | null): string | null {
  if (pageCount === null || pageCount <= EFFECTIVE_PDF_PAGE_LIMIT) return null;
  return `This PDF has ${pageCount} pages. Only the first ${EFFECTIVE_PDF_PAGE_LIMIT} pages will be analyzed.`;
}
