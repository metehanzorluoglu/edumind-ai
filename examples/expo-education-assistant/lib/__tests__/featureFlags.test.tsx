/**
 * Centralized feature flags:
 *   - Backend's GET /status is the source of truth (see
 *     rag-backend/app/api/routes_status.py → image_generation_enabled).
 *   - lib/FeatureFlags wraps client.status() and exposes a React-context
 *     snapshot every consumer reads, so a backend admin can toggle a flag
 *     without an app rebuild.
 *   - Until /status resolves, a build-time default derived from
 *     EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED is used, so the very first
 *     paint of a gated screen already matches intent instead of briefly
 *     flashing the wrong state in.
 *
 * These tests cover both modes (enabled + disabled) of the flag, the
 * pre-fetch bootstrap default, the error-doesn't-flicker-the-UI rule,
 * and the foreground-focus refresh.
 */
import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { FeatureFlagsProvider, useFeatureFlags } from '../FeatureFlags';

// Module-scoped mutable + `mock…` prefix is required because babel-jest
// refuses out-of-scope variable references in `jest.mock` factories
// unless the name starts with `mock`. The factory closure re-reads the
// variable on every call, so individual tests can override it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStatusResponses: Array<{ reject: boolean; payload?: unknown }> = [];
let mockStatusCallCount = 0;

const mockStatus = jest.fn(async () => {
  mockStatusCallCount++;
  const next = mockStatusResponses.shift();
  if (!next || next.reject) {
    throw new Error('status() rejected in this test');
  }
  return next.payload as never;
});

// Stable client reference shared across every `useClient()` call — if the
// mock returned a fresh `{ client: { status: mockStatus } }` object on each
// render, FeatureFlagsProvider's `useCallback([client])` would produce a
// new `refresh` function every render, the `useEffect([refresh])` would
// re-fire, and we'd have a render→fetch→render→fetch loop that OOM-es
// into a heap error long before any test could assert.
// `var mock…` prefix is required: babel-jest refuses out-of-scope variable
// references inside `jest.mock()` factories unless the identifier is named
// with a `mock` prefix.
var mockStableFakeClientContext = { client: { status: mockStatus } };
jest.mock('@/lib/ClientProvider', () => ({
  // Provide just the slice FeatureFlags actually uses (useFeatureFlags →
  // client.status()) — the FeatureFlags component doesn't read baseUrl,
  // auth state, or anything else from the context.
  useClient: () => mockStableFakeClientContext,
}));

function withProvider(children: ReactNode): ReactTestInstance {
  // Each render gets a fresh provider so a failing /status on the previous
  // test doesn't leak into the next one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return create(<FeatureFlagsProvider>{children}</FeatureFlagsProvider>) as unknown as ReactTestInstance;
}
void withProvider; // reserved for a follow-up test that wants a static provider, not used here

interface CapturedFlags {
  imageGenerator: boolean;
  folderLibrary: boolean;
  conversationScope: boolean;
  zoomIn: boolean;
  latexCompilation: boolean;
  developerSettings: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
}
function Probe({ onRender }: { onRender: (flags: CapturedFlags) => void }): null {
  const flags = useFeatureFlags();
  onRender(flags);
  return null;
}

interface RenderedFlags {
  flags: CapturedFlags;
  renderer: ReactTestInstance;
}
async function renderAndCapture(): Promise<RenderedFlags> {
  let last: CapturedFlags | null = null;
  let renderer!: ReactTestInstance;
  await act(async () => {
    renderer = create(
      <FeatureFlagsProvider>
        <Probe onRender={(f) => (last = f)} />
      </FeatureFlagsProvider>
    );
    // Let the on-mount `client.status()` call settle.
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!last) throw new Error('Probe never rendered');
  return { flags: last, renderer };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockStatusResponses.length = 0;
  mockStatusCallCount = 0;
  mockStatus.mockClear();
  // Restore a known starting environment so leftover EXPO_PUBLIC_* values
  // from a developer's shell don't leak between tests. Each test that needs
  // to override these writes to process.env directly and the test-scoped
  // cleanup removes its entries.
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  // Belt-and-suspenders: explicitly delete any EXPO_PUBLIC_KEY the test
  // might have set so the (re-set above) `beforeEach` clone stays clean
  // for the next test, matching how a clean production build would see it.
  delete process.env.EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED;
  process.env = { ...ORIGINAL_ENV };
});

