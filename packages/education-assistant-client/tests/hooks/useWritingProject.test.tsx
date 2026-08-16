import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWritingProject } from '../../src/hooks/useWritingProject';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProject } from '../../src/types/writing';

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

const AUTOSAVE_DELAY_MS = 500;

describe('useWritingProject', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the project on mount, seeding content from main_tex_content', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const client = { getWritingProject } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));

    await waitFor(() => expect(result.current.loadState.status).toBe('success'));
    expect(result.current.content).toBe('\\documentclass{article}');
    expect(result.current.saveStatus).toBe('idle');
    expect(getWritingProject).toHaveBeenCalledWith('w1');
  });

  it('reload() failure produces an error loadState', async () => {
    const getWritingProject = vi.fn().mockRejectedValue(new Error('boom'));
    const client = { getWritingProject } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));

    await waitFor(() => expect(result.current.loadState.status).toBe('error'));
  });

  it('setContent() marks the buffer "editing" immediately without issuing a request', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi.fn().mockResolvedValue(makeProject());
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('\\section{Intro}');
    });

    expect(result.current.content).toBe('\\section{Intro}');
    expect(result.current.saveStatus).toBe('editing');
    expect(updateWritingProject).not.toHaveBeenCalled();
  });

  it('debounces rapid typing into exactly one PATCH with the latest content', async () => {
    vi.useFakeTimers();
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi
      .fn()
      .mockResolvedValue(makeProject({ main_tex_content: '\\section{Introduction}' }));
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await vi.waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('\\section{I}');
    });
    await vi.advanceTimersByTimeAsync(100);
    act(() => {
      result.current.setContent('\\section{In}');
    });
    await vi.advanceTimersByTimeAsync(100);
    act(() => {
      result.current.setContent('\\section{Introduction}');
    });

    expect(updateWritingProject).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    await vi.waitFor(() => expect(result.current.saveStatus).toBe('saved'));

    expect(updateWritingProject).toHaveBeenCalledTimes(1);
    expect(updateWritingProject).toHaveBeenCalledWith('w1', {
      mainTexContent: '\\section{Introduction}',
    });
  });

  it('an edit made while a save is already in flight is saved by a follow-up request, never lost', async () => {
    vi.useFakeTimers();
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    let resolveFirstSave: ((project: WritingProject) => void) | undefined;
    const updateWritingProject = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WritingProject>((resolve) => {
            resolveFirstSave = resolve;
          })
      )
      .mockImplementationOnce((_id: string, body: { mainTexContent?: string }) =>
        Promise.resolve(makeProject({ main_tex_content: body.mainTexContent }))
      );
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await vi.waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('first edit');
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    await vi.waitFor(() => expect(result.current.saveStatus).toBe('saving'));
    expect(updateWritingProject).toHaveBeenCalledTimes(1);

    // A second edit arrives while the first save is still in flight.
    act(() => {
      result.current.setContent('second edit');
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    // The debounced timer fired, but the save loop is already running for
    // this hook instance — ensureSaving() dedupes to the same in-flight
    // promise rather than firing a second, overlapping request.
    expect(updateWritingProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstSave?.(makeProject({ main_tex_content: 'first edit' }));
    });

    // The loop notices the buffer ('second edit') no longer matches what
    // was just saved ('first edit') and immediately fires the follow-up
    // request with the latest content — no lost edit.
    await vi.waitFor(() => expect(updateWritingProject).toHaveBeenCalledTimes(2));
    expect(updateWritingProject).toHaveBeenLastCalledWith('w1', {
      mainTexContent: 'second edit',
    });
    await vi.waitFor(() => expect(result.current.saveStatus).toBe('saved'));
  });

  it('flush() saves immediately without waiting for the debounce delay', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi
      .fn()
      .mockResolvedValue(makeProject({ main_tex_content: 'flushed content' }));
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProject(client, 'w1', { autosaveDelayMs: 60_000 })
    );
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('flushed content');
    });
    await act(() => result.current.flush());

    expect(updateWritingProject).toHaveBeenCalledWith('w1', { mainTexContent: 'flushed content' });
    expect(result.current.saveStatus).toBe('saved');
  });

  it('flush() is a no-op when there is nothing unsaved', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi.fn().mockResolvedValue(makeProject());
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    await act(() => result.current.flush());

    expect(updateWritingProject).not.toHaveBeenCalled();
  });

  it('setContent() reverting to the last-saved value cancels the pending save and reports "saved"', async () => {
    vi.useFakeTimers();
    const getWritingProject = vi.fn().mockResolvedValue(makeProject({ main_tex_content: 'orig' }));
    const updateWritingProject = vi.fn().mockResolvedValue(makeProject());
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await vi.waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('changed');
    });
    expect(result.current.saveStatus).toBe('editing');

    act(() => {
      result.current.setContent('orig');
    });
    expect(result.current.saveStatus).toBe('saved');

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(updateWritingProject).not.toHaveBeenCalled();
  });

  it('a save failure surfaces saveStatus "error" with the underlying error', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi.fn().mockRejectedValue(new Error('network down'));
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.setContent('bad edit');
    });
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow();
    });

    expect(result.current.saveStatus).toBe('error');
    expect(result.current.saveError).not.toBeNull();
  });

  it('renameProject() PATCHes only the fields present and updates the loaded project', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const updateWritingProject = vi.fn().mockResolvedValue(makeProject({ title: 'New Title' }));
    const client = {
      getWritingProject,
      updateWritingProject,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    await act(() => result.current.renameProject({ title: 'New Title' }));

    expect(updateWritingProject).toHaveBeenCalledWith('w1', { title: 'New Title' });
    expect(result.current.project?.title).toBe('New Title');
  });

  it('loadReferences() transitions loading -> success with the returned references', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const listWritingProjectReferences = vi.fn().mockResolvedValue({
      references: [{ document_id: 'd1' }],
      total: 1,
      missing_citation_keys: [],
    });
    const client = {
      getWritingProject,
      listWritingProjectReferences,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.loadReferences();
    });
    expect(result.current.referencesState.status).toBe('loading');

    await waitFor(() => expect(result.current.referencesState.status).toBe('success'));
    const state = result.current.referencesState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.data.total).toBe(1);
  });

  it('addReferences() adds then reloads the reference list', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const addWritingProjectReferences = vi
      .fn()
      .mockResolvedValue({ results: [{ document_id: 'd1', outcome: 'added' }] });
    const listWritingProjectReferences = vi
      .fn()
      .mockResolvedValue({ references: [{ document_id: 'd1' }], total: 1, missing_citation_keys: [] });
    const client = {
      getWritingProject,
      addWritingProjectReferences,
      listWritingProjectReferences,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    await act(() => result.current.addReferences(['d1']));

    expect(addWritingProjectReferences).toHaveBeenCalledWith('w1', ['d1']);
    await waitFor(() => expect(result.current.referencesState.status).toBe('success'));
  });

  it('removeReference() removes then reloads the reference list', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const removeWritingProjectReference = vi.fn().mockResolvedValue(undefined);
    const listWritingProjectReferences = vi
      .fn()
      .mockResolvedValue({ references: [], total: 0, missing_citation_keys: [] });
    const client = {
      getWritingProject,
      removeWritingProjectReference,
      listWritingProjectReferences,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    await act(() => result.current.removeReference('d1'));

    expect(removeWritingProjectReference).toHaveBeenCalledWith('w1', 'd1');
    await waitFor(() => expect(result.current.referencesState.status).toBe('success'));
  });

  it('loadBibliography() transitions loading -> success with the returned bibtex', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const getWritingProjectBibliography = vi
      .fn()
      .mockResolvedValue({ bibtex: '@article{Doe2020,\n}\n', reference_count: 1 });
    const client = {
      getWritingProject,
      getWritingProjectBibliography,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    act(() => {
      result.current.loadBibliography();
    });
    expect(result.current.bibliographyState.status).toBe('loading');

    await waitFor(() => expect(result.current.bibliographyState.status).toBe('success'));
    const state = result.current.bibliographyState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.data.reference_count).toBe(1);
  });

  it('exportProject() delegates to the client and returns the Blob', async () => {
    const getWritingProject = vi.fn().mockResolvedValue(makeProject());
    const blob = new Blob(['zip-bytes']);
    const fetchWritingProjectExportBlob = vi.fn().mockResolvedValue(blob);
    const client = {
      getWritingProject,
      fetchWritingProjectExportBlob,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProject(client, 'w1'));
    await waitFor(() => expect(result.current.loadState.status).toBe('success'));

    const exported = await act(() => result.current.exportProject());

    expect(fetchWritingProjectExportBlob).toHaveBeenCalledWith('w1');
    expect(exported).toBe(blob);
  });

  describe('compileProject()', () => {
    function makeCompileResponse(overrides: Record<string, unknown> = {}) {
      return {
        status: 'success',
        diagnostics: [],
        log_excerpt: '',
        duration_ms: 100,
        page_count: 1,
        compile_id: 'c1',
        pdf_size_bytes: 4096,
        source_hash: 'hash1',
        ...overrides,
      };
    }

    it('flushes any pending edit BEFORE compiling — the save completes first', async () => {
      vi.useFakeTimers();
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const updateWritingProject = vi
        .fn()
        .mockResolvedValue(makeProject({ main_tex_content: '\\section{New}' }));
      const compileWritingProject = vi.fn().mockResolvedValue(makeCompileResponse());
      const client = {
        getWritingProject,
        updateWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() =>
        useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
      );
      await vi.waitFor(() => expect(result.current.loadState.status).toBe('success'));

      act(() => {
        result.current.setContent('\\section{New}');
      });
      // Compile is called immediately, well before the debounce would
      // normally fire — flush() must save synchronously-in-effect first.
      await act(() => result.current.compileProject());

      expect(updateWritingProject).toHaveBeenCalledWith('w1', { mainTexContent: '\\section{New}' });
      expect(compileWritingProject).toHaveBeenCalledWith('w1');
      // The save happened (verifiable via call order): updateWritingProject
      // was invoked before compileWritingProject.
      const updateOrder = updateWritingProject.mock.invocationCallOrder[0]!;
      const compileOrder = compileWritingProject.mock.invocationCallOrder[0]!;
      expect(updateOrder).toBeLessThan(compileOrder);
    });

    it('never compiles if the flush/save fails', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const updateWritingProject = vi.fn().mockRejectedValue(new Error('save failed'));
      const compileWritingProject = vi.fn().mockResolvedValue(makeCompileResponse());
      const client = {
        getWritingProject,
        updateWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() =>
        useWritingProject(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
      );
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      act(() => {
        result.current.setContent('\\section{New}');
      });
      await expect(act(() => result.current.compileProject())).rejects.toThrow();

      expect(compileWritingProject).not.toHaveBeenCalled();
    });

    it('is a no-op flush (compiles immediately) when nothing is unsaved', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const updateWritingProject = vi.fn();
      const compileWritingProject = vi.fn().mockResolvedValue(makeCompileResponse());
      const client = {
        getWritingProject,
        updateWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() => useWritingProject(client, 'w1'));
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      await act(() => result.current.compileProject());

      expect(updateWritingProject).not.toHaveBeenCalled();
      expect(compileWritingProject).toHaveBeenCalledWith('w1');
    });

    it('sets compileState to "compiling" then "result" on success', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      let resolveCompile: (value: unknown) => void = () => {};
      const compileWritingProject = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveCompile = resolve;
        })
      );
      const client = {
        getWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() => useWritingProject(client, 'w1'));
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      let compilePromise!: Promise<unknown>;
      act(() => {
        compilePromise = result.current.compileProject();
      });
      await waitFor(() => expect(result.current.compileState.status).toBe('compiling'));

      await act(async () => {
        resolveCompile(makeCompileResponse());
        await compilePromise;
      });

      expect(result.current.compileState.status).toBe('result');
      if (result.current.compileState.status === 'result') {
        expect(result.current.compileState.data.compile_id).toBe('c1');
      }
    });

    it('a "busy"/"timeout"/"error" backend status lands in compileState.result as an ordinary value, not an exception', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const compileWritingProject = vi
        .fn()
        .mockResolvedValue(makeCompileResponse({ status: 'busy', compile_id: null }));
      const client = {
        getWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() => useWritingProject(client, 'w1'));
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      const response = await act(() => result.current.compileProject());

      expect(response.status).toBe('busy');
      expect(result.current.compileState.status).toBe('result');
    });

    it('a transport/ownership failure (rejected promise) sets compileState to "error"', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const compileWritingProject = vi.fn().mockRejectedValue(new Error('network down'));
      const client = {
        getWritingProject,
        compileWritingProject,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() => useWritingProject(client, 'w1'));
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.compileProject();
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(Error);
      expect(result.current.compileState.status).toBe('error');
    });
  });

  describe('fetchCompiledPdf()', () => {
    it('delegates to the client with the project id and compile id', async () => {
      const getWritingProject = vi.fn().mockResolvedValue(makeProject());
      const blob = new Blob(['pdf-bytes']);
      const fetchCompiledPdfBlob = vi.fn().mockResolvedValue(blob);
      const client = {
        getWritingProject,
        fetchCompiledPdfBlob,
      } as unknown as EducationAssistantClient;
      const { result } = renderHook(() => useWritingProject(client, 'w1'));
      await waitFor(() => expect(result.current.loadState.status).toBe('success'));

      const pdf = await act(() => result.current.fetchCompiledPdf('c1'));

      expect(fetchCompiledPdfBlob).toHaveBeenCalledWith('w1', 'c1');
      expect(pdf).toBe(blob);
    });
  });
});
