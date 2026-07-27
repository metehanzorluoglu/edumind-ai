import type { Citation } from './citations';
import type { RetrievalFilters, RetrievedChunk } from './search';

/**
 * Hand-written to mirror app/schemas/chat.py exactly. The backend's /chat
 * endpoint streams Server-Sent Events and therefore has no OpenAPI response
 * schema for these shapes (its declared "200" schema is `{}`) — see
 * generated.ts's header and scripts/generate-api-types.ts. Keep these in
 * sync by hand if app/schemas/chat.py changes.
 */
export interface ChatRequest {
  query: string;
  top_k?: number;
  filters?: RetrievalFilters | null;
}

export interface ChatTokenEvent {
  type: 'token';
  content: string;
}

export interface ChatSourcesEvent {
  type: 'sources';
  sources: RetrievedChunk[];
}

export interface ChatDoneEvent {
  type: 'done';
  citations: Citation[];
  citation_warnings: string[];
  insufficient_evidence: boolean;
}

export interface ChatErrorEvent {
  type: 'error';
  message: string;
}

export type ChatEvent = ChatTokenEvent | ChatSourcesEvent | ChatDoneEvent | ChatErrorEvent;

/**
 * Assembled client-side by streamChat()/chat() from the SSE event sequence.
 * Not a backend response type — it exists so callers who don't need
 * token-by-token streaming can await one final, structured result, by
 * aggregating the same SSE stream the streaming API already emits (no
 * retrieval/generation/citation logic is re-implemented client-side).
 *
 * `model` and a true server-side `latency` are deliberately NOT included:
 * app/core/rag_service.py's ChatPipelineResult has both, but that's the
 * *non-streaming* run() method, which has no HTTP endpoint — the actual
 * streaming /chat route's SSE events (app/schemas/chat.py) never send
 * either field. Inventing values for them here would violate this
 * project's "never fabricate" rule just as much as the backend inventing
 * a citation would. `clientElapsedMs` is provided instead: an honestly
 * different, client-measured wall-clock duration, not a substitute for
 * the backend's internal processing time.
 */
export interface ChatResult {
  answer: string;
  sources: RetrievedChunk[];
  citations: Citation[];
  citationWarnings: string[];
  insufficientEvidence: boolean;
  /** Wall-clock ms from request start to stream completion, measured client-side. */
  clientElapsedMs: number;
  requestId: string | null;
}
