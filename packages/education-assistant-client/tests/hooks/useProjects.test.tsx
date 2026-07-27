import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProjects } from '../../src/hooks/useProjects';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { ProjectConversation, ProjectSummary } from '../../src/types/projects';

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p1',
    name: 'AI Literacy Research',
    description: null,
    conversation_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProjectConversation(
  overrides: Partial<ProjectConversation> = {}
): ProjectConversation {
  return {
    conversation_id: 'c1',
    title: 'A chat',
    added_at: '2026-01-01T00:00:00Z',
    sort_order: null,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useProjects', () => {
  it('refresh() transitions loading -> success with the returned projects', async () => {
    const listProjects = vi.fn().mockResolvedValue({ projects: [makeProject()], total: 1 });
    const client = { listProjects } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });
    expect(result.current.listState.status).toBe('loading');

    await waitFor(() => expect(result.current.listState.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects).toHaveLength(1);
    expect(state.total).toBe(1);
  });

  it('refresh() failure produces an error state', async () => {
    const listProjects = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listProjects } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.listState.status).toBe('error'));
  });

  it('createProject() prepends the new project to an already-loaded list', async () => {
    const listProjects = vi.fn().mockResolvedValue({ projects: [], total: 0 });
    const createProject = vi.fn().mockResolvedValue(makeProject({ id: 'new-id' }));
    const client = { listProjects, createProject } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    const created = await act(() =>
      result.current.createProject({ name: 'AI Literacy Research' })
    );

    expect(created.id).toBe('new-id');
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects[0]!.id).toBe('new-id');
    expect(state.total).toBe(1);
  });

  it('updateProject() patches the matching entry in an already-loaded list', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeProject({ id: 'p1', name: 'Old' })], total: 1 });
    const updateProject = vi.fn().mockResolvedValue(makeProject({ id: 'p1', name: 'New' }));
    const client = { listProjects, updateProject } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    await act(() => result.current.updateProject('p1', { name: 'New' }));

    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects[0]!.name).toBe('New');
  });

  it('deleteProject() removes the entry from listState on success, preserving nothing else', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeProject({ id: 'p1' })], total: 1 });
    const deleteProject = vi.fn().mockResolvedValue(undefined);
    const client = { listProjects, deleteProject } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteProject('p1');
    });
    expect(result.current.deleteStates['p1']?.status).toBe('deleting');

    await waitFor(() => expect(result.current.deleteStates['p1']?.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects).toHaveLength(0);
    expect(state.total).toBe(0);
  });

  it('deleteProject() ignores a second call while the first is still in flight', async () => {
    let resolveDelete: () => void = () => {};
    const deleteProject = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      deleteProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.deleteProject('p1');
      result.current.deleteProject('p1');
    });

    expect(deleteProject).toHaveBeenCalledTimes(1);
    resolveDelete();
    await waitFor(() => expect(result.current.deleteStates['p1']?.status).toBe('success'));
  });

  it('loadProjectConversations() transitions loading -> success for that project only', async () => {
    const listProjectConversations = vi
      .fn()
      .mockResolvedValue({ conversations: [makeProjectConversation()], total: 1 });
    const client = { listProjectConversations } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.loadProjectConversations('p1');
    });
    expect(result.current.projectConversationsStates['p1']?.status).toBe('loading');
    expect(result.current.projectConversationsStates['p2']).toBeUndefined();

    await waitFor(() =>
      expect(result.current.projectConversationsStates['p1']?.status).toBe('success')
    );
    const state = result.current.projectConversationsStates['p1'];
    if (state?.status !== 'success') throw new Error('expected success');
    expect(state.conversations).toHaveLength(1);
  });

  it('a stale loadProjectConversations() response for one project cannot overwrite a newer one for the same project', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const listProjectConversations = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockImplementationOnce(() =>
        Promise.resolve({ conversations: [makeProjectConversation({ title: 'Second' })], total: 1 })
      );
    const client = { listProjectConversations } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.loadProjectConversations('p1');
    });
    act(() => {
      result.current.loadProjectConversations('p1');
    });

    await waitFor(() =>
      expect(result.current.projectConversationsStates['p1']?.status).toBe('success')
    );
    const afterSecond = result.current.projectConversationsStates['p1'];
    if (afterSecond?.status !== 'success') throw new Error('expected success');
    expect(afterSecond.conversations[0]!.title).toBe('Second');

    await act(async () => {
      resolveFirst?.({ conversations: [makeProjectConversation({ title: 'Stale' })], total: 1 });
    });

    const finalState = result.current.projectConversationsStates['p1'];
    if (finalState?.status !== 'success') throw new Error('expected success');
    expect(finalState.conversations[0]!.title).toBe('Second');
  });

  it('addConversationToProject() bumps conversation_count and marks the add successful', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeProject({ id: 'p1', conversation_count: 0 })], total: 1 });
    const addProjectConversation = vi.fn().mockResolvedValue(makeProjectConversation());
    const client = {
      listProjects,
      addProjectConversation,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    await act(() => result.current.addConversationToProject('p1', 'c1'));

    expect(result.current.addRemoveStates['p1:c1']?.status).toBe('success');
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects[0]!.conversation_count).toBe(1);
  });

  it('removeConversationFromProject() decrements conversation_count and removes it from an already-loaded conversation list', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeProject({ id: 'p1', conversation_count: 1 })], total: 1 });
    const listProjectConversations = vi
      .fn()
      .mockResolvedValue({ conversations: [makeProjectConversation({ conversation_id: 'c1' })], total: 1 });
    const removeProjectConversation = vi.fn().mockResolvedValue(undefined);
    const client = {
      listProjects,
      listProjectConversations,
      removeProjectConversation,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    act(() => {
      result.current.refresh();
      result.current.loadProjectConversations('p1');
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));
    await waitFor(() =>
      expect(result.current.projectConversationsStates['p1']?.status).toBe('success')
    );

    await act(() => result.current.removeConversationFromProject('p1', 'c1'));

    expect(result.current.addRemoveStates['p1:c1']?.status).toBe('success');
    const listStateAfter = result.current.listState;
    if (listStateAfter.status !== 'success') throw new Error('expected success');
    expect(listStateAfter.projects[0]!.conversation_count).toBe(0);
    const conversationsAfter = result.current.projectConversationsStates['p1'];
    if (conversationsAfter?.status !== 'success') throw new Error('expected success');
    expect(conversationsAfter.conversations).toHaveLength(0);
  });

  it('removeConversationFromProject() failure surfaces an error state and rejects', async () => {
    const removeProjectConversation = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      removeProjectConversation,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useProjects(client));

    await act(async () => {
      await expect(result.current.removeConversationFromProject('p1', 'c1')).rejects.toThrow();
    });

    expect(result.current.addRemoveStates['p1:c1']?.status).toBe('error');
  });
});
