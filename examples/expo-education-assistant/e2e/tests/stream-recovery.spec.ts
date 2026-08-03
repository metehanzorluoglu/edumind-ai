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
});
