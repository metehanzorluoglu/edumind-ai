# EduMind E2E (Playwright)

Checked-in end-to-end coverage for the EduMind frontend, run against a
real, already-deployed instance — text chat, image/vision chat,
authentication, and the stream-disconnect-recovery fix (QA finding
BUG-1). This did not exist before; the previous QA audit's browser
testing was all ad hoc, throwaway scripts.

## Setup

```bash
cd e2e
npm install
npx playwright install chromium
cp .env.example .env   # fill in EDUMIND_TEST_EMAIL / EDUMIND_TEST_PASSWORD
```

Credentials are read from the environment only (`EDUMIND_TEST_EMAIL`,
`EDUMIND_TEST_PASSWORD`, `EDUMIND_BASE_URL`) — never hardcoded in a spec
file, `.env` is git-ignored, and tracing is off by default (see
`playwright.config.ts`) so a password can never end up in a trace file.

## Running

```bash
npm test              # headless, all specs
npm run test:headed   # a visible browser, useful while iterating
npm run test:ui       # Playwright's interactive UI mode
npm run report        # open the last HTML report
```

Specs tagged `@slow` wait on real backend generation (this deployment is
CPU-only Ollama — a single answer can take minutes) — `playwright.config.ts`
sets a 10-minute per-test timeout accordingly. `stream-recovery.spec.ts`
mocks the network layer instead, so it stays fast and deterministic; it
covers the *frontend's* recovery behavior specifically, not a substitute
for exercising the real backend, which the `@slow` specs already do.

## Layout

- `tests/helpers.ts` — login/logout/composer helpers shared by every spec.
- `tests/auth.spec.ts` — sign-in, wrong password, client-side validation,
  double-submit guard, unauthenticated redirect, logout+back.
- `tests/text-chat.spec.ts` — full send → stream → persist → reopen →
  re-login flow.
- `tests/stream-recovery.spec.ts` — BUG-1 regression: a dropped connection
  mid-generation must land the user on the real conversation, never a
  dead-end error, and a resumed 'generating' message must show a working
  Cancel action.
- `tests/image-chat.spec.ts` — attach/preview/remove/reattach, the exact
  vision prompt, persistence across refresh/reopen/re-login, and file
  validation edge cases (zero-byte, corrupt, wrong type, uppercase
  extension, JPEG, transparent PNG, portrait/landscape, multiple images).
- `fixtures/` — a real generated test image (four shapes, four colors,
  readable text) plus the deliberately-invalid fixtures used by the
  validation specs. Nothing here is a placeholder — `test-image.png` is a
  genuine PNG with real, describable content for the vision-accuracy
  checks.

## What's intentionally not here

Some scenarios from the QA brief are not safely automatable as a checked-in
suite without risking real production side effects, and are covered instead
by manual/one-off verification (see the project's QA reports, not this
directory): pushing the login rate limiter to its actual boundary, taking
the backend/Ollama/Qdrant fully offline, and anything requiring a second
real user account.
