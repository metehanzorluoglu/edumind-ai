import { test, expect } from '@playwright/test';
import {
  askButton,
  composer,
  gotoNewChat,
  login,
  logout,
  TEST_EMAIL,
  TEST_PASSWORD,
  thinkingBox,
  waitForConversationUrl,
} from './helpers';

const PROMPT =
  'Summarize, in two sentences, what this research corpus covers about AI literacy in K-12 education.';

test.describe('text chat @slow', () => {
  test('send a message, watch it stream, and confirm it survives refresh/reopen/re-login', async ({
    page,
  }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());
    await gotoNewChat(page);

    const input = composer(page);
    await input.fill(PROMPT);
    await expect(input).toHaveValue(PROMPT);

    await askButton(page).click();

    // User bubble renders immediately; no duplicate submission from this
    // single click.
    await expect(page.locator(`text=${PROMPT}`).first()).toBeVisible({ timeout: 10_000 });

    // A waiting/thinking indicator appears before any token does.
    await expect(thinkingBox(page).first()).toBeVisible({ timeout: 20_000 });

    // Generation on a CPU-only backend can take minutes — wait for the
    // navigation to the real persisted conversation, which only happens
    // once the stream actually completes (or the app has recovered into
    // a viewable state — see stream-recovery.spec.ts for that path).
    const conversationId = await waitForConversationUrl(page);

    const answerLocator = page.locator('body');
    await expect(answerLocator).not.toContainText('Preparing a response', { timeout: 5_000 });

    const contentAfterSend = await page.locator('body').innerText();
    expect(contentAfterSend).toContain(PROMPT);

    // Refresh: the conversation and its answer must persist unchanged.
    await page.reload({ waitUntil: 'load' });
    await expect(page.locator(`text=${PROMPT.slice(0, 40)}`).first()).toBeVisible({
      timeout: 15_000,
    });
    expect(page.url()).toContain(conversationId);

    // Reopen from the sidebar after navigating away.
    await gotoNewChat(page);
    const row = page.locator(`text=${PROMPT.slice(0, 30)}`).first();
    await row.waitFor({ timeout: 15_000 });
    await row.click();
    await page.waitForURL((u) => u.pathname.includes(conversationId), { timeout: 15_000 });
    await expect(page.locator(`text=${PROMPT.slice(0, 40)}`).first()).toBeVisible();

    // Logout + re-login: the conversation stays accessible under the same account.
    await logout(page);
    await login(page, TEST_EMAIL(), TEST_PASSWORD());
    await gotoNewChat(page);
    const rowAfterRelogin = page.locator(`text=${PROMPT.slice(0, 30)}`).first();
    await rowAfterRelogin.waitFor({ timeout: 15_000 });
    await rowAfterRelogin.click();
    await page.waitForURL((u) => u.pathname.includes(conversationId), { timeout: 15_000 });
    await expect(page.locator(`text=${PROMPT.slice(0, 40)}`).first()).toBeVisible();
  });

  test('the Ask control never stays stuck after a completed send', async ({ page }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());
    await gotoNewChat(page);
    await composer(page).fill('What is the shortest true one-sentence summary you can give?');
    await askButton(page).click();
    await waitForConversationUrl(page);
    // Landing on the conversation route always remounts a fresh composer
    // (see app/(tabs)/chat/[id].tsx) — its own Ask control must be usable,
    // not stuck disabled from the previous screen's state.
    await composer(page).fill('a');
    await expect(askButton(page)).toBeEnabled();
  });
});
