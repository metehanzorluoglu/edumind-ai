import { defineConfig, devices } from '@playwright/test';

/**
 * Checked-in E2E suite for the EduM8 frontend. Runs against a real,
 * already-deployed instance (EDUM8_BASE_URL) — this is not a local dev
 * server harness, on purpose: the flows under test (stream-disconnect
 * recovery, vision generation) only mean anything against the real
 * backend/Ollama/Qdrant stack.
 *
 * Credentials (EDUM8_TEST_EMAIL / EDUM8_TEST_PASSWORD) come from the
 * environment only — see .env.example. Tracing is deliberately left off
 * by default: a trace can capture DOM snapshots, and while a password
 * field renders masked, the safest default is not to record one at all.
 * Screenshots are kept only on failure and never taken while a password
 * field is focused/populated (see tests/helpers/auth.ts).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 10 * 60 * 1000, // generation on a CPU-only backend can take minutes
  expect: { timeout: 15_000 },
  fullyParallel: false, // shared rate-limited account — see tests/helpers/auth.ts
  forbidOnly: !!process.env.CI,
  retries: 0, // an intermittent failure here (e.g. BUG-1) must be visible, never silently retried away
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.EDUM8_BASE_URL ?? 'https://app.edum8.us',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
