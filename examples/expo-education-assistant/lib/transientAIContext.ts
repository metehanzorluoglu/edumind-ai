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
  /**
   * Milestone 5.2 Part 3 — 'manuscript-selection' is a THIRD hand-off
   * point into this same generalized mechanism: the Writing editor's own
   * "Ask EduM8" action on a text selection. Deliberately distinct from
   * 'reader-selection' (which always has a real documentId/documentTitle
   * — an existing library document) — a manuscript selection is the
   * user's own in-progress draft prose, which must never be worded as if
   * it came from a library source (see buildTransientContextPrefix's
   * dedicated phrasing below). `documentId`/`documentTitle`/`pageNumber`
   * are always null for this sourceType; `excerpt` is the selected
   * manuscript text verbatim.
   */
  sourceType: 'reader-selection' | 'notebook-entry' | 'manuscript-selection';
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
 * A minimal structural shape of NotebookEntry — declared locally (rather
 * than importing the real type from education-assistant-client) so this
 * plain-lib file never depends on the SDK package, matching every other
 * function in this module. Every real NotebookEntry satisfies this.
 */
export interface NotebookEntryLike {
  entry_type: string;
  document_id?: string | null;
  document_title?: string | null;
  page_number?: number | null;
  excerpt?: string | null;
  note_text?: string | null;
}

/**
 * Milestone 5.2 Part 4C / Part 10 — the single canonical mapping from a
 * NotebookEntry to this module's TransientAIContextEntry shape. Originally
 * lived only in notes/[id].tsx (the Notebook's own multi-select "Ask
 * EduM8"); extracted here so Milestone 5.2's Writing "Research Notes"
 * scope (see lib/useWritingAsk.ts) reuses the EXACT same excerpt/note
 * mapping rather than a second, possibly-diverging copy of this logic.
 */
export function transientEntryFromNotebookEntry(entry: NotebookEntryLike): TransientAIContextEntry {
  const isManual = entry.entry_type === 'manual';
  return {
    sourceType: 'notebook-entry',
    documentId: isManual ? null : (entry.document_id ?? null),
    documentTitle: isManual ? null : (entry.document_title ?? null),
    pageNumber: isManual ? null : (entry.page_number ?? null),
    excerpt: isManual ? (entry.note_text ?? '') : (entry.excerpt ?? ''),
    userNote: isManual ? null : entry.note_text,
  };
}

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
    if (entry.sourceType === 'manuscript-selection') {
      // Never worded as if this were a library source — it's the
      // researcher's own draft prose (Part 3: "the selected manuscript
      // text should be passed as contextual text, NOT inserted into the
      // vector database" — and never mislabeled as one either).
      return `Regarding this passage from my manuscript:\n\n"${entry.excerpt}"\n\n`;
    }
    const source = entry.documentTitle ? `"${entry.documentTitle}"` : 'the selected source';
    const pageSuffix = entry.pageNumber ? ` (page ${entry.pageNumber})` : '';
    return `Regarding this passage from ${source}${pageSuffix}:\n\n"${entry.excerpt}"\n\n`;
  }

  const blocks = entries.map((entry, index) => {
    const source =
      entry.sourceType === 'manuscript-selection'
        ? 'My manuscript'
        : (entry.documentTitle ?? 'Unknown source');
    const pageSuffix = entry.pageNumber ? `, page ${entry.pageNumber}` : '';
    const noteLine = entry.userNote ? `\nMy note: ${entry.userNote}` : '';
    return `Evidence ${index + 1} — Source: ${source}${pageSuffix}\nExcerpt: "${entry.excerpt}"${noteLine}`;
  });
  return `${blocks.join('\n\n')}\n\n`;
}
