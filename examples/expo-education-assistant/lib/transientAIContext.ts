/**
 * Frontend Milestone 3.1 — M3.1 Notebook spec §19: a single, generalized
 * abstraction for "evidence the user explicitly picked, about to be asked
 * about" — used by BOTH hand-off points into chat/new.tsx:
 *   - the Reader's "Ask EduM8 from selection" (exactly ONE entry, see
 *     [id].tsx's handleAskAboutSelection)
 *   - the Notebook's multi-select "Ask EduM8" (up to
 *     MAX_TRANSIENT_AI_CONTEXT_ENTRIES entries, see the Notebook screen)
 *
 * Deliberately NOT a persistent conversation-source association (that's
 * pendingSources/pendingMode/ConversationDocument — a completely separate,
 * durable concept). A TransientAIContextEntry exists only long enough to
 * be shown to the user before they submit and then folded into that ONE
 * message's own query text via buildTransientContextPrefix — never stored
 * anywhere, never a new message field, never a new AI endpoint.
 *
 * Every entry is preserved DISTINCTLY when there's more than one — never
 * concatenated into a single blob a reader (human or model) can no longer
 * tell apart (M3.1 Notebook spec §18).
 */
export interface TransientAIContextEntry {
  sourceType: 'reader-selection' | 'notebook-entry';
  documentId: string | null;
  documentTitle: string | null;
  pageNumber: number | null;
  excerpt: string;
  userNote?: string | null;
}

/** M3.1 Notebook spec §18: hard cap on Notebook multi-select "Ask
 * EduM8" — mirrors MAX_NOTEBOOK_AI_ENTRIES in the backend schema and SDK
 * (kept as a separate literal, not an import, since this is a UI-layer
 * concern for entries that may include a Reader-selection entry too; the
 * two numbers are intentionally kept equal). */
export const MAX_TRANSIENT_AI_CONTEXT_ENTRIES = 5;

/**
 * Builds the text prepended to the user's typed question. A single entry
 * (the Reader's "Ask EduM8 from selection" case) renders as one plain
 * "Regarding this passage from..." sentence — unchanged from Frontend
 * Milestone 3's original phrasing. Two or more entries (Notebook
 * multi-select) render as clearly numbered "Evidence N" blocks, each with
 * its own Source/Excerpt/note line, so the model (and the user reviewing
 * what was sent) can never mistake one entry's excerpt or note for
 * another's.
 */
export function buildTransientContextPrefix(entries: TransientAIContextEntry[]): string {
  if (entries.length === 0) return '';

  if (entries.length === 1) {
    const entry = entries[0]!;
    const source = entry.documentTitle ? `"${entry.documentTitle}"` : 'the selected source';
    const pageSuffix = entry.pageNumber ? ` (page ${entry.pageNumber})` : '';
    return `Regarding this passage from ${source}${pageSuffix}:\n\n"${entry.excerpt}"\n\n`;
  }

  const blocks = entries.map((entry, index) => {
    const source = entry.documentTitle ?? 'Unknown source';
    const pageSuffix = entry.pageNumber ? `, page ${entry.pageNumber}` : '';
    const noteLine = entry.userNote ? `\nMy note: ${entry.userNote}` : '';
    return `Evidence ${index + 1} — Source: ${source}${pageSuffix}\nExcerpt: "${entry.excerpt}"${noteLine}`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}
