import {
  MalformedStreamError,
  NetworkError,
  RequestCancelledError,
  StreamingUnsupportedError,
  TimeoutError,
  errorFromResponse,
  extractRequestId,
} from './errors';
import { combineSignals } from './request';
import type {
  ChatDoneEvent,
  ChatErrorEvent,
  ChatEvent,
  ChatProgressEvent,
  ChatSourcesEvent,
  ChatStage,
  ChatTokenEvent,
} from '../types/chat';

export interface ParsedSseEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * A spec-compliant (WHATWG "Server-sent events") line-based SSE parser.
 * Stateful and incremental: feed() may be called with arbitrarily-sized
 * chunks (including a chunk that splits one line, or one event, across
 * multiple calls) and always returns exactly the events that are now
 * complete, buffering the rest internally.
 *
 * No deduplication is performed here, deliberately: SSE's only standard
 * duplicate-event scenario is reconnection replay via `id:`/Last-Event-ID,
 * and this SDK never reconnects (see streamChatEvents) and the backend
 * never sends `id:` fields — so there is no mechanism by which a *true*
 * duplicate event can occur in this system. Any content-based heuristic
 * (e.g. "drop a token identical to the previous one") would be actively
 * wrong, since a model can legitimately emit repeated text.
 */
export class SseStreamParser {
  private buffer = '';
  private currentEvent = '';
  private currentDataLines: string[] = [];
  private currentId: string | null = null;
  private hasPendingFields = false;

  feed(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk;
    const events: ParsedSseEvent[] = [];

    let searchFrom = 0;
    for (;;) {
      const lineBreak = this.findLineBreak(searchFrom);
      if (lineBreak === null) break;
      const line = this.buffer.slice(searchFrom, lineBreak.index);
      searchFrom = lineBreak.index + lineBreak.length;
      const dispatched = this.processLine(line);
      if (dispatched) events.push(dispatched);
    }
    this.buffer = this.buffer.slice(searchFrom);

    return events;
  }

  private findLineBreak(from: number): { index: number; length: number } | null {
    for (let i = from; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch === '\n') return { index: i, length: 1 };
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          return { index: i, length: this.buffer[i + 1] === '\n' ? 2 : 1 };
        }
        // Lone \r at the very end of the buffer — could be a bare CR line
        // ending, or the first byte of a \r\n split across chunks. Wait for
        // more data rather than guessing.
        return null;
      }
    }
    return null;
  }

  private processLine(line: string): ParsedSseEvent | null {
    if (line === '') {
      if (!this.hasPendingFields) return null;
      const event: ParsedSseEvent = {
        event: this.currentEvent || 'message',
        data: this.currentDataLines.join('\n'),
        id: this.currentId,
      };
      this.resetPending();
      return event;
    }

    if (line.startsWith(':')) return null; // comment line, per spec

    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    this.hasPendingFields = true;
    if (field === 'event') this.currentEvent = value;
    else if (field === 'data') this.currentDataLines.push(value);
    else if (field === 'id') this.currentId = value;
    // 'retry' and any other field names are recognized-but-ignored: this
    // SDK never auto-reconnects, so a server-suggested retry delay has no
    // effect here (see the "no automatic reconnection" requirement).

    return null;
  }

  private resetPending(): void {
    this.currentEvent = '';
    this.currentDataLines = [];
    this.currentId = null;
    this.hasPendingFields = false;
  }
}

const KNOWN_EVENT_TYPES = new Set(['progress', 'token', 'sources', 'done', 'error']);

// Mirrors app/schemas/chat.py's ChatStage Literal. An unrecognized stage
// value (e.g. a newer backend sending a stage this SDK build predates) is
// treated the same as an unrecognized event type: skip, don't fail the
// stream — see parseChatEvent's "unknown type => null" doc comment above.
const KNOWN_CHAT_STAGES = new Set<ChatStage>([
  'connected',
  'retrieving',
  'loading_model',
  'processing_context',
  'generating',
]);

/**
 * Parses one raw SSE event's `data:` payload (JSON) into a typed ChatEvent.
 *
 * - Invalid JSON => throws MalformedStreamError (a real protocol violation;
 *   the caller decides whether to abort or continue, but partial output
 *   already yielded is never retracted).
 * - Valid JSON but an unrecognized `type` => returns null (skip). This is
 *   deliberate forward-compatibility: a future backend event type must not
 *   crash an older SDK build.
 * - Valid JSON, known type, but missing an expected field => throws
 *   MalformedStreamError (the event claims to be e.g. "token" but doesn't
 *   have the shape a token event must have).
 */