describe('FeatureFlagsProvider', () => {
  it('reads imageGenerator=true from a successful GET /status', async () => {
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    const { flags } = await renderAndCapture();
    expect(flags.imageGenerator).toBe(true);
    expect(flags.loaded).toBe(true);
    expect(mockStatusCallCount).toBe(1);
  });

  it('reads imageGenerator=false from a successful GET /status (the disabled mode)', async () => {
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: false } });
    const { flags } = await renderAndCapture();
    expect(flags.imageGenerator).toBe(false);
    expect(flags.loaded).toBe(true);
    expect(mockStatusCallCount).toBe(1);
  });

  it('falls back to the build-time default (EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED=true) before /status resolves', async () => {
    // Don't queue a response for the first call — let the status() promise
    // stay pending. The bootstrap value should still be visible because
    // /status hasn't reported yet.
    process.env.EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED = 'true';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      // Flush just the synchronous render path (NOT a microtask resolving
      // status) — the bootstrap value should already have reached the
      // component on the very first paint.
      await Promise.resolve();
    });
    // Touch the renderer later by salvaging it via Probe.
    expect(last).not.toBeNull();
    expect(last!.imageGenerator).toBe(true);
    expect(last!.loaded).toBe(false);
  });

  it('falls back to the build-time default of false (EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED=false) before /status resolves', async () => {
    process.env.EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED = 'false';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last).not.toBeNull();
    expect(last!.imageGenerator).toBe(false);
    expect(last!.loaded).toBe(false);
  });

  it('treats an unrecognized EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED value as not-set (default true)', async () => {
    process.env.EXPO_PUBLIC_IMAGE_GENERATOR_ENABLED = 'maybe';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.imageGenerator).toBe(true);
  });

  it('a /status error does not flicker the UI — the last-known / build-time value stays', async () => {
    // Reject the first status call; the bootstrap default is true. The
    // provider must keep reporting true (no flip to false on the error),
    // and stay "loaded=false" so an observer can tell the backend never
    // gave a definitive answer.
    mockStatus.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      // Several microtask ticks so the rejected promise settles and the
      // .catch arm runs.
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(last).not.toBeNull();
    expect(last!.imageGenerator).toBe(true);
    expect(last!.loaded).toBe(false);
  });

  it('refresh() re-fetches /status and reflects the latest value (manual override)', async () => {
    // First call: enabled; second call: disabled. The manual refresh()
    // call must flip the snapshot to disabled without remounting the
    // provider — proving the snapshot is sync-triggered, not just
    // mount-time.
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: false } });

    let last: CapturedFlags | null = null;
    let renderer!: ReactTestInstance;
    await act(async () => {
      renderer = create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last!.imageGenerator).toBe(true);

    await act(async () => {
      await last!.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last!.imageGenerator).toBe(false);
    expect(last!.loaded).toBe(true);
    expect(mockStatusCallCount).toBe(2);

    void renderer; // silence unused-var warning for the happy-path render only
  });
});

// folderLibrary (Milestone 1: Document Library / Folder Management) is
// server-derived exactly like imageGenerator above — same bootstrap/
// refresh/error-doesn't-flicker contract, just a different backend field
// and a `true` (not `false`) build-time default (see
// bootstrapFolderLibraryFlag's docstring for why: this is the new standard
// Documents experience, not an opt-in beta).
describe('folderLibrary flag', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_FOLDER_LIBRARY_ENABLED;
  });

  it('reads folderLibrary=true from a successful GET /status', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, folder_library_enabled: true },
    });
    const { flags } = await renderAndCapture();
    expect(flags.folderLibrary).toBe(true);
    expect(flags.loaded).toBe(true);
  });

  it('reads folderLibrary=false from a successful GET /status (the disabled/rollback mode)', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, folder_library_enabled: false },
    });
    const { flags } = await renderAndCapture();
    expect(flags.folderLibrary).toBe(false);
    expect(flags.loaded).toBe(true);
  });

  it('falls back to the build-time default (true) before /status resolves', async () => {
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last).not.toBeNull();
    expect(last!.folderLibrary).toBe(true);
    expect(last!.loaded).toBe(false);
  });

  it('an explicit EXPO_PUBLIC_FOLDER_LIBRARY_ENABLED=false bootstrap default is honored pre-/status', async () => {
    process.env.EXPO_PUBLIC_FOLDER_LIBRARY_ENABLED = 'false';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.folderLibrary).toBe(false);
  });

  it('refresh() re-fetches /status and reflects the latest folderLibrary value', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, folder_library_enabled: true },
    });
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, folder_library_enabled: false },
    });

    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last!.folderLibrary).toBe(true);

    await act(async () => {
      await last!.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last!.folderLibrary).toBe(false);
  });
});

