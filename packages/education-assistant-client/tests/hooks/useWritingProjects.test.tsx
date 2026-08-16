import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWritingProjects } from '../../src/hooks/useWritingProjects';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProject, WritingProjectSummary } from '../../src/types/writing';

function makeSummary(overrides: Partial<WritingProjectSummary> = {}): WritingProjectSummary {
  return {
    id: 'w1',
    title: 'My Paper',
    description: null,
    reference_count: 0,
    file_count: 1,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<WritingProject> = {}): WritingProject {
  return {
    id: 'w1',
    title: 'My Paper',
    description: null,
    main_tex_content: '\\documentclass{article}',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useWritingProjects', () => {
  it('refresh() transitions loading -> success with the returned projects', async () => {
    const listWritingProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeSummary()], total: 1 });
    const client = { listWritingProjects } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

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
    const listWritingProjects = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listWritingProjects } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(result.current.listState.status).toBe('error'));
  });

  it('createProject() prepends the new project (as a summary, reference_count 0) to an already-loaded list', async () => {
    const listWritingProjects = vi.fn().mockResolvedValue({ projects: [], total: 0 });
    const createWritingProject = vi.fn().mockResolvedValue(makeProject({ id: 'new-id' }));
    const client = {
      listWritingProjects,
      createWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    const created = await act(() => result.current.createProject({ title: 'My Paper' }));

    expect(created.id).toBe('new-id');
    expect(created.reference_count).toBe(0);
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects[0]!.id).toBe('new-id');
    expect(state.total).toBe(1);
  });

  it('deleteProject() removes the entry from listState on success', async () => {
    const listWritingProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeSummary({ id: 'w1' })], total: 1 });
    const deleteWritingProject = vi.fn().mockResolvedValue(undefined);
    const client = {
      listWritingProjects,
      deleteWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteProject('w1');
    });
    expect(result.current.deleteStates['w1']?.status).toBe('deleting');

    await waitFor(() => expect(result.current.deleteStates['w1']?.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects).toHaveLength(0);
    expect(state.total).toBe(0);
  });

  it('deleteProject() ignores a second call while the first is still in flight', async () => {
    let resolveDelete: () => void = () => {};
    const deleteWritingProject = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        })
    );
    const client = {
      listWritingProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      deleteWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.deleteProject('w1');
      result.current.deleteProject('w1');
    });

    expect(deleteWritingProject).toHaveBeenCalledTimes(1);
    resolveDelete();
    await waitFor(() => expect(result.current.deleteStates['w1']?.status).toBe('success'));
  });

  it('deleteProject() failure surfaces an error state, keeping the entry in listState', async () => {
    const listWritingProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeSummary({ id: 'w1' })], total: 1 });
    const deleteWritingProject = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      listWritingProjects,
      deleteWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.deleteProject('w1');
    });

    await waitFor(() => expect(result.current.deleteStates['w1']?.status).toBe('error'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects).toHaveLength(1);
  });

  it('resetDeleteState() clears a project’s delete state entry', async () => {
    const deleteWritingProject = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      listWritingProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      deleteWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.deleteProject('w1');
    });
    await waitFor(() => expect(result.current.deleteStates['w1']?.status).toBe('error'));

    act(() => {
      result.current.resetDeleteState('w1');
    });
    expect(result.current.deleteStates['w1']).toBeUndefined();
  });

  it('refresh() passes the current search/sort/archived filters to listWritingProjects', async () => {
    const listWritingProjects = vi.fn().mockResolvedValue({ projects: [], total: 0 });
    const client = { listWritingProjects } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.setSearch('climate');
      result.current.setSort('name');
      result.current.setShowArchived(true);
    });
    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(listWritingProjects).toHaveBeenCalled());
    expect(listWritingProjects).toHaveBeenCalledWith(
      { q: 'climate', sort: 'name', archived: true },
      expect.objectContaining({ signal: expect.anything() })
    );
  });

  it('archiveProject() removes the project from the active list on success', async () => {
    const listWritingProjects = vi
      .fn()
      .mockResolvedValue({ projects: [makeSummary({ id: 'w1' })], total: 1 });
    const archiveWritingProject = vi.fn().mockResolvedValue(makeProject({ id: 'w1' }));
    const client = {
      listWritingProjects,
      archiveWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.archiveProject('w1');
    });
    await waitFor(() => expect(result.current.archiveStates['w1']?.status).toBe('success'));
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects).toHaveLength(0);
  });

  it('restoreProject() calls the client and reports success', async () => {
    const restoreWritingProject = vi.fn().mockResolvedValue(makeProject({ id: 'w1' }));
    const client = {
      listWritingProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      restoreWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.restoreProject('w1');
    });
    await waitFor(() => expect(result.current.archiveStates['w1']?.status).toBe('success'));
    expect(restoreWritingProject).toHaveBeenCalledWith('w1');
  });

  it('duplicateProject() prepends the new copy to an already-loaded list', async () => {
    const listWritingProjects = vi.fn().mockResolvedValue({ projects: [], total: 0 });
    const duplicateWritingProject = vi
      .fn()
      .mockResolvedValue(makeProject({ id: 'w2', title: 'My Paper (copy)' }));
    const client = {
      listWritingProjects,
      duplicateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    const copy = await act(() => result.current.duplicateProject('w1'));
    expect(copy.id).toBe('w2');
    const state = result.current.listState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.projects[0]!.id).toBe('w2');
    expect(state.total).toBe(1);
  });

  it('duplicateProject() surfaces a failure via duplicateStates and rejects', async () => {
    const duplicateWritingProject = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      listWritingProjects: vi.fn().mockResolvedValue({ projects: [], total: 0 }),
      duplicateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjects(client));

    let caught: unknown;
    act(() => {
      result.current.duplicateProject('w1').catch((error: unknown) => {
        caught = error;
      });
    });

    await waitFor(() => expect(result.current.duplicateStates['w1']?.status).toBe('error'));
    expect((caught as Error)?.message).toBe('boom');
  });
});