export function parseChatEvent(raw: ParsedSseEvent): ChatEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch (cause) {
    // The message is deliberately generic — this reaches end users
    // verbatim via toAssistantError()/DisplayMessage.error (see
    // useConversationMessages.ts), and the raw stream bytes are neither
    // useful nor safe to show them (QA finding: a malformed chunk's raw
    // content was previously echoed straight into the UI). The offending
    // snippet is still available to developers via the JS `cause` chain
    // (this SDK's own error classes always preserve `cause` — see
    // EducationAssistantError), just never rendered.
    throw new MalformedStreamError('The server sent a response that could not be understood.', {
      cause: {
        reason: `SSE event data was not valid JSON: ${raw.data.slice(0, 200)}`,
        parseError: cause,
      },
    });
  }

  if (typeof payload !== 'object' || payload === null || !('type' in payload)) {
    throw new MalformedStreamError('SSE event JSON did not have a "type" field.');
  }

  const type = (payload as { type: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_EVENT_TYPES.has(type)) {
    return null; // unknown event type: skip, don't fail the whole stream
  }

  const record = payload as Record<string, unknown>;

  switch (type) {
    case 'progress': {
      if (typeof record.stage !== 'string' || !KNOWN_CHAT_STAGES.has(record.stage as ChatStage)) {
        return null; // unrecognized stage: skip, same forward-compat treatment as an unknown event type
      }
      const event: ChatProgressEvent = { type: 'progress', stage: record.stage as ChatStage };
      return event;
    }
    case 'token': {
      if (typeof record.content !== 'string') {
        throw new MalformedStreamError('SSE "token" event missing string "content" field.');
      }
      const event: ChatTokenEvent = { type: 'token', content: record.content };
      return event;
    }
    case 'sources': {
      if (!Array.isArray(record.sources)) {
        throw new MalformedStreamError('SSE "sources" event missing array "sources" field.');
      }
      const event: ChatSourcesEvent = { type: 'sources', sources: record.sources as never };
      return event;
    }
    case 'done': {
      const event: ChatDoneEvent = {
        type: 'done',
        citations: Array.isArray(record.citations) ? (record.citations as never) : [],
        citation_warnings: Array.isArray(record.citation_warnings)
          ? (record.citation_warnings as string[])
          : [],
        insufficient_evidence: record.insufficient_evidence === true,
      };
      return event;
    }
    case 'error': {
      if (typeof record.message !== 'string') {
        throw new MalformedStreamError('SSE "error" event missing string "message" field.');
      }
      const event: ChatErrorEvent = { type: 'error', message: record.message };
      return event;
    }
    default:
      return null;
  }
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

/** Cheap, synchronous pre-check — no network I/O. */
export function hasStreamingCapability(): boolean {
  return typeof fetch !== 'undefined' && typeof ReadableStream !== 'undefined';
}

/**
 * timeoutMs bounds only connection establishment (time until response
 * headers arrive), never the full generation duration: an LLM response can
 * legitimately take far longer to finish streaming than a reasonable
 * "is the backend even responding" deadline. Once headers arrive the
 * deadline is cleared and only explicit user cancellation (params.signal)
 * can still abort the read — see combineSignals in request.ts.
 */
/**
 * The path portion of a request URL, for error messages only — never the
 * full URL (which would repeat the base URL already visible to the caller
 * via ClientProvider/describeApiError) and never a hardcoded literal (this
 * helper is shared by every caller of postForSse — streamConversationMessage,
 * postConversationMessage, and the standalone chat()/search() convenience
 * methods — each hitting a different real path, so a fixed "/chat" string
 * here would mislabel every one of the others).
 */
function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Exported for imageStream.ts's own streamImageGenerationEvents/
 * fetchAllImageGenerationEvents — the request-establishment plumbing here
 * (headers, combineSignals, error classification) has nothing chat-specific
 * about it; only the *parsing* of what comes back afterward differs per
 * event-type union, which is why this is shared rather than duplicated.
 */
export async function postForSse(params: {
  url: string;
  token: string | null;
  body: unknown;
  /**
   * When present, sent instead of JSON-encoding `body` (milestone V2 chat
   * attachments) — `body` is ignored in that case. Content-Type is
   * deliberately never set here for the FormData path: fetch computes the
   * correct `multipart/form-data; boundary=...` value itself, and setting
   * it manually breaks the boundary and corrupts the request (same
   * reasoning as request.ts's requestMultipart).
   */
  formData?: FormData;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<{ response: Response; disposeSignal: () => void }> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (!params.formData) headers['Content-Type'] = 'application/json';
  if (params.token) headers.Authorization = `Bearer ${params.token}`;

  const { signal, clearDeadline, dispose, didTimeOut } = combineSignals(
    params.signal,
    params.timeoutMs
  );

  let response: Response;
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers,
      body: params.formData ?? JSON.stringify(params.body),
      signal,
    });
    clearDeadline();
  } catch (cause) {
    dispose();
    if (isAbortError(cause)) {
      if (didTimeOut()) {
        throw new TimeoutError(
          `Connecting to ${pathFromUrl(params.url)} timed out after ${params.timeoutMs}ms ` +
            'before any response was received'
        );
      }
      throw new RequestCancelledError('Chat request was cancelled');
    }
    throw new NetworkError(`Network request to ${pathFromUrl(params.url)} failed`, { cause });
  }

  if (!response.ok) {
    dispose();
    const requestId = extractRequestId(response.headers);
    let detail: string | null = null;
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = typeof parsed.detail === 'string' ? parsed.detail : null;
    } catch {
      detail = null;
    }
    throw errorFromResponse({ status: response.status, detail, requestId });
  }

  return { response, disposeSignal: dispose };
}

