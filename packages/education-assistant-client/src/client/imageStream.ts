import {
  MalformedStreamError,
  NetworkError,
  RequestCancelledError,
  StreamingUnsupportedError,
} from './errors';
import { SseStreamParser, hasStreamingCapability, postForSse, type ParsedSseEvent } from './stream';
import type { ImageGenerationEvent } from '../types/images';

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

const KNOWN_IMAGE_EVENT_TYPES = new Set(['progress', 'done', 'error']);

/**
 * Parses one raw SSE event's `data:` payload (JSON) into a typed
 * ImageGenerationEvent — same conventions as stream.ts's parseChatEvent:
 * invalid JSON or a known type missing its required fields throws
 * MalformedStreamError; an unrecognized `type` returns null (forward
 * compatibility, never crashes an older SDK build).
 */
export function parseImageGenerationEvent(raw: ParsedSseEvent): ImageGenerationEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch (cause) {
    throw new MalformedStreamError(`SSE event data was not valid JSON: ${raw.data.slice(0, 200)}`, {
      cause,
    });
  }

  if (typeof payload !== 'object' || payload === null || !('type' in payload)) {
    throw new MalformedStreamError('SSE event JSON did not have a "type" field.');
  }

  const type = (payload as { type: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_IMAGE_EVENT_TYPES.has(type)) {
    return null;
  }

  const record = payload as Record<string, unknown>;

  switch (type) {
    case 'progress': {
      if (typeof record.completed !== 'number' || typeof record.total !== 'number') {
        throw new MalformedStreamError(
          'SSE "progress" event missing numeric "completed"/"total" fields.'
        );
      }
      return { type: 'progress', completed: record.completed, total: record.total };
    }
    case 'done': {
      if (
        typeof record.message_id !== 'string' ||
        typeof record.conversation_id !== 'string' ||
        !Array.isArray(record.images)
      ) {
        throw new MalformedStreamError('SSE "done" event missing required fields.');
      }
      return {
        type: 'done',
        message_id: record.message_id,
        conversation_id: record.conversation_id,
        images: record.images as never,
      };
    }
    case 'error': {
      if (typeof record.message !== 'string') {
        throw new MalformedStreamError('SSE "error" event missing string "message" field.');
      }
      return { type: 'error', message: record.message };
    }
    default:
      return null;
  }
}

/**
 * True incremental streaming — see stream.ts's streamChatEvents for the
 * identical shape/reasoning (same StreamingUnsupportedError contract, same
 * "never pretend streaming works when it does not" rule). Callers in an
 * unsupported runtime should use fetchAllImageGenerationEvents instead
 * (buffered — no incremental progress).
 */
export async function* streamImageGenerationEvents(params: {
  url: string;
  token: string | null;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
}): AsyncGenerator<ImageGenerationEvent, void, void> {
  if (!hasStreamingCapability()) {
    throw new StreamingUnsupportedError(
      'This JavaScript runtime does not provide fetch + ReadableStream, so incremental image ' +
        'generation progress is unavailable. Use EducationAssistantClient.generateImages() ' +
        'instead for a buffered (non-incremental) result.'
    );
  }

  const { response, disposeSignal } = await postForSse(params);
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    disposeSignal();
    throw new StreamingUnsupportedError(
      'The backend response did not provide a readable stream body in this runtime (a known ' +
        'limitation on some React Native/Hermes versions even when the ReadableStream global ' +
        'exists). Use EducationAssistantClient.generateImages() instead.'
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
        if (isAbortError(cause)) throw new RequestCancelledError('Image generation was cancelled');
        throw cause;
      }
      if (readResult.done) break;

      const text = decoder.decode(readResult.value, { stream: true });
      for (const raw of parser.feed(text)) {
        const event = parseImageGenerationEvent(raw);
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
 * Buffered fallback — see stream.ts's fetchAllChatEvents for the identical
 * shape/reasoning. Never delivers progress incrementally; a caller in an
 * environment where streamImageGenerationEvents throws
 * StreamingUnsupportedError should use this instead and show an
 * indeterminate loading state for the whole duration.
 */
export async function fetchAllImageGenerationEvents(params: {
  url: string;
  token: string | null;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ImageGenerationEvent[]> {
  const { response, disposeSignal } = await postForSse(params);

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (isAbortError(cause)) throw new RequestCancelledError('Image generation was cancelled');
    throw new NetworkError('Failed to read image-generation response body', { cause });
  } finally {
    disposeSignal();
  }

  const parser = new SseStreamParser();
  const events: ImageGenerationEvent[] = [];
  for (const raw of parser.feed(text)) {
    const event = parseImageGenerationEvent(raw);
    if (event) events.push(event);
  }
  return events;
}
