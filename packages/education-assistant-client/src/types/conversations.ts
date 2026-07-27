import type { DocumentType, JournalQuartile } from './citations';
import type { UploadableFile } from './documents';
import type { RetrievalFilters, RetrievedChunk } from './search';
import type { components } from './generated';

/** "chat" | "project" | "general" — which retrieval tier found a chunk/source (see rag-backend's app/core/scoped_retrieval.py). */
export type ScopeTierName = RetrievedChunk['scope'];

export type ConversationSummary = components['schemas']['ConversationSummaryResponse'];
export type ConversationListResponse = components['schemas']['ConversationListResponse'];
export type ConversationDetail = components['schemas']['ConversationDetailResponse'];
export type ConversationMessage = components['schemas']['MessageResponse'];
export type ConversationMessageSource = components['schemas']['MessageSourceResponse'];
/**
 * One file attached to a persisted message — never auto-ingested into the
 * RAG corpus. Any attachment routes its message to the vision model
 * instead of the text model (milestone V3 — see rag-backend's
 * app/core/model_routing.py). Never carries a filesystem path or storage
 * key (see the backend's MessageAttachmentResponse); its actual bytes are
 * fetched separately via EducationAssistantClient.fetchAttachmentBlob()/
 * getAttachmentImageSource().
 */
export type ConversationMessageAttachment = components['schemas']['MessageAttachmentResponse'];

export interface ListConversationsParams {
  limit?: number;
  offset?: number;
}

/**
 * Request shape for EducationAssistantClient.sendVisionMessage()/
 * postVisionMessage() (milestone V3) — a convenience, vision-specific
 * entry point over the same POST /conversations/{id}/messages endpoint
 * PostConversationMessageRequest already supports; `images` maps
 * 1:1 onto `attachments` (each without a pageRange) below. Use
 * PostConversationMessageRequest.attachments directly instead if a PDF
 * page range needs to be specified for one of the files.
 */
export interface SendVisionMessageRequest {
  query: string;
  /** At least one image or PDF file — sendVisionMessage()/postVisionMessage() throw synchronously if this is empty, since a vision call with nothing to look at is always a caller bug, not something to send to the backend and let it reject. */
  images: UploadableFile[];
  /** Defaults to false — see PostConversationMessageRequest.use_corpus. */
  useCorpus?: boolean;
  topK?: number;
  filters?: RetrievalFilters | null;
  clientMessageId?: string;
}

/**
 * One file to attach to an outgoing message — passed to
 * PostConversationMessageRequest.attachments below. `pageRange` only makes
 * sense for a PDF; the backend rejects it for any other attached mime type
 * (see rag-backend's AttachmentValidationError) and requires both `start`
 * and `end` together (1-indexed, inclusive) if given at all.
 */
export interface MessageAttachmentUpload {
  file: UploadableFile;
  pageRange?: { start: number; end: number };
}

export interface PostConversationMessageRequest {
  query: string;
  top_k?: number;
  filters?: RetrievalFilters | null;
  /**
   * Idempotency key for this send: mint one per logical submission attempt
   * (e.g. via `crypto.randomUUID()`-equivalent) and reuse the same value
   * across retries of that same attempt (double-click, network
   * interruption, an explicit Retry after a failed generation) — the
   * backend then returns/keeps the original user message instead of
   * inserting a duplicate (see rag-backend's
   * ConversationsRepository.add_user_message). Omit for a genuinely new
   * message.
   */
  client_message_id?: string;
  /**
   * Any non-empty array switches this request from a plain JSON body to
   * `multipart/form-data` (see EducationAssistantClient's
   * buildConversationMessageFormData) — the backend's
   * POST /conversations/{id}/messages accepts either shape on the same
   * endpoint. Never auto-ingested into the RAG corpus. Any attachment at
   * all routes this message to the vision model instead of the text
   * model (milestone V3) — see `use_corpus` below for what happens to
   * retrieval/citations in that case.
   */
  attachments?: MessageAttachmentUpload[];
  /**
   * The "Also use my research corpus" toggle (milestone V3) — only ever
   * consulted when `attachments` is non-empty: a vision-routed message
   * with this `true` also runs retrieval alongside the vision model and
   * gets real [S1]/[S2]-style citations for corpus-drawn claims; `false`
   * (the default) is vision-only, with no citations at all — an image
   * observation is never itself a citable source. A text-only message
   * (no attachments) ignores this entirely; retrieval has always run
   * unconditionally for it.
   */
  use_corpus?: boolean;
}

/**
 * Unifies the two source shapes a conversation turn can carry: a freshly
 * streamed turn's sources arrive as RetrievedChunk (full `text`, no
 * `rank`); a reloaded/persisted turn's arrive as ConversationMessageSource
 * (full `snippet_text` too — the backend stores the complete retrieved
 * chunk, not a character-capped excerpt — plus `rank`). Both convert into
 * this one shape so chat/[id].tsx renders source cards without a branch
 * per origin. Field names stay snake_case to match this SDK's wire-type
 * convention (see types/search.ts).
 */
export interface DisplaySource {
  rank: number | null;
  document_id: string | null;
  chunk_id: string;
  chunk_index: number;
  page_number: number;
  score: number;
  text: string;
  title: string | null;
  authors: string[];
  publication_year: number | null;
  source_venue: string | null;
  document_type: DocumentType;
  journal_quartile: JournalQuartile;
  doi: string | null;
  source_url: string | null;
  source_filename: string;
  scope: ScopeTierName;
}

export function displaySourceFromRetrievedChunk(chunk: RetrievedChunk): DisplaySource {
  return {
    rank: null,
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    chunk_index: chunk.chunk_index,
    page_number: chunk.page_number,
    score: chunk.score,
    text: chunk.text,
    title: chunk.title ?? null,
    authors: chunk.authors ?? [],
    publication_year: chunk.publication_year ?? null,
    source_venue: chunk.source_venue ?? null,
    document_type: chunk.document_type,
    journal_quartile: chunk.journal_quartile ?? null,
    doi: chunk.doi ?? null,
    source_url: chunk.source_url ?? null,
    source_filename: chunk.source_filename,
    scope: chunk.scope,
  };
}

export function displaySourceFromMessageSource(source: ConversationMessageSource): DisplaySource {
  return {
    rank: source.rank,
    document_id: source.document_id ?? null,
    chunk_id: source.chunk_id,
    chunk_index: source.chunk_index,
    page_number: source.page_number,
    score: source.score,
    text: source.snippet_text,
    title: source.title ?? null,
    authors: source.authors ?? [],
    publication_year: source.publication_year ?? null,
    source_venue: source.source_venue ?? null,
    document_type: source.document_type,
    journal_quartile: source.journal_quartile ?? null,
    doi: source.doi ?? null,
    source_url: source.source_url ?? null,
    source_filename: source.source_filename,
    scope: source.scope,
  };
}
