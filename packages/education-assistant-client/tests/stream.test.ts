import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SseStreamParser,
  fetchAllChatEvents,
  hasStreamingCapability,
  parseChatEvent,
  streamChatEvents,
} from '../src/client/stream';
import { MalformedStreamError, NetworkError } from '../src/client/errors';

describe('SseStreamParser', () => {
  it('parses a single complete event with a data field', () => {
    const parser = new SseStreamParser();
    const events = parser.feed('event: token\ndata: {"type":"token","content":"hi"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'token',
      data: '{"type":"token","content":"hi"}',
      id: null,
    });
  });

  it('buffers a partial line split across two feed() calls', () => {
    const parser = new SseStreamParser();
    expect(parser.feed('data: {"type":"to')).toHaveLength(0);
    const events = parser.feed('ken","content":"x"}\n\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual({ type: 'token', content: 'x' });
  });

  it('parses multiple events delivered in a single chunk', () => {
    const parser = new SseStreamParser();
    const events = parser.feed(
      'data: {"type":"token","content":"a"}\n\ndata: {"type":"token","content":"b"}\n\n'
    );
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.data).content).toBe('a');
    expect(JSON.parse(events[1]!.data).content).toBe('b');
  });

  it('reassembles one event whose fields are split across several chunks', () => {
    const parser = new SseStreamParser();
    expect(parser.feed('data: {"typ')).toHaveLength(0);
    expect(parser.feed('e":"tok')).toHaveLength(0);
    expect(parser.feed('en","content":"x"}')).toHaveLength(0);
    const events = parser.feed('\n\n');
    expect(events).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseStreamParser();
    const events = parser.feed('data: {"type":"token","content":"crlf"}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data).content).toBe('crlf');
  });

  it('handles a CRLF pair split exactly across two chunks', () => {
    const parser = new SseStreamParser();
    expect(parser.feed('data: {"type":"token","content":"x"}\r')).toHaveLength(0);
    const events = parser.feed('\n\r\n');
    expect(events).toHaveLength(1);
  });

  it('joins multiline data fields with \\n per the SSE spec', () => {
    const parser = new SseStreamParser();
    const events = parser.feed('data: line one\ndata: line two\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('line one\nline two');
  });

  it('ignores comment lines starting with ":"', () => {
    const parser = new SseStreamParser();
    const events = parser.feed(':heartbeat\ndata: {"type":"token","content":"x"}\n\n');
    expect(events).toHaveLength(1);
  });

  it('discards an incomplete trailing event with no data emitted yet', () => {
    const parser = new SseStreamParser();
    const events = parser.feed('data: {"type":"token","content":"x"}');
    expect(events).toHaveLength(0);
  });
});

describe('parseChatEvent', () => {
  it('throws MalformedStreamError on invalid JSON', () => {
    expect(() => parseChatEvent({ event: 'message', data: 'not json', id: null })).toThrow(
      MalformedStreamError
    );
  });

  it('returns null for an unrecognized event type instead of throwing', () => {
    const result = parseChatEvent({ event: 'message', data: '{"type":"heartbeat"}', id: null });
    expect(result).toBeNull();
  });

  it('throws MalformedStreamError when a "token" event lacks content', () => {
    expect(() => parseChatEvent({ event: 'message', data: '{"type":"token"}', id: null })).toThrow(
      MalformedStreamError
    );
  });

  it('does not deduplicate two consecutive identical token events', () => {
    const parser = new SseStreamParser();
    const events = parser.feed(
      'data: {"type":"token","content":"no"}\n\ndata: {"type":"token","content":"no"}\n\n'
    );
    const parsed = events.map((raw) => parseChatEvent(raw));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ type: 'token', content: 'no' });
    expect(parsed[1]).toEqual({ type: 'token', content: 'no' });
  });

  it('parses a well-formed "progress" event', () => {
    const result = parseChatEvent({
      event: 'message',
      data: '{"type":"progress","stage":"loading_model"}',
      id: null,
    });
    expect(result).toEqual({ type: 'progress', stage: 'loading_model' });
  });

  it('parses every known ChatStage value', () => {
    const stages = ['connected', 'retrieving', 'loading_model', 'processing_context', 'generating'];
    for (const stage of stages) {
      const result = parseChatEvent({
        event: 'message',
        data: JSON.stringify({ type: 'progress', stage }),
        id: null,
      });
      expect(result).toEqual({ type: 'progress', stage });
    }
  });

  it('skips a "progress" event with an unrecognized stage instead of throwing', () => {
    // Forward-compatibility: a newer backend build might send a stage this
    // SDK build predates — same "unknown => skip" treatment as an unknown
    // event type entirely, not a hard failure.
    const result = parseChatEvent({
      event: 'message',
      data: '{"type":"progress","stage":"some_future_stage"}',
      id: null,
    });
    expect(result).toBeNull();
  });

  it('skips a "progress" event missing the stage field', () => {
    const result = parseChatEvent({ event: 'message', data: '{"type":"progress"}', id: null });
    expect(result).toBeNull();
  });

  it('parses a well-formed "done" event, defaulting missing arrays safely', () => {
    const result = parseChatEvent({
      event: 'message',
      data: '{"type":"done","insufficient_evidence":true}',
      id: null,
    });
    expect(result).toEqual({
      type: 'done',
      citations: [],
      citation_warnings: [],
      insufficient_evidence: true,
    });
  });
});

describe('hasStreamingCapability', () => {
  const originalReadableStream = globalThis.ReadableStream;

  afterEach(() => {
    globalThis.ReadableStream = originalReadableStream;
  });

  it('returns true when fetch and ReadableStream are both present', () => {
    expect(hasStreamingCapability()).toBe(true);
  });

  it('returns false when ReadableStream is unavailable', () => {
    // @ts-expect-error deliberately simulating a runtime without ReadableStream
    delete globalThis.ReadableStream;
    expect(hasStreamingCapability()).toBe(false);
  });
});

// Regression coverage: a real fetch() failure used to always say "Network
// request to /chat failed" regardless of which endpoint was actually being
// called — streamConversationMessage/postConversationMessage both hit
// /conversations/{id}/messages, never literally /chat, so that hardcoded
// string actively misled debugging (see this session's browser-connectivity
// fix). The message must now name the real path from the request URL.
describe('postForSse network-error messages name the real request path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streamChatEvents names the actual conversation-messages path, not /chat', async () => {
    const iterator = streamChatEvents({
      url: 'http://127.0.0.1:8000/conversations/abc-123/messages',
      token: null,
      body: { query: 'hello' },
      timeoutMs: 5000,
    });

    await expect(iterator.next()).rejects.toMatchObject({
      constructor: NetworkError,
      message: 'Network request to /conversations/abc-123/messages failed',
    });
  });

  it('fetchAllChatEvents names the actual conversation-messages path, not /chat', async () => {
    await expect(
      fetchAllChatEvents({
        url: 'http://127.0.0.1:8000/conversations/abc-123/messages',
        token: null,
        body: { query: 'hello' },
        timeoutMs: 5000,
      })
    ).rejects.toMatchObject({
      constructor: NetworkError,
      message: 'Network request to /conversations/abc-123/messages failed',
    });
  });
});
