import type { components } from './generated';

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) — the curated
 * template gallery. A template is a validated set of project files +
 * metadata; "Use template" clones its files into a completely normal
 * WritingProject (see backend's app/core/writing_project_creation.py)
 * — after creation there is no template-specific behavior anywhere
 * (Part 16). Deliberately a SEPARATE static registry from
 * WritingProject itself (Part 19: templates are never duplicated DB
 * project rows).
 */

/** One gallery card — GET /writing-templates. Deliberately no file
 * bodies (Part 48: the gallery must not eagerly load template file
 * content). */
export type WritingTemplateSummary = components['schemas']['WritingTemplateSummaryResponse'];
export type WritingTemplateListResponse = components['schemas']['WritingTemplateListResponse'];

/** One file listed in a template's preview — path only, never its body
 * (Part 22: "do not compile every template merely to show gallery
 * cards"). */
export type WritingTemplateFile = components['schemas']['WritingTemplateFileResponse'];

/** GET /writing-templates/{id} — includes the file tree (paths only)
 * and root document for the "Preview" affordance. */
export type WritingTemplateDetail = components['schemas']['WritingTemplateDetailResponse'];

/** POST /writing-templates/{id}/create — same required-title/optional-
 * description shape as CreateWritingProjectRequest (types/writing.ts);
 * a distinct type only because it's a conceptually different action
 * (cloning a template, not starting blank). */
export interface CreateWritingProjectFromTemplateRequest {
  title: string;
  description?: string | null;
}