/**
 * True incremental streaming: requires a working ReadableStream response
 * body (response.body.getReader()). Throws StreamingUnsupportedError —
 * rather than silently falling back to buffered delivery — when the active
 * runtime can't actually deliver events incrementally, per the "do not
 * pretend that streaming works when it does not" requirement. Callers in
 * an unsupported environment should use EducationAssistantClient.chat()
 * instead, which reads the full response and never needs a stream reader.
 */
export async function* streamChatEvents(params: {
  url: string;
  token: string | null;
  body: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  timeoutMs: number;
}): AsyncGenerator<ChatEvent, void, void> {
  if (!hasStreamingCapability()) {
    throw new StreamingUnsupportedError(
      'This JavaScript runtime does not provide fetch + ReadableStream, so incremental ' +
        'streaming is unavailable. Use client.chat() instead for a buffered (non-incremental) ' +
        'result, or run this code in a runtime with streaming support (e.g. a web browser).'
    );
  }

  const { response, disposeSignal } = await postForSse(params);
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    disposeSignal();
    throw new StreamingUnsupportedError(
      'The backend response did not provide a readable stream body in this runtime (a known ' +
        'limitation on some React Native/Hermes versions even when the ReadableStream global ' +
        'exists — see this package\'s README, "Streaming support"). Use client.chat() instead.'
    );
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseStreamParser();

  try {
    for (;;) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (cause) {
        if (isAbortError(cause)) throw new RequestCancelledError('Chat stream was cancelled');
        throw cause;
      }
      if (readResult.done) break;

      // { stream: true } is essential for UTF-8 safety: a multi-byte
      // character can straddle two network chunks, and streaming mode
      // buffers the incomplete tail internally instead of emitting U+FFFD.
      const text = decoder.decode(readResult.value, { stream: true });
      for (const raw of parser.feed(text)) {
        const event = parseChatEvent(raw);
        if (event) yield event;
      }
    }
  } finally {
    disposeSignal();
    try {
      reader.releaseLock();
    } catch {
      // already released or the reader was never fully initialized — safe to ignore
    }
  }
}

/**
 * Buffered fallback: reads the entire SSE response body as text (no
 * ReadableStream required — works in any environment fetch works in),
 * then parses every event out of it at once. This is the documented
 * development fallback for runtimes where streamChatEvents() throws
 * StreamingUnsupportedError; it never delivers events incrementally.
 */
export async function fetchAllChatEvents(params: {
  url: string;
  token: string | null;
  body: unknown;
  formData?: FormData;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ChatEvent[]> {
  const { response, disposeSignal } = await postForSse(params);

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (isAbortError(cause)) throw new RequestCancelledError('Chat request was cancelled');
    throw new NetworkError(`Failed to read ${pathFromUrl(params.url)} response body`, { cause });
  } finally {
    disposeSignal();
  }

  const parser = new SseStreamParser();
  const events: ChatEvent[] = [];
  for (const raw of parser.feed(text)) {
    const event = parseChatEvent(raw);
    if (event) events.push(event);
  }
  return events;
}
