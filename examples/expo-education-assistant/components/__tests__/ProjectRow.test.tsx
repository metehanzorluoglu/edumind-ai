import type { ProjectSummary, UseProjectsResult } from 'education-assistant-client';
import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ProjectRow } from '../ProjectRow';
import { SidebarContextMenuProvider } from '@/lib/SidebarContextMenuContext';

// Same mock as ConversationRow.test.tsx / ConversationSidebar.test.tsx —
// react-test-renderer's measureInWindow stub never invokes its callback
// (no real layout engine underneath it), so without this every three-dot
// press would silently do nothing, in the test only — see
// measureWindowRect.ts's own docs.
jest.mock('@/lib/measureWindowRect', () => ({
  measureWindowRect: (
    _ref: unknown,
    callback: (rect: { x: number; y: number; width: number; height: number }) => void
  ) => callback({ x: 100, y: 40, width: 24, height: 24 }),
}));

// Frontend/Platform Milestone 3.2.2 Part F — this component (and the
// project rename/edit-description flow generally) had zero test
// coverage before this file: useProjects.test.tsx already covers the
// underlying hook, but nothing exercised the actual menu-click ->
// edit-mode -> commit interaction a real user goes through. This is
// exactly the kind of gap where "every layer looks correct in isolation"
// can still hide a real, user-visible break.

function buildProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    name: 'AI Literacy Study',
    description: 'Background research on classroom AI adoption.',
    conversation_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildProjects(overrides: Partial<UseProjectsResult> = {}): UseProjectsResult {
  return {
    listState: { status: 'idle' },
    refresh: jest.fn(),
    cancelList: jest.fn(),
    createProject: jest.fn(),
    updateProject: jest.fn(),
    deleteStates: {},
    deleteProject: jest.fn(),
    resetDeleteState: jest.fn(),
    projectConversationsStates: {},
    loadProjectConversations: jest.fn(),
    addRemoveStates: {},
    addConversationToProject: jest.fn(),
    removeConversationFromProject: jest.fn(),
    ...overrides,
  };
}

function findByText(root: ReactTestInstance, text: string): ReactTestInstance | null {
  const matches = root.findAll(
    (node) => String(node.type) === 'Text' && node.children.includes(text)
  );
  return matches[0] ?? null;
}

function findPressableByAccessibilityLabel(
  root: ReactTestInstance,
  label: string
): ReactTestInstance {
  return root.find(
    (node) => typeof node.props.onPress === 'function' && node.props.accessibilityLabel === label
  );
}

async function renderRow(
  project: ProjectSummary,
  projects: UseProjectsResult
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <SidebarContextMenuProvider>
        <ProjectRow
          project={project}
          expanded={false}
          onToggleExpand={() => {}}
          projects={projects}
          activeConversationId={null}
          onSelectConversation={() => {}}
          onAddToProject={() => {}}
          onRenameConversation={() => {}}
          onDeleteConversation={() => {}}
          deletingConversationIds={new Set()}
        />
      </SidebarContextMenuProvider>
    );
    await Promise.resolve();
  });
  return renderer;
}

/** Opens the row's three-dot menu, exactly like a real tap on it. */
async function openMenu(renderer: ReactTestRenderer, projectName: string): Promise<void> {
  const trigger = findPressableByAccessibilityLabel(renderer.root, `Options for ${projectName}`);
  await act(async () => {
    trigger.props.onPress();
    await Promise.resolve();
  });
}

/**
 * Clicks a menu item ('Rename'/'Edit description') and flushes the real
 * setTimeout(..., 0) those items now defer through (see ProjectRow.tsx's
 * handleMenuTriggerPress) — a bare `await Promise.resolve()` only
 * flushes microtasks, never a real macrotask, and would hang/misreport
 * once the deferral existed.
 *
 * Important honest limitation: this suite verifies editMode/prefill/
 * commit/no-op/error STATE LOGIC, which had zero coverage before this
 * file and is exactly what a unit test can check. It does NOT reproduce
 * the actual root cause the deferral above fixes (the real "Rename is
 * visible but broken" bug — see ProjectRow.tsx's own comment): a
 * react-native-web Modal's focus-trap teardown racing the rename input's
 * autoFocus, stealing focus back and firing an immediate onBlur before
 * the user can type. react-test-renderer has no real DOM/focus system,
 * so that race structurally cannot happen here — this bug was only
 * ever caught, and can only be regression-tested, in a real browser
 * (see Frontend/Platform Milestone 3.2.2's real-Chromium validation).
 */
