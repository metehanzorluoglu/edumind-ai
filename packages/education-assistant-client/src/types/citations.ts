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
  | 'curriculum_document';

export type JournalQuartile = 'Q1' | 'Q2' | null;

export interface Citation {
  source_id: string;
  document_id: string;
  chunk_id: string;
  title: string | null;
  authors: string[];
  publication_year: number | null;
  source_venue: string | null;
  document_type: DocumentType;
  journal_quartile: JournalQuartile;
  page_start: number | null;
  page_end: number | null;
  doi: string | null;
  source_url: string | null;
  score: number;
}
