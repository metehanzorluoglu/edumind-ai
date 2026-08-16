import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWritingTemplates } from '../../src/hooks/useWritingTemplates';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProject } from '../../src/types/writing';
import type { WritingTemplateDetail, WritingTemplateSummary } from '../../src/types/writingTemplates';

function makeSummary(overrides: Partial<WritingTemplateSummary> = {}): WritingTemplateSummary {
  return {
    id: 'blank-article',
    name: 'Blank Article',
    description: 'A minimal starting point.',
    category: 'Article',
    license: 'EduM8-authored',
    source: 'EduM8',
    version: 1,
    file_count: 1,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<WritingTemplateDetail> = {}): WritingTemplateDetail {
  return {
    ...makeSummary(),
    root: 'main.tex',
    files: [{ path: 'main.tex', kind: 'text' }],
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

describe('useWritingTemplates', () => {
  it('refresh() transitions loading -> success with the returned templates', async () => {
    const listWritingTemplates = vi.fn().mockResolvedValue({ templates: [makeSummary()], total: 1 });
    const client = { listWritingTemplates } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.refresh();
    });
    expect(result.current.listState.status).toBe('loading');

    await waitFor(() => expect(result.current.listState.status).toBe('success'));
    expect(result.current.visibleTemplates).toHaveLength(1);
  });

  it('refresh() failure produces an error state', async () => {
    const listWritingTemplates = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { listWritingTemplates } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('error'));
  });

  it('visibleTemplates applies client-side search across name/description', async () => {
    const listWritingTemplates = vi.fn().mockResolvedValue({
      templates: [
        makeSummary({ id: 'blank-article', name: 'Blank Article', description: 'minimal' }),
        makeSummary({ id: 'thesis-starter', name: 'Thesis Starter', description: 'chapters' }),
      ],
      total: 2,
    });
    const client = { listWritingTemplates } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.setSearch('thesis');
    });
    expect(result.current.visibleTemplates.map((t) => t.id)).toEqual(['thesis-starter']);
  });

  it('visibleTemplates applies the category filter', async () => {
    const listWritingTemplates = vi.fn().mockResolvedValue({
      templates: [
        makeSummary({ id: 'blank-article', category: 'Article' }),
        makeSummary({ id: 'research-proposal', category: 'Research Proposal' }),
      ],
      total: 2,
    });
    const client = { listWritingTemplates } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    expect(result.current.categories).toEqual(['Article', 'Research Proposal']);

    act(() => {
      result.current.setCategory('Research Proposal');
    });
    expect(result.current.visibleTemplates.map((t) => t.id)).toEqual(['research-proposal']);
  });

  it('search and category filters combine (both must match)', async () => {
    const listWritingTemplates = vi.fn().mockResolvedValue({
      templates: [
        makeSummary({ id: 'a', name: 'Alpha', category: 'Article' }),
        makeSummary({ id: 'b', name: 'Alpha Two', category: 'Report' }),
      ],
      total: 2,
    });
    const client = { listWritingTemplates } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.listState.status).toBe('success'));

    act(() => {
      result.current.setSearch('alpha');
      result.current.setCategory('Report');
    });
    expect(result.current.visibleTemplates.map((t) => t.id)).toEqual(['b']);
  });

  it('loadDetail() populates detailState; clearDetail() resets it', async () => {
    const getWritingTemplate = vi.fn().mockResolvedValue(makeDetail());
    const client = {
      listWritingTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
      getWritingTemplate,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    act(() => {
      result.current.loadDetail('blank-article');
    });
    expect(result.current.detailState.status).toBe('loading');

    await waitFor(() => expect(result.current.detailState.status).toBe('success'));
    const state = result.current.detailState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.template.root).toBe('main.tex');

    act(() => {
      result.current.clearDetail();
    });
    expect(result.current.detailState.status).toBe('idle');
  });

  it('createFromTemplate() resolves with the new project and resets createState', async () => {
    const createWritingProjectFromTemplate = vi.fn().mockResolvedValue(makeProject({ id: 'new-id' }));
    const client = {
      listWritingTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
      createWritingProjectFromTemplate,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    const project = await act(() =>
      result.current.createFromTemplate('blank-article', { title: 'My Paper' })
    );

    expect(project.id).toBe('new-id');
    expect(createWritingProjectFromTemplate).toHaveBeenCalledWith('blank-article', {
      title: 'My Paper',
    });
    expect(result.current.createState.status).toBe('idle');
  });

  it('createFromTemplate() surfaces a failure via createState and rejects', async () => {
    const createWritingProjectFromTemplate = vi.fn().mockRejectedValue(new Error('boom'));
    const client = {
      listWritingTemplates: vi.fn().mockResolvedValue({ templates: [], total: 0 }),
      createWritingProjectFromTemplate,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingTemplates(client));

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.createFromTemplate('blank-article', { title: 'X' });
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error)?.message).toBe('boom');
    expect(result.current.createState.status).toBe('error');
  });
});