async function clickMenuItemAndFlush(item: ReactTestInstance): Promise<void> {
  await act(async () => {
    item.props.onPress();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ProjectRow — Rename (Frontend/Platform Milestone 3.2.2 Part F)', () => {
  it('clicking Rename in the menu enters edit mode with the current name prefilled', async () => {
    const project = buildProject({ name: 'AI Literacy Study' });
    const renderer = await renderRow(project, buildProjects());

    await openMenu(renderer, 'AI Literacy Study');
    const renameItem = findPressableByAccessibilityLabel(renderer.root, 'Rename');
    await clickMenuItemAndFlush(renameItem);

    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Project name');
    expect(input.props.value).toBe('AI Literacy Study');
  });

  it('typing a new name and submitting calls updateProject with the trimmed name', async () => {
    const project = buildProject({ name: 'AI Literacy Study' });
    const updateProject = jest.fn().mockResolvedValue(buildProject({ name: 'New Name' }));
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const renameItem = findPressableByAccessibilityLabel(renderer.root, 'Rename');
    await clickMenuItemAndFlush(renameItem);

    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Project name');
    await act(async () => {
      input.props.onChangeText('  New Name  ');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(updateProject).toHaveBeenCalledWith('p1', { name: 'New Name' });
  });

  it('does NOT call updateProject when the name is unchanged (zero-mutation no-op)', async () => {
    const project = buildProject({ name: 'AI Literacy Study' });
    const updateProject = jest.fn();
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const renameItem = findPressableByAccessibilityLabel(renderer.root, 'Rename');
    await clickMenuItemAndFlush(renameItem);

    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Project name');
    await act(async () => {
      input.props.onBlur();
      await Promise.resolve();
    });

    expect(updateProject).not.toHaveBeenCalled();
  });

  it('does NOT call updateProject for a whitespace-only name, and reverts to the real name', async () => {
    const project = buildProject({ name: 'AI Literacy Study' });
    const updateProject = jest.fn();
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const renameItem = findPressableByAccessibilityLabel(renderer.root, 'Rename');
    await clickMenuItemAndFlush(renameItem);

    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Project name');
    await act(async () => {
      input.props.onChangeText('   ');
    });
    await act(async () => {
      input.props.onBlur();
      await Promise.resolve();
    });

    expect(updateProject).not.toHaveBeenCalled();
    // The edit box closed (a whitespace-only "rename" is just a no-op
    // cancel) and the real name is what's shown.
    expect(findByText(renderer.root, 'AI Literacy Study')).toBeTruthy();
  });

  it('a failed rename shows the error and leaves the real (never optimistic) name displayed', async () => {
    const project = buildProject({ name: 'AI Literacy Study' });
    const updateProject = jest.fn().mockRejectedValue(new Error('Name already in use'));
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const renameItem = findPressableByAccessibilityLabel(renderer.root, 'Rename');
    await clickMenuItemAndFlush(renameItem);

    const input = renderer.root.find((node) => node.props.accessibilityLabel === 'Project name');
    await act(async () => {
      input.props.onChangeText('Conflicting Name');
    });
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(findByText(renderer.root, 'Name already in use')).toBeTruthy();
    // The prop-provided project name (the real, server-confirmed value)
    // is what renders — never the failed optimistic "Conflicting Name".
    expect(findByText(renderer.root, 'AI Literacy Study')).toBeTruthy();
    expect(findByText(renderer.root, 'Conflicting Name')).toBeNull();
  });
});

describe('ProjectRow — Edit description (Frontend/Platform Milestone 3.2.2 Part F)', () => {
  it('clicking Edit description enters edit mode with the current description prefilled', async () => {
    const project = buildProject({ description: 'Existing description.' });
    const renderer = await renderRow(project, buildProjects());

    await openMenu(renderer, 'AI Literacy Study');
    const editItem = findPressableByAccessibilityLabel(renderer.root, 'Edit description');
    await clickMenuItemAndFlush(editItem);

    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Project description'
    );
    expect(input.props.value).toBe('Existing description.');
  });

  it('blurring after editing calls updateProject with the new description', async () => {
    const project = buildProject({ description: 'Old description.' });
    const updateProject = jest.fn().mockResolvedValue(buildProject({ description: 'New one.' }));
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const editItem = findPressableByAccessibilityLabel(renderer.root, 'Edit description');
    await clickMenuItemAndFlush(editItem);

    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Project description'
    );
    await act(async () => {
      input.props.onChangeText('New one.');
    });
    await act(async () => {
      input.props.onBlur();
      await Promise.resolve();
    });

    expect(updateProject).toHaveBeenCalledWith('p1', { description: 'New one.' });
  });

  it('clearing the description entirely sends description: null, not an empty string', async () => {
    const project = buildProject({ description: 'Old description.' });
    const updateProject = jest.fn().mockResolvedValue(buildProject({ description: null }));
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const editItem = findPressableByAccessibilityLabel(renderer.root, 'Edit description');
    await clickMenuItemAndFlush(editItem);

    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Project description'
    );
    await act(async () => {
      input.props.onChangeText('   ');
    });
    await act(async () => {
      input.props.onBlur();
      await Promise.resolve();
    });

    expect(updateProject).toHaveBeenCalledWith('p1', { description: null });
  });

  it('does NOT call updateProject when the description is unchanged', async () => {
    const project = buildProject({ description: 'Same description.' });
    const updateProject = jest.fn();
    const renderer = await renderRow(project, buildProjects({ updateProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const editItem = findPressableByAccessibilityLabel(renderer.root, 'Edit description');
    await clickMenuItemAndFlush(editItem);

    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === 'Project description'
    );
    await act(async () => {
      input.props.onBlur();
      await Promise.resolve();
    });

    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe('ProjectRow — Delete regression (Frontend/Platform Milestone 3.2.2 Part F)', () => {
  it('Delete project still works exactly as before on native (Alert.alert, confirm button)', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const deleteProject = jest.fn();
    const project = buildProject();
    const renderer = await renderRow(project, buildProjects({ deleteProject }));

    await openMenu(renderer, 'AI Literacy Study');
    const deleteItem = findPressableByAccessibilityLabel(renderer.root, 'Delete project');
    await act(async () => {
      deleteItem.props.onPress();
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalled();
    const buttons = alertSpy.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    const confirmButton = buttons.find((b) => b.text === 'Delete')!;
    confirmButton.onPress!();

    expect(deleteProject).toHaveBeenCalledWith('p1');
    alertSpy.mockRestore();
  });
});
