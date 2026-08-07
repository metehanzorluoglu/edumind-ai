import { test, expect } from '@playwright/test';
import { gotoNewChat, login, TEST_EMAIL, TEST_PASSWORD } from './helpers';

/**
 * Regression coverage for QA finding BUG-1: a dropped connection during
 * generation (observed in production as net::ERR_QUIC_PROTOCOL_ERROR)
 * must never strand the user or lose an answer the backend actually
 * finished computing.
 *
 * These tests mock the network layer to deterministically simulate a
 * mid-stream disconnect and a since-recovered backend, rather than
 * waiting on real multi-minute CPU-only generation — that keeps this
 * suite fast and reliable while still exercising the real frontend code
 * path (app/(tabs)/chat/new.tsx's navigate-on-transport-error change,
 * and chat/[id].tsx's resume-polling via useConversationMessages). The
 * real, unmocked, backend-and-all version of this same scenario is
 * covered by the mandatory production E2E verification, not here.
 */
test.describe('stream-disconnect recovery (mocked network)', () => {
  test('a connection drop mid-stream navigates to the conversation instead of stranding the user on a dead-end error', async ({
    page,
  }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());

    const conversationId = 'e2e-mock-conversation-recovery';
    let pollCount = 0;

    await page.route('**/conversations', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: conversationId,
            title: 'New conversation',
            title_is_custom: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            messages: [],
          }),
        });
      }
      return route.continue();
    });

    // The message-send stream itself: simulate a transport failure right
    // after the connection opens (mirrors the production QUIC failure —
    // Playwright's route.abort() is the closest equivalent to a real
    // mid-flight connection loss available from the network-mocking API).
    await page.route(`**/conversations/${conversationId}/messages`, async (route) => {
      await route.abort('connectionreset');
    });

    // Once the frontend navigates away from /chat/new and GET-polls the
    // conversation (see useConversationMessages' resume-polling effect),
    // serve a 'generating' row for the first poll and a 'complete' one
    // after that — simulating the backend's own worker (see
    // rag-backend's app/core/generation_manager.py) finishing the
    // answer shortly after the client's connection dropped.
    await page.route(`**/conversations/${conversationId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      pollCount++;
      const generating = pollCount < 2;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: conversationId,
          title: 'Recovered conversation',
          title_is_custom: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: 'user-msg-1',
              role: 'user',
              content: 'Mocked question for stream-recovery test',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: new Date().toISOString(),
              sources: [],
              attachments: [],
              status: 'complete',
              error_message: null,
            },
            {
              id: 'assistant-msg-1',
              role: 'assistant',
              content: generating ? '' : 'The recovered answer, persisted despite the disconnect.',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: new Date().toISOString(),
              sources: [],
              attachments: [],
              status: generating ? 'generating' : 'complete',
              error_message: null,
            },
          ],
        }),
      });
    });

    await gotoNewChat(page);
    await page.locator('[placeholder^="Ask"]').fill('Mocked question for stream-recovery test');
    await page.getByText('Ask', { exact: true }).click();

    // The core BUG-1 regression assertion: the user must land on the real
    // conversation URL, never stuck on /chat/new with a dead-end error box.
    await page.waitForURL((u) => u.pathname.includes(conversationId), { timeout: 15_000 });

    // And, once the mocked backend's poll reports 'complete', the answer
    // must actually render — no permanent spinner.
    await expect(
      page.locator('text=The recovered answer, persisted despite the disconnect.')
    ).toBeVisible({ timeout: 15_000 });
  });

  test('a message stuck in "generating" from a previous session shows a resuming banner with a working Cancel action', async ({
    page,
  }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());

    const conversationId = 'e2e-mock-conversation-resuming';
    let cancelCalled = false;

    await page.route(`**/conversations/${conversationId}/messages/*/cancel`, async (route) => {
      cancelCalled = true;
      return route.fulfill({ status: 202 });
    });
    await page.route(`**/conversations/${conversationId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: conversationId,
          title: 'Still generating',
          title_is_custom: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          messages: [
            {
              id: 'user-msg-1',
              role: 'user',
              content: 'A question left generating by a previous session',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: new Date().toISOString(),
              sources: [],
              attachments: [],
              status: 'complete',
              error_message: null,
            },
            {
              id: 'assistant-msg-resuming',
              role: 'assistant',
              content: '',
              citations: [],
              citation_warnings: [],
              insufficient_evidence: false,
              created_at: new Date().toISOString(),
              sources: [],
              attachments: [],
              status: 'generating',
              error_message: null,
            },
          ],
        }),
      });
    });

    await page.goto(`/chat/${conversationId}`, { waitUntil: 'load' });
    await expect(page.locator('text=Picking up a response that was still being generated')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByText('Cancel', { exact: true }).click();
    await page.waitForTimeout(300);
    expect(cancelCalled).toBe(true);
  });

  /**
   * Bounding-box regression for the "chat canvas visibly shrinks while the
   * recovery banner is showing" bug: the message column (turnWrap) and the
   * composer must render at the *identical* x-position and width whether
   * or not the resuming-generation banner is present — jest/
   * react-test-renderer (see [id].test.tsx's own style-prop tests) cannot
   * catch this class of bug at all, since it never runs a real flexbox
   * layout; only a real browser can. The banner's own height is the one,
   * deliberate exception (see `heightDelta` below).
   *
   * Root cause this guards against: `listContent`'s old `alignItems:
   * 'center'` stopped FlatList's per-row wrapper from stretching to the
   * list's own width, which left turnWrap's `width: '100%'` resolving
   * against an indeterminate (content-fitted) parent instead of a fixed
   * one — so turnWrap's rendered width silently tracked whatever was
   * inside it (a full answer vs. an empty/compact thinking placeholder)
   * rather than staying a stable reading-column width. Fixed by moving
   * the centering onto turnWrap itself (`alignSelf: 'center'`) and letting
   * `listContent` stretch (the same technique ChatComposer's own `inner`
   * style already used successfully).
   */
  test('the message column and composer render at identical position/width whether or not the recovery banner is showing', async ({
    page,
  }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());

    const normalId = 'e2e-mock-conversation-layout-normal';
    const recoveringId = 'e2e-mock-conversation-layout-recovering';

    function conversationBody(id: string, status: 'complete' | 'generating') {
      const generating = status === 'generating';
      return {
        id,
        title: 'Layout comparison',
        title_is_custom: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [
          {
            id: 'user-msg-1',
            role: 'user',
            content: 'Does peer tutoring help learning outcomes in secondary school?',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
            created_at: new Date().toISOString(),
            sources: [],
            attachments: [],
            status: 'complete',
            error_message: null,
          },
          {
            id: 'assistant-msg-1',
            role: 'assistant',
            content: generating
              ? ''
              : 'Yes — several meta-analyses report a small-to-moderate positive effect.',
            citations: [],
            citation_warnings: [],
            insufficient_evidence: false,
            created_at: new Date().toISOString(),
            sources: [],
            attachments: [],
            status,
            error_message: null,
          },
        ],
      };
    }

    await page.route(`**/conversations/${normalId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversationBody(normalId, 'complete')),
      });
    });
    await page.route(`**/conversations/${recoveringId}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(conversationBody(recoveringId, 'generating')),
      });
    });

    await page.goto(`/chat/${normalId}`, { waitUntil: 'load' });
    await expect(page.locator('[data-testid="chat-turn-wrap"]').first()).toBeVisible();
    const normalTurnWrap = await page.locator('[data-testid="chat-turn-wrap"]').first().boundingBox();
    const normalComposer = await page.locator('[data-testid="chat-composer-inner"]').first().boundingBox();
    const normalListWrap = await page.locator('[data-testid="chat-list-wrap"]').first().boundingBox();
    expect(normalTurnWrap).toBeTruthy();
    expect(normalComposer).toBeTruthy();
    expect(normalListWrap).toBeTruthy();

    await page.goto(`/chat/${recoveringId}`, { waitUntil: 'load' });
    await expect(page.locator('text=Picking up a response that was still being generated')).toBeVisible({
      timeout: 10_000,
    });
    // The outer wrapper's full box (including its own top padding) is the
    // banner's *entire* vertical footprint — comparing against just the
    // inner Notice's own height would under-count by that padding.
    const banner = await page.locator('[data-testid="chat-recovery-banner-outer"]').first().boundingBox();
    const recoveringTurnWrap = await page.locator('[data-testid="chat-turn-wrap"]').first().boundingBox();
    const recoveringComposer = await page.locator('[data-testid="chat-composer-inner"]').first().boundingBox();
    const recoveringListWrap = await page.locator('[data-testid="chat-list-wrap"]').first().boundingBox();
    expect(banner).toBeTruthy();
    expect(recoveringTurnWrap).toBeTruthy();
    expect(recoveringComposer).toBeTruthy();
    expect(recoveringListWrap).toBeTruthy();

    // The core assertion: identical x-position and width for the message
    // column and the composer, banner or no banner.
    expect(recoveringTurnWrap!.x).toBeCloseTo(normalTurnWrap!.x, 0);
    expect(recoveringTurnWrap!.width).toBeCloseTo(normalTurnWrap!.width, 0);
    expect(recoveringComposer!.x).toBeCloseTo(normalComposer!.x, 0);
    expect(recoveringComposer!.width).toBeCloseTo(normalComposer!.width, 0);

    // The one permitted difference: the list area's top edge (and the
    // banner-inclusive space above it) moves down by exactly the banner's
    // own rendered height — never more, never less, and the list's width
    // is unaffected either way.
    expect(recoveringListWrap!.width).toBeCloseTo(normalListWrap!.width, 0);
    const heightDelta = recoveringListWrap!.y - normalListWrap!.y;
    expect(heightDelta).toBeCloseTo(banner!.height, 0);
  });
});
