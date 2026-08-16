import type { components } from './generated';

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) — the ZIP-import
 * "upload -> inspect -> preview -> confirm/cancel" flow (Part 5/9/14).
 * Inspection always runs before anything is created (Part 9: "never
 * create a partial project from an unconfirmed upload"); the resulting
 * session is ownership-scoped and TTL-bound (Parts 31/32) — a
 * `sessionId` from inspectWritingProjectImport() is opaque and expires,
 * and confirming/cancelling it as any user other than the one who
 * uploaded it 404s identically to a nonexistent session.
 */

/** One file this import WILL include if confirmed. */
export type ImportFilePreview = components['schemas']['ImportFilePreviewResponse'];

/** One soft-excluded file or ambiguity the preview screen must surface
 * (Part 14) — e.g. an imported `references.bib` that was excluded, or
 * an unsupported extension that was skipped. Never a hard failure on
 * its own. */
export type ImportWarning = components['schemas']['ImportWarningResponse'];

/**
 * POST /writing-projects/import/inspect's response — everything the
 * "review detected files/root document" preview screen needs.
 * `preselectedRoot` is null whenever the archive had zero or MORE THAN
 * ONE `\documentclass` candidate (Part 12: "if multiple: ask user" —
 * the UI must then require an explicit root_path on confirm).
 */
export type WritingProjectImportInspection = components['schemas']['ImportInspectionResponse'];

/**
 * POST /writing-projects/import/{sessionId}/confirm. `rootPath` is
 * required whenever the inspection's `preselectedRoot` was null AND
 * `rootCandidates` has more than one entry — omitting it in that case
 * is a 422 (see EducationAssistantClient.confirmWritingProjectImport's
 * own docstring).
 */
export interface ConfirmWritingProjectImportRequest {
  title: string;
  description?: string | null;
  rootPath?: string | null;
}
