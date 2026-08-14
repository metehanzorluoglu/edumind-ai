/**
 * Mirrors the backend's real enum values exactly (app/ingestion/metadata_schema.py
 * DocumentType / JournalQuartile, re-exported by education-assistant-client's
 * types). These are the ONLY values the backend accepts for filters/uploads —
 * never add an option here that isn't one of these.
 */
export const DOCUMENT_TYPES = [
  'journal_article',
  'practitioner_article',
  'policy_document',
  'report',
  'review_article',
  'curriculum_document',
] as const;

export const DOCUMENT_TYPE_LABELS: Record<(typeof DOCUMENT_TYPES)[number] | 'unknown', string> = {
  journal_article: 'Journal article',
  practitioner_article: 'Practitioner article',
  policy_document: 'Policy document',
  report: 'Report',
  review_article: 'Review article',
  curriculum_document: 'Curriculum document',
  // Frontend/Platform Milestone 3.2.1 Part C — the normal upload UI no
  // longer collects this (see documents/index.tsx), so most newly
  // uploaded documents will carry this value. Not in DOCUMENT_TYPES
  // (below) on purpose: it's the server-side default for "not
  // classified," never a choice offered in a filter/upload picker.
  unknown: 'Unclassified',
};

export const JOURNAL_QUARTILES = ['Q1', 'Q2'] as const;

/** Extensions the backend's ingestion pipeline can actually parse (app/ingestion/loaders/dispatch.py). */
export const ACCEPTED_UPLOAD_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.txt',
  '.html',
  '.htm',
  '.md',
  '.markdown',
];
