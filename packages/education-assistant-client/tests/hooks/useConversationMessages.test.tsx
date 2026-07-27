import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversationMessages } from '../../src/hooks/useConversationMessages';
import type { ChatEvent } from '../../src/types/chat';
import type { ConversationDetail } from '../../src/types/conversations';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';

function makeDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'c1',
    title: 'New conversation',
    title_is_custom: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    messages: [],
    ...overrides,
  };
}

async function* eventsFrom(events: ChatEvent[]): AsyncGenerator<ChatEvent, void, void> {
  for (const event of events) yield event;
}

describe('useConversationMessages', () => {
  it('loads existing history on mount', async () => {
    const getConversation = vi.fn().mockResolvedValue(
      makeDetail({
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'hi',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
            created_at: '2026-01-01T00:00:00Z',
            sources: [],
          },
        ],
      })
    );
    const client = { getConversation } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));

    await waitFor(() => expect(result.current.loadState.status).toBe('success'));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]!.content).toBe('hi');
  });

  it('reloads when conversationId changes', async () => {
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce(makeDetail({ id: 'c1', title: 'First' }))
      .mockResolvedValueOnce(makeDetail({ id: 'c2', title: 'Second' }));
    const client = { getConversation } as unknown as EducationAssistantClient;
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useConversationMessages(client, id),
      { initialProps: { id: 'c1' } }
    );

    await waitFor(() => expect(result.current.conversation?.title).toBe('First'));

    rerender({ id: 'c2' });

    await waitFor(() => expect(result.current.conversation?.title).toBe('Second'));
    expect(getConversation).toHaveBeenCalledWith('c2', expect.anything());
  });

  it('sendMessage() appends optimistic user+assistant turns and streams tokens into the assistant turn', async () => {
    const getConversation = vi.fn().mockResolvedValue(makeDetail());
    const streamConversationMessage = vi.fn(() =>
      eventsFrom([
        { type: 'token', content: 'Hel' },
        { type: 'token', content: 'lo' },
        { type: 'sources', sources: [] },
        { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false },
      ])
    );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.sendMessage({ query: 'hi there' });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0]!.role).toBe('user');
    expect(result.current.messages[0]!.content).toBe('hi there');
    expect(result.current.messages[1]!.role).toBe('assistant');

    await waitFor(() => expect(result.current.sendState.status).toBe('idle'));
    expect(result.current.messages[1]!.content).toBe('Hello');
    expect(result.current.messages[1]!.streaming).toBe(false);
  });

  it('sendMessage() surfaces a backend error event on the assistant turn', async () => {
    const getConversation = vi.fn().mockResolvedValue(makeDetail());
    const streamConversationMessage = vi.fn(() =>
      eventsFrom([{ type: 'error', message: 'model unreachable' }])
    );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.sendMessage({ query: 'hi' });
    });

    await waitFor(() => expect(result.current.sendState.status).toBe('error'));
    expect(result.current.messages[1]!.error).toBe('model unreachable');
    expect(result.current.messages[1]!.streaming).toBe(false);
  });

  it('retrying (calling sendMessage again) after an error replaces the failed turn instead of stacking a duplicate (milestone V4)', async () => {
    const getConversation = vi.fn().mockResolvedValue(makeDetail());
    const streamConversationMessage = vi
      .fn()
      .mockImplementationOnce(() => eventsFrom([{ type: 'error', message: 'model unreachable' }]))
      .mockImplementationOnce(() =>
        eventsFrom([
          { type: 'token', content: 'Hello' },
          { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false },
        ])
      );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.sendMessage({ query: 'hi' });
    });
    await waitFor(() => expect(result.current.sendState.status).toBe('error'));
    expect(result.current.messages).toHaveLength(2);

    act(() => {
      result.current.sendMessage({ query: 'hi' });
    });
    await waitFor(() => expect(result.current.sendState.status).toBe('idle'));

    // Still exactly one user+assistant pair — the failed attempt was
    // dropped, not left stacked above the successful retry.
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]!.error).toBeNull();
    expect(result.current.messages[1]!.content).toBe('Hello');
  });

  it('is a no-op while a send is already in flight', async () => {
    const getConversation = vi.fn().mockResolvedValue(makeDetail());
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const streamConversationMessage = vi.fn(() =>
      (async function* (): AsyncGenerator<ChatEvent, void, void> {
        await gate;
        yield { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false };
      })()
    );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.sendMessage({ query: 'first' });
      result.current.sendMessage({ query: 'second' });
    });

    expect(streamConversationMessage).toHaveBeenCalledTimes(1);
    releaseFirst();
    await waitFor(() => expect(result.current.sendState.status).toBe('idle'));
  });

  it('sendMessage() with attachments reloads from the backend once the send succeeds, picking up real attachment metadata', async () => {
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce(makeDetail())
      .mockResolvedValueOnce(
        makeDetail({
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'what is this?',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: '2026-01-01T00:00:00Z',
              sources: [],
              attachments: [
                {
                  id: 'a1',
                  mime: 'image/png',
                  filename: 'photo.png',
                  size_bytes: 1024,
                  page_count: null,
                  page_range_start: null,
                  page_range_end: null,
                  created_at: '2026-01-01T00:00:00Z',
                  source: 'upload',
                },
              ],
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'It is a photo.',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: '2026-01-01T00:00:01Z',
              sources: [],
            },
          ],
        })
      );
    const streamConversationMessage = vi.fn(() =>
      eventsFrom([
        { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false },
      ])
    );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.sendMessage({
        query: 'what is this?',
        attachments: [{ file: { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' } }],
      });
    });

    // Immediately after sending (before the backend round-trip resolves),
    // the optimistic user turn carries no attachment metadata yet — see
    // DisplayMessage's doc.
    expect(result.current.messages[0]!.attachments).toEqual([]);

    await waitFor(() => expect(getConversation).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current.messages.find((m) => m.role === 'user')?.attachments).toHaveLength(1)
    );
    expect(result.current.messages.find((m) => m.role === 'user')?.attachments[0]?.filename).toBe(
      'photo.png'
    );
  });

  it('sendMessage() without attachments never triggers an extra reload', async () => {
    const getConversation = vi.fn().mockResolvedValue(makeDetail());
    const streamConversationMessage = vi.fn(() =>
      eventsFrom([
        { type: 'done', citations: [], citation_warnings: [], insufficient_evidence: false },
      ])
    );
    const client = {
      getConversation,
      streamConversationMessage,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useConversationMessages(client, 'c1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));
    expect(getConversation).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.sendMessage({ query: 'hi there' });
    });

    await waitFor(() => expect(result.current.sendState.status).toBe('idle'));
    expect(getConversation).toHaveBeenCalledTimes(1);
  });
});
