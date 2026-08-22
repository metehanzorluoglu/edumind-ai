/**
 * Writing drawer/layout architecture correction — the actual defect this
 * milestone fixes: app/(tabs)/_layout.tsx used to render the Chat/
 * Projects `AppDrawer` unconditionally for every route, so opening a
 * Writing project produced "icon rail | chat drawer | research panel |
 * editor | preview" instead of "icon rail | Writing drawer | editor |
 * preview". This file tests `_layout.tsx` itself (not [id].tsx in
 * isolation, which the other Writing test files already cover) —
 * mocking `expo-router`'s `<Slot/>` to render a minimal stand-in screen
 * that registers into the real WritingDrawerSlot, exactly like the real
 * [id].tsx does, so the actual conditional in `_layout.tsx` (not a
 * hand-rolled substitute for it) is what's under test.
 */
import { Dimensions, Platform } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import TabsLayout from '../_layout';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const MOCK_WRITING_DRAWER_MARKER = 'writing-drawer-marker-content';
const MOCK_APP_DRAWER_MARKER = 'app-drawer-marker-content';

let mockPathname = '/writing/w-1';

jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
    usePathname: () => mockPathname,
    Redirect: () => null,
    // Stands in for [id].tsx / any other routed screen — registers
    // Writing drawer content exactly like the real [id].tsx does,
    // whenever the mocked pathname looks like a writing project detail
    // route, so the real `_layout.tsx` conditional (isWritingProjectOpen)
    // is what decides whether it actually gets shown. require()'d
    // lazily inside the factory — jest.mock() factories are hoisted
    // above imports, so a module-level import can't be referenced here.
    //
    // Wrapped in React.memo() with zero props, mirroring the REAL
    // WritingProjectEditorScreen's own memo() wrap in [id].tsx: without
    // it, this mock would re-render on every _layout.tsx cascade (it's
    // rendered via Slot, a descendant of _layout.tsx) and re-registering
    // would call setContent with a brand-new React element identity
    // every time, which — since the real registration hook's own "sync"
    // effect has no dependency array by design (see WritingDrawerSlot.tsx's
    // docstring) — never bails out, reproducing the exact infinite-
    // render-loop bug this milestone already found and fixed once for
    // real. memo() breaks the cascade here exactly like it does in
    // production.
    //
    // The registration call itself happens directly in the render body
    // (not inside a useEffect), matching exactly how the real [id].tsx
    // calls setWritingDrawerContent(panel) — a plain function call right
    // after computing its JSX, unconditionally, during render. That
    // ordering matters: useRegisterWritingDrawerContent's own "sync"
    // effect (which copies the ref into real shared state) runs during
    // the SAME commit as this component's mount, but effects fire in
    // declaration order — so the ref has to already hold the real value
    // by the time that sync effect runs, not get written to it by a
    // second, later effect of this mock's own.
    Slot: React.memo(function MockRoutedScreen() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { useRegisterWritingDrawerContent } = require('@/lib/WritingDrawerSlot');
      const setContent = useRegisterWritingDrawerContent();
      if (mockPathname.startsWith('/writing/') && mockPathname !== '/writing/') {
        setContent(React.createElement(RNText, null, MOCK_WRITING_DRAWER_MARKER));
      } else {
        setContent(null);
      }
      return null;
    }),
  };
});

jest.mock('@/lib/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated' }),
}));

jest.mock('@/lib/ClientProvider', () => ({
  useClient: () => ({ client: {} }),
}));

jest.mock('education-assistant-client', () => ({
  useConversations: () => ({ data: [], status: 'success', refresh: jest.fn() }),
  useProjects: () => ({ data: [], status: 'success', refresh: jest.fn() }),
}));

jest.mock('@/components/AppDrawer', () => ({
  AppDrawer: () => {
    const { Text: RNText } = jest.requireActual('react-native');
    return <RNText>{'app-drawer-marker-content'}</RNText>;
  },
}));

jest.mock('@/components/NavRail', () => ({
  NavRail: () => null,
}));

jest.mock('@/components/BottomNav', () => ({
  BottomNav: () => null,
}));

const originalOS = Platform.OS;
const originalWindow = Dimensions.get('window');
beforeAll(() => {
  Platform.OS = 'web';
  Dimensions.set({
    window: { width: 1400, height: 900, scale: 1, fontScale: 1 },
    screen: { width: 1400, height: 900, scale: 1, fontScale: 1 },
  });
});
afterAll(() => {
  Platform.OS = originalOS;
  Dimensions.set({ window: originalWindow, screen: originalWindow });
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let renderer: ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) {
    act(() => {
      renderer!.unmount();
    });
    renderer = null;
  }
});

async function renderLayout(): Promise<ReactTestRenderer> {
  await act(async () => {
    renderer = create(<TabsLayout />);
    await flushAsync();
  });
  return renderer!;
}

function hasText(root: ReactTestRenderer['root'], text: string): boolean {
  return root.findAll((n) => String(n.type) === 'Text' && n.children.includes(text)).length > 0;
}

describe('app/(tabs)/_layout.tsx — Writing drawer/layout architecture correction', () => {
  it('shows the Writing drawer (not AppDrawer) while a Writing project is open', async () => {
    mockPathname = '/writing/w-1';
    const { root } = await renderLayout();

    expect(hasText(root, MOCK_WRITING_DRAWER_MARKER)).toBe(true);
    expect(hasText(root, MOCK_APP_DRAWER_MARKER)).toBe(false);
  });

  it('shows the normal Chat/Projects AppDrawer on Chat routes, unaffected', async () => {
    mockPathname = '/chat/c1';
    const { root } = await renderLayout();

    expect(hasText(root, MOCK_APP_DRAWER_MARKER)).toBe(true);
    expect(hasText(root, MOCK_WRITING_DRAWER_MARKER)).toBe(false);
  });

  it('shows the normal AppDrawer on the bare /writing list route (no project open yet)', async () => {
    mockPathname = '/writing';
    const { root } = await renderLayout();

    expect(hasText(root, MOCK_APP_DRAWER_MARKER)).toBe(true);
    expect(hasText(root, MOCK_WRITING_DRAWER_MARKER)).toBe(false);
  });

  it('never shows both drawers at once on a Writing project route', async () => {
    mockPathname = '/writing/w-1';
    const { root } = await renderLayout();

    const writingCount = root.findAll(
      (n) => String(n.type) === 'Text' && n.children.includes(MOCK_WRITING_DRAWER_MARKER)
    ).length;
    const appDrawerCount = root.findAll(
      (n) => String(n.type) === 'Text' && n.children.includes(MOCK_APP_DRAWER_MARKER)
    ).length;
    expect(writingCount).toBeGreaterThan(0);
    expect(appDrawerCount).toBe(0);
  });
});
