import type { components } from './generated';

/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec ("Research Notes Workspace").
 * A Notebook is a user-named collection of NotebookEntry rows — never a
 * chat/project note (see app/db/models_scopes.py's ConversationNote/
 * ProjectNote) and never an automatic RAG source (entries only ever reach
 * the model as explicit, visible "Ask EduM8" prompt context — see
 * TransientAIContext in the app's chat screen).
 */
export type Notebook = components['schemas']['NotebookResponse'];
export type NotebookListResponse = components['schemas']['NotebookListResponse'];

/**
 * One saved research artifact — either drawn from a Reader highlight
 * (`entryType: "highlight"`, with `excerpt`/`documentTitle`/anchor fields
 * populated) or written directly (`entryType: "manual"`, only `noteText`
 * populated). Every highlight-derived field is a SNAPSHOT taken at add
 * time; it never changes because the source Highlight/Document changed,
 * and it survives either being deleted (see NotebookEntry's backend
 * docstring) — `documentId` stays populated in that case, but "Open
 * source" should be treated as unavailable if the document 404s.
 */
export type NotebookEntry = components['schemas']['NotebookEntryResponse'];
export type NotebookEntryListResponse = components['schemas']['NotebookEntryListResponse'];
export type NotebookMembershipResponse = components['schemas']['NotebookMembershipResponse'];

export interface ListNotebooksParams {
  limit?: number;
  offset?: number;
}

export interface ListNotebookEntriesParams {
  limit?: number;
  offset?: number;
}

export interface CreateNotebookRequest {
  name: string;
}

export interface RenameNotebookRequest {
  name: string;
}

/** POST /notebooks/{id}/entries with entryType "highlight" — every
 * snapshot field (excerpt, anchors, document title) is derived
 * server-side from the caller's own highlight; only `noteText` is an
 * optional override (omit to snapshot the highlight's current note). */
export interface AddHighlightEntryRequest {
  entryType: 'highlight';
  documentId: string;
  highlightId: string;
  noteText?: string | null;
}

export interface AddManualEntryRequest {
  entryType: 'manual';
  noteText: string;
}

export type AddNotebookEntryRequest = AddHighlightEntryRequest | AddManualEntryRequest;

/** PATCH /notebooks/{id}/entries/{entryId} — the note is the only mutable
 * field, for both entry types (see NotebookEntry's docstring). */
export interface UpdateNotebookEntryRequest {
  noteText: string | null;
}

/**
 * M3.1 Notebook spec §18: hard cap on how many Notebook entries a single
 * "Ask EduM8" call may include — exceeding it must show a clear message
 * asking the user to reduce their selection, never a silent truncation.
 * Mirrors MAX_NOTEBOOK_AI_ENTRIES in app/schemas/notebooks.py.
 */
export const MAX_NOTEBOOK_AI_ENTRIES = 5;
