import { test, expect } from '@playwright/test';
import { login, logout, TEST_EMAIL, TEST_PASSWORD } from './helpers';

test.describe('authentication', () => {
  test('signs in with the required account and lands on an authenticated route', async ({
    page,
  }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());
    await page.goto('/settings', { waitUntil: 'load' });
    await expect(page.locator(`text=${TEST_EMAIL()}`).first()).toBeVisible();
  });

  test('wrong password is rejected with a clear error, no account lockout risk', async ({
    page,
  }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('[aria-label="Email"]').fill(TEST_EMAIL());
    await page.locator('[aria-label="Password"]').fill(TEST_PASSWORD() + '-definitely-wrong');
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/auth/login') && r.request().method() === 'POST'),
      page.locator('[aria-label="Sign in"]').click(),
    ]);
    expect(response.status()).toBe(401);
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    expect(page.url()).toContain('/login');
  });

  test('empty email/password are caught client-side without any network request', async ({
    page,
  }) => {
    let loginCalls = 0;
    page.on('request', (r) => {
      if (r.url().includes('/auth/login')) loginCalls++;
    });
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('[aria-label="Sign in"]').click();
    await expect(page.locator('text=Email is required.')).toBeVisible();
    await expect(page.locator('text=Password is required.')).toBeVisible();
    expect(loginCalls).toBe(0);
  });

  test('invalid email format is caught client-side', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' });
    await page.locator('[aria-label="Email"]').fill('not-an-email');
    await page.locator('[aria-label="Password"]').fill('irrelevant-password-123');
    await page.locator('[aria-label="Sign in"]').click();
    await expect(page.locator('text=Enter a valid email address.')).toBeVisible();
  });

  test(
    'rapid double-click on Sign in sends exactly one login request ' +
      '(regression: app/login.tsx isSubmittingRef guard)',
    async ({ page }) => {
      let interceptedLoginRequests = 0;
      await page.route('**/auth/login', async (route) => {
        // Cross-origin (app.edum8.us -> api.edum8.us) POSTs trigger a CORS
        // preflight OPTIONS request first — only the real POST is a login
        // *attempt*; counting OPTIONS too would false-positive this test.
        if (route.request().method() !== 'POST') return route.continue();
        interceptedLoginRequests++;
        await new Promise((r) => setTimeout(r, 500)); // hold the request open so a second click could race it
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Invalid email or password' }),
        });
      });
      await page.goto('/login', { waitUntil: 'load' });
      await page.locator('[aria-label="Email"]').fill(TEST_EMAIL());
      await page.locator('[aria-label="Password"]').fill('mocked-does-not-matter-123');
      // A genuine rapid double-click means two onPress invocations within
      // the same synchronous tick, before React has re-rendered the
      // now-disabled button — Playwright's own page.click() serializes
      // repeated calls on the same page (each is its own hover/down/up
      // round-trip), which doesn't reproduce that; two native DOM clicks
      // dispatched back to back inside one page.evaluate() call does.
      await page.evaluate(() => {
        const el = document.querySelector('[aria-label="Sign in"]') as HTMLElement;
        el.click();
        el.click();
      });
      await page.waitForTimeout(1000);
      expect(interceptedLoginRequests).toBe(1);
    }
  );

  test('direct navigation to a protected route while unauthenticated redirects to login', async ({
    page,
  }) => {
    await page.goto('/chat/new', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/login');
  });

  test('logout then browser Back does not restore the authenticated view', async ({ page }) => {
    await login(page, TEST_EMAIL(), TEST_PASSWORD());
    await logout(page);
    await page.goBack({ waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(500);
    const stillLoggedOut =
      page.url().includes('/login') || (await page.getByText('Log out', { exact: true }).count()) === 0;
    expect(stillLoggedOut).toBe(true);
  });
});
