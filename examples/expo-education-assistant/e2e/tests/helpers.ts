import { expect, type Page } from '@playwright/test';

/** Throws loudly if a required env var is missing/empty — never falls
 * back to a substitute value (see the repo's QA process: "if a required
 * credential is missing, fail the test, never substitute another
 * account"). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy e2e/.env.example to e2e/.env (or export it in your shell/CI ` +
        `secrets) before running this suite — see that file for what's required.`
    );
  }
  return value;
}

export const TEST_EMAIL = () => requireEnv('EDUMIND_TEST_EMAIL');
export const TEST_PASSWORD = () => requireEnv('EDUMIND_TEST_PASSWORD');

/** Logs in via the real form. Never logs, screenshots, or traces the
 * password — it is filled directly from the environment variable and
 * never touches a variable this file itself prints. */
export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login', { waitUntil: 'load' });
  await page.locator('[aria-label="Email"]').fill(email);
  await page.locator('[aria-label="Password"]').fill(password);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/login') && r.request().method() === 'POST'),
    page.locator('[aria-label="Sign in"]').click(),
  ]);
  await page.waitForURL((u) => u.pathname.startsWith('/chat'), { timeout: 30_000 });
}

export async function logout(page: Page): Promise<void> {
  await page.getByText('Log out', { exact: true }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/login'), { timeout: 15_000 });
}

export async function gotoNewChat(page: Page): Promise<void> {
  await page.goto('/chat/new', { waitUntil: 'load' });
  await page.locator('[placeholder^="Ask"]').waitFor({ state: 'visible' });
}

export function composer(page: Page) {
  return page.locator('[placeholder^="Ask"]');
}

export function askButton(page: Page) {
  return page.getByText('Ask', { exact: true });
}

export function thinkingBox(page: Page) {
  return page.locator('[data-testid="thinking-shadow-box"], [testid="thinking-shadow-box"]');
}

/** Waits for /chat/new's composer to navigate to a real persisted
 * conversation (/chat/{uuid}) — the shared "generation finished (or the
 * app recovered from a dropped connection into a viewable state)" signal
 * used by both the happy-path and stream-recovery specs. */
export async function waitForConversationUrl(page: Page, timeoutMs = 480_000): Promise<string> {
  await page.waitForURL((u) => /\/chat\/[0-9a-fA-F-]{8,}$/.test(u.pathname), { timeout: timeoutMs });
  const match = page.url().match(/\/chat\/([0-9a-fA-F-]{8,})$/);
  expect(match, 'expected to land on a /chat/{id} URL').toBeTruthy();
  return match![1]!;
}