// conversationScope (Milestone 2/3: conversation document scope / Chat
// Sources) is server-derived exactly like folderLibrary above.
describe('conversationScope flag', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_CONVERSATION_SCOPE_ENABLED;
  });

  it('reads conversationScope=true from a successful GET /status', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, conversation_scope_enabled: true },
    });
    const { flags } = await renderAndCapture();
    expect(flags.conversationScope).toBe(true);
    expect(flags.loaded).toBe(true);
  });

  it('reads conversationScope=false from a successful GET /status (the disabled/rollback mode)', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, conversation_scope_enabled: false },
    });
    const { flags } = await renderAndCapture();
    expect(flags.conversationScope).toBe(false);
  });

  it('falls back to the build-time default (true) before /status resolves', async () => {
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.conversationScope).toBe(true);
  });

  it('an explicit EXPO_PUBLIC_CONVERSATION_SCOPE_ENABLED=false bootstrap default is honored pre-/status', async () => {
    process.env.EXPO_PUBLIC_CONVERSATION_SCOPE_ENABLED = 'false';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.conversationScope).toBe(false);
  });
});

// zoomIn (Milestone 4: Zoom-In / strict selected-source mode) is
// server-derived exactly like conversationScope above.
describe('zoomIn flag', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_ZOOM_IN_ENABLED;
  });

  it('reads zoomIn=true from a successful GET /status', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, zoom_in_enabled: true },
    });
    const { flags } = await renderAndCapture();
    expect(flags.zoomIn).toBe(true);
    expect(flags.loaded).toBe(true);
  });

  it('reads zoomIn=false from a successful GET /status (the disabled/rollback mode)', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, zoom_in_enabled: false },
    });
    const { flags } = await renderAndCapture();
    expect(flags.zoomIn).toBe(false);
  });

  it('falls back to the build-time default (true) before /status resolves', async () => {
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.zoomIn).toBe(true);
  });

  it('an explicit EXPO_PUBLIC_ZOOM_IN_ENABLED=false bootstrap default is honored pre-/status', async () => {
    process.env.EXPO_PUBLIC_ZOOM_IN_ENABLED = 'false';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.zoomIn).toBe(false);
  });
});

// latexCompilation is the one server-derived flag with an opposite
// (false) default from every other flag above — see FeatureFlags.tsx's
// docstring on why an untrusted-code-execution surface must never appear
// even transiently before /status resolves.
describe('latexCompilation flag', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED;
  });

  it('reads latexCompilation=true from a successful GET /status', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, latex_compilation_enabled: true },
    });
    const { flags } = await renderAndCapture();
    expect(flags.latexCompilation).toBe(true);
    expect(flags.loaded).toBe(true);
  });

  it('reads latexCompilation=false from a successful GET /status (the default/off mode)', async () => {
    mockStatusResponses.push({
      reject: false,
      payload: { image_generation_enabled: true, latex_compilation_enabled: false },
    });
    const { flags } = await renderAndCapture();
    expect(flags.latexCompilation).toBe(false);
  });

  it('falls back to the build-time default (false) before /status resolves', async () => {
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.latexCompilation).toBe(false);
  });

  it('an explicit EXPO_PUBLIC_LATEX_COMPILATION_ENABLED=true bootstrap default is honored pre-/status', async () => {
    process.env.EXPO_PUBLIC_LATEX_COMPILATION_ENABLED = 'true';
    mockStatus.mockImplementationOnce(() => new Promise(() => {}));
    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
    });
    expect(last!.latexCompilation).toBe(true);
  });
});

// developerSettings is the one flag deliberately NOT server-derived: it is
// client-build configuration (EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED),
// defaults to false, and survives /status refreshes unchanged — so a
// production bundle that never sets the variable can never show developer
// tooling, even transiently.
describe('developerSettings flag', () => {
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED;
  });

  it('defaults to false when the env variable is unset (production-safe)', async () => {
    delete process.env.EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED;
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    const { flags } = await renderAndCapture();
    expect(flags.developerSettings).toBe(false);
    expect(flags.loaded).toBe(true);
  });

  it('is enabled only by an explicit EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED=true', async () => {
    process.env.EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED = 'true';
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    const { flags } = await renderAndCapture();
    expect(flags.developerSettings).toBe(true);
  });

  it('treats unrecognized values as disabled (no accidental opt-in)', async () => {
    process.env.EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED = 'yes-please';
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    const { flags } = await renderAndCapture();
    expect(flags.developerSettings).toBe(false);
  });

  it('is preserved across a /status refresh (never server-derived)', async () => {
    process.env.EXPO_PUBLIC_DEVELOPER_SETTINGS_ENABLED = 'true';
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: true } });
    mockStatusResponses.push({ reject: false, payload: { image_generation_enabled: false } });

    let last: CapturedFlags | null = null;
    await act(async () => {
      create(
        <FeatureFlagsProvider>
          <Probe onRender={(f) => (last = f)} />
        </FeatureFlagsProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(last!.developerSettings).toBe(true);

    await act(async () => {
      await last!.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The refresh landed (imageGenerator followed the server)…
    expect(last!.imageGenerator).toBe(false);
    // …but developerSettings stayed exactly where the build put it.
    expect(last!.developerSettings).toBe(true);
  });
});
