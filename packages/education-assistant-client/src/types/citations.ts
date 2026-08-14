/**
 * Mirrors app/core/citation.py's Citation model exactly (field-for-field,
 * same names). Not derivable from OpenAPI codegen — see generated.ts's
 * header comment and scripts/generate-api-types.ts for why.
 */
export type DocumentType =
  | 'journal_article'
  | 'practitioner_article'
  | 'policy_document'
  | 'report'
  | 'review_article'
  | 'curriculum_document'
  // Frontend/Platform Milestone 3.2.1 Part C — mirrors the same addition
  // to app/ingestion/metadata_schema.py's DocumentType: the normal
  // upload UI no longer asks the caller to classify a document, and the
  // backend defaults to this rather than fabricating a specific category.
  | 'unknown';

export type JournalQuartile = 'Q1' | 'Q2' | null;

/** Which kind of thing a Citation points at — see Citation.source_kind below. */
export type CitationSourceKind = 'document' | 'attachment';

export interface Citation {
  source_id: string;
  // Frontend/Platform Milestone 3.2.2 Part C — 'document' (a retrieved
  // corpus chunk, the pre-existing and by far the most common case —
  // every field below except source_id/source_kind is populated for
  // these, exactly as before) or 'attachment' (a file attached directly
  // to this message — see attachment_id/display_name below; every
  // corpus-only field, e.g. document_id/chunk_id/document_type/score, is
  // null for these, never fabricated). The backend always sends this
  // (default-filled even for messages persisted before this field
  // existed) — optional here only so the many pre-existing document-kind
  // Citation fixtures across this SDK/app's tests don't all need
  // updating; treat a missing value the same as 'document', matching the
  // backend's own default.
  source_kind?: CitationSourceKind;
  document_id: string | null;
  chunk_id: string | null;
  // source_kind: 'attachment' only — the real, persisted attachment id
  // (matches AttachmentChipInfo.key for an already-sent message), how a
  // citation is resolved to the actual file GET
  // .../attachments/{attachment_id} serves.
  attachment_id?: string | null;
  // source_kind: 'attachment' only — the attachment's filename, shown in
  // place of `title` (which stays null for these).
  display_name?: string | null;
  title: string | null;
  authors: string[];
  publication_year: number | null;
  source_venue: string | null;
  document_type: DocumentType | null;
  journal_quartile: JournalQuartile;
  page_start: number | null;
  page_end: number | null;
  doi: string | null;
  source_url: string | null;
  score: number | null;
}
