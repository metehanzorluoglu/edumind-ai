import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { PreferencesProvider } from '@/lib/Preferences';
import { BottomNav } from '../BottomNav';

function findByLabel(root: ReactTestInstance, label: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
  return matches[0] ?? null;
}

async function renderBottomNav(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <PreferencesProvider>
        <BottomNav active="documents" onNavigate={() => {}} />
      </PreferencesProvider>
    );
    await Promise.resolve();
  });
  return renderer;
}

describe('BottomNav', () => {
  it('Frontend/Platform Milestone 3.2.1 Part E — no Search item; Chat/Documents/Notes/Settings remain', async () => {
    const renderer = await renderBottomNav();
    expect(findByLabel(renderer.root, 'Search')).toBeNull();
    expect(findByLabel(renderer.root, 'Chat')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Documents')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Notes')).toBeTruthy();
    expect(findByLabel(renderer.root, 'Settings')).toBeTruthy();
  });
});
