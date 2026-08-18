import type { components } from './generated';

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) — a LaTeX writing
 * project: one manuscript source plus its associated library references.
 * Deliberately a separate concept from Project/ProjectSummary
 * (types/projects.ts), which groups a user's CHAT CONVERSATIONS — see the
 * backend's app/db/models_writing.py docstring for the full reasoning.
 */
export type WritingProjectSummary = components['schemas']['WritingProjectSummaryResponse'];
export type WritingProjectListResponse = components['schemas']['WritingProjectListResponse'];
/**
 * The full project, including its LaTeX source — returned by
 * create/get/update only, never by the list endpoint (see
 * WritingProjectSummary — listing many projects must not transfer every
 * manuscript's full source just to render a summary card).
 */
export type WritingProject = components['schemas']['WritingProjectResponse'];

export interface CreateWritingProjectRequest {
  title: string;
  description?: string | null;
}

/**
 * Partial update — omit a field entirely to leave it unchanged (matches
 * the backend's PATCH /writing-projects/{id}, which only touches a field
 * actually present in the JSON body). `title` can never be cleared to
 * null. `mainTexContent` is what the editor's autosave PATCHes on a
 * debounced interval, never per keystroke.
 */
export interface UpdateWritingProjectRequest {
  title?: string;
  description?: string | null;
  mainTexContent?: string;
}

/**
 * One project reference — the associated document's own CURRENT
 * canonical bibliographic metadata (never a copied/frozen snapshot — see
 * the backend's WritingProjectReferenceResponse docstring). `cited`
 * reflects whether this document's citation key currently appears
 * anywhere in the project's main_tex_content, computed fresh on every
 * request.
 */
export type WritingProjectReference = components['schemas']['WritingProjectReferenceResponse'];
export type WritingProjectReferencesResponse =
  components['schemas']['WritingProjectReferencesResponse'];

/** Every outcome POST /writing-projects/{id}/references can report for
 * one document_id — never a hard failure for any of these ordinary
 * cases. */
export type AddWritingProjectReferenceOutcome =
  components['schemas']['AddWritingProjectReferenceResult']['outcome'];
export type AddWritingProjectReferenceResult =
  components['schemas']['AddWritingProjectReferenceResult'];
export type AddWritingProjectReferencesResponse =
  components['schemas']['AddWritingProjectReferencesResponse'];

/**
 * GET /writing-projects/{id}/bibliography — generated fresh, on demand,
 * from the project's current references via the exact same Milestone 4.2
 * BibTeX engine every other BibTeX surface uses. Never a second,
 * independently-maintained bibliography store.
 */
export type WritingProjectBibliography = components['schemas']['WritingProjectBibliographyResponse'];

/**
 * Milestone 5.1 (Secure LaTeX Compilation Service) — the structured
 * result of POST /writing-projects/{id}/compile. `status` covers both
 * genuine compile outcomes ("success" | "error" | "timeout") and the
 * backend's own honest "couldn't even try" outcomes ("busy" — the
 * compiler's bounded queue was full; "unavailable" — the compiler
 * service itself couldn't be reached) — never a raw HTTP error for any
 * of these, so the UI can render one consistent inline result.
 */
export type CompileStatus = 'success' | 'error' | 'timeout' | 'busy' | 'unavailable';
export type CompileDiagnostic = components['schemas']['CompileDiagnosticResponse'];
export type CompileWritingProjectResponse =
  components['schemas']['CompileWritingProjectResponse'];

/**
 * Milestone 5.3 (LaTeX Project Workspace & File Management) — one real
 * (database-backed) file or folder in a Writing Project's tree.
 * `references.bib` is NEVER represented here (see GeneratedFileNode
 * below) — it has no `id` and no mutation actions apply to it.
 */
export type WritingProjectFileNode = components['schemas']['WritingProjectFileNodeResponse'];
export type WritingProjectFileKind = WritingProjectFileNode['kind'];

/**
 * The synthesized, read-only `references.bib` tree entry — regenerated
 * fresh from the project's current references on every
 * GET /writing-projects/{id}/files call, never a real file row (Part 3:
 * "references.bib remains canonical... never a second source of
 * truth").
 */
export type GeneratedFileNode = components['schemas']['GeneratedFileNodeResponse'];

export type WritingProjectFileTree = components['schemas']['WritingProjectFileTreeResponse'];

/** GET /writing-projects/{id}/files/{fileId} — text files include their
 * content inline (`contentText`); binary files' bytes are fetched
 * separately via fetchWritingProjectFileContentBlob. */
export type WritingProjectFileContent =
  components['schemas']['WritingProjectFileContentResponse'];

/**
 * Bibliography Source Detection — how a Writing Project ACTUALLY
 * manages its citations/references, detected server-side from real
 * project content (see rag-backend's app/core/reference_mode.py) rather
 * than assumed from EduM8's own `references.bib` merely existing (it
 * always does, as a virtual/generated file — see GeneratedFileNode
 * above). One of:
 *
 * - "edum8_library" — EduM8's own generated references.bib.
 * - "imported_bib" — a real imported `.bib` database, e.g. a Springer
 *   Nature template's own "sn-bibliography.bib".
 * - "template_tex" — a template `.tex` file (e.g. "Bibliography.tex")
 *   with a manual `\begin{thebibliography}`/`\bibitem{...}` block.
 * - "inline_template" — the same, but directly inside the root/source
 *   `.tex` rather than a separate included file.
 */
export type ReferenceMode = components['schemas']['ReferenceModeResponse']['mode'];
export type CitationKeySource = components['schemas']['ReferenceModeResponse']['citation_key_source'];
export type ReferenceKey = components['schemas']['ReferenceKeyResponse'];
export type Edum8SwitchProposal = components['schemas']['Edum8SwitchProposalResponse'];
export type WritingProjectReferenceMode = components['schemas']['ReferenceModeResponse'];

export interface SwitchWritingProjectToEdum8ReferencesRequest {
  filePath: string;
  find: string;
  replace: string;
}

export interface CreateWritingProjectFolderRequest {
  parentId?: string | null;
  name: string;
}

export interface CreateWritingProjectTextFileRequest {
  parentId?: string | null;
  name: string;
  contentText?: string;
}

/**
 * Milestone 5.3 Part 39 — the multi-file autosave PATCH body. One
 * request, one file's content — never a batch update (keeps the
 * "flush current file before switching" discipline simple and matches
 * the existing PATCH /writing-projects/{id} main_tex_content
 * convention exactly).
 */
export interface UpdateWritingProjectFileContentRequest {
  contentText: string;
}

export interface RenameWritingProjectFileRequest {
  name: string;
}

export interface MoveWritingProjectFileRequest {
  /** null moves the file/folder to the project root. */
  newParentId: string | null;
}

export type WritingProjectFileMutationResponse =
  components['schemas']['WritingProjectFileMutationResponse'];
