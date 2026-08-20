import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AuthProvider } from '@/lib/AuthProvider';
import { PreferencesProvider } from '@/lib/Preferences';
import { NavRail } from '../NavRail';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(
    async () => new Response(JSON.stringify({}), { status: 401 })
  ) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

async function renderRail(
  overrides: { onLogoPress?: () => void } = {}
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <AuthProvider>
        <PreferencesProvider>
          <NavRail
            active="documents"
            onNavigate={() => {}}
            drawerCollapsed={false}
            onToggleDrawer={() => {}}
            onLogoPress={overrides.onLogoPress ?? (() => {})}
          />
        </PreferencesProvider>
      </AuthProvider>
    );
    await Promise.resolve();
  });
  return renderer;
}

describe('NavRail', () => {
  it('Frontend/Platform Milestone 3.2.1 Part E — no Search item; Chat/Documents/Notes/Settings remain', async () => {
    const renderer = await renderRail();
    expect(findByLabel(renderer.root, 'Search')).toBeNull();
    expect(findByLabel(renderer.root, 'Chat')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Documents')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Research Notes')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Settings')).toBeTruthy();
  });
});
