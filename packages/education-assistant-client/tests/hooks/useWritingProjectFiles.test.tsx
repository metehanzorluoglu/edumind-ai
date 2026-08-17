import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWritingProjectFiles } from '../../src/hooks/useWritingProjectFiles';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { WritingProjectFileNode, WritingProjectFileTree } from '../../src/types/writing';

const AUTOSAVE_DELAY_MS = 300;

function makeNode(overrides: Partial<WritingProjectFileNode> = {}): WritingProjectFileNode {
  return {
    id: 'root-file',
    parent_id: null,
    kind: 'text',
    name: 'main.tex',
    path: 'main.tex',
    mime_type: null,
    size_bytes: 10,
    is_root: true,
    ...overrides,
  };
}

function makeTree(overrides: Partial<WritingProjectFileTree> = {}): WritingProjectFileTree {
  return {
    files: [makeNode()],
    generated: [{ name: 'references.bib', path: 'references.bib', read_only: true, reference_count: 0 }],
    root_file_id: 'root-file',
    total_size_bytes: 10,
    file_count: 1,
    max_files: 150,
    max_total_bytes: 100_000_000,
    ...overrides,
  };
}

describe('useWritingProjectFiles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads the tree on mount and auto-opens the root file', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(makeTree());
    const getWritingProjectFileContent = vi.fn().mockResolvedValue({
      file: makeNode(),
      content_text: '\\documentclass{article}',
    });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));

    await waitFor(() => expect(result.current.treeState.status).toBe('success'));
    await waitFor(() => expect(result.current.activeFileLoadState.status).toBe('success'));
    expect(result.current.activeFileId).toBe('root-file');
    expect(result.current.activeFileContent).toBe('\\documentclass{article}');
    expect(getWritingProjectFileContent).toHaveBeenCalledWith('w1', 'root-file');
  });

  it('Milestone 5.5.1 Part 25 — initialFileId opens that file instead of root, when it is a real text file in the tree', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(
      makeTree({
        files: [makeNode(), makeNode({ id: 'other', name: 'notes.tex', path: 'notes.tex', is_root: false })],
      })
    );
    const getWritingProjectFileContent = vi.fn().mockResolvedValue({
      file: makeNode({ id: 'other', name: 'notes.tex' }),
      content_text: 'remembered file content',
    });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProjectFiles(client, 'w1', { initialFileId: 'other' })
    );

    await waitFor(() => expect(result.current.treeState.status).toBe('success'));
    await waitFor(() => expect(result.current.activeFileLoadState.status).toBe('success'));
    expect(result.current.activeFileId).toBe('other');
    expect(getWritingProjectFileContent).toHaveBeenCalledWith('w1', 'other');
  });

  it('Milestone 5.5.1 Part 25 — an initialFileId that no longer exists in the tree falls back to root, exactly like having none', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(makeTree());
    const getWritingProjectFileContent = vi.fn().mockResolvedValue({
      file: makeNode(),
      content_text: '\\documentclass{article}',
    });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProjectFiles(client, 'w1', { initialFileId: 'deleted-file-id' })
    );

    await waitFor(() => expect(result.current.treeState.status).toBe('success'));
    await waitFor(() => expect(result.current.activeFileLoadState.status).toBe('success'));
    expect(result.current.activeFileId).toBe('root-file');
  });

  it('openFile() flushes the current file before loading the new one', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(
      makeTree({
        files: [makeNode(), makeNode({ id: 'other', name: 'notes.tex', path: 'notes.tex', is_root: false })],
      })
    );
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValueOnce({ file: makeNode(), content_text: 'root content' })
      .mockResolvedValueOnce({
        file: makeNode({ id: 'other', name: 'notes.tex' }),
        content_text: 'other content',
      });
    const updateWritingProjectFileContent = vi.fn().mockResolvedValue({ file: makeNode() });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      updateWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProjectFiles(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await waitFor(() => expect(result.current.activeFileId).toBe('root-file'));

    act(() => {
      result.current.setActiveFileContent('edited root content');
    });
    expect(result.current.activeFileSaveStatus).toBe('editing');

    await act(async () => {
      await result.current.openFile('other');
    });

    // The pending edit to the root file was flushed BEFORE switching.
    expect(updateWritingProjectFileContent).toHaveBeenCalledWith('w1', 'root-file', {
      contentText: 'edited root content',
    });
    expect(result.current.activeFileId).toBe('other');
    expect(result.current.activeFileContent).toBe('other content');
  });

  it('setActiveFileContent() debounces a PATCH to the active file', async () => {
    vi.useFakeTimers();
    const listWritingProjectFiles = vi.fn().mockResolvedValue(makeTree());
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValue({ file: makeNode(), content_text: 'original' });
    const updateWritingProjectFileContent = vi.fn().mockResolvedValue({ file: makeNode() });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      updateWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() =>
      useWritingProjectFiles(client, 'w1', { autosaveDelayMs: AUTOSAVE_DELAY_MS })
    );
    await vi.waitFor(() => expect(result.current.activeFileId).toBe('root-file'));

    act(() => {
      result.current.setActiveFileContent('new content');
    });
    expect(updateWritingProjectFileContent).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 50);
      await Promise.resolve();
    });
    expect(updateWritingProjectFileContent).toHaveBeenCalledWith('w1', 'root-file', {
      contentText: 'new content',
    });
    vi.useRealTimers();
  });

  it('flushActiveFile() is a no-op when there is nothing unsaved', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(makeTree());
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValue({ file: makeNode(), content_text: 'original' });
    const updateWritingProjectFileContent = vi.fn();
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      updateWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));
    await waitFor(() => expect(result.current.activeFileId).toBe('root-file'));

    await act(() => result.current.flushActiveFile());
    expect(updateWritingProjectFileContent).not.toHaveBeenCalled();
  });

  it('createFolder() calls the client and refreshes the tree', async () => {
    const listWritingProjectFiles = vi
      .fn()
      .mockResolvedValueOnce(makeTree())
      .mockResolvedValueOnce(
        makeTree({
          files: [makeNode(), makeNode({ id: 'f2', kind: 'folder', name: 'sections', path: 'sections', is_root: false })],
        })
      );
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValue({ file: makeNode(), content_text: '' });
    const createWritingProjectFolder = vi
      .fn()
      .mockResolvedValue({ file: makeNode({ id: 'f2', kind: 'folder', name: 'sections', path: 'sections' }) });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      createWritingProjectFolder,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));
    await waitFor(() => expect(result.current.treeState.status).toBe('success'));

    const created = await act(() => result.current.createFolder({ name: 'sections' }));
    expect(created.name).toBe('sections');
    expect(createWritingProjectFolder).toHaveBeenCalledWith('w1', { name: 'sections' });
    await waitFor(() =>
      expect(
        result.current.treeState.status === 'success' &&
          result.current.treeState.data.files.some((f) => f.id === 'f2')
      ).toBe(true)
    );
  });

  it('deleteFile() clears activeFileId when the deleted (non-root) file was active', async () => {
    // Deletes a SECONDARY file, never the root — the root file can never
    // actually be deleted (Part 16; the backend 409s), so this is the
    // only realistic "deleted the currently-open file" scenario. The
    // tree the second listWritingProjectFiles() call returns reflects
    // the file's real removal, exactly like the backend would.
    const treeBeforeDelete = makeTree({
      files: [makeNode(), makeNode({ id: 'other', name: 'notes.tex', path: 'notes.tex', is_root: false })],
    });
    const listWritingProjectFiles = vi
      .fn()
      .mockResolvedValueOnce(treeBeforeDelete)
      .mockResolvedValueOnce(makeTree());
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValueOnce({ file: makeNode(), content_text: 'root' })
      .mockResolvedValueOnce({ file: makeNode({ id: 'other' }), content_text: 'x' })
      .mockResolvedValueOnce({ file: makeNode(), content_text: 'root' });
    const deleteWritingProjectFile = vi.fn().mockResolvedValue(undefined);
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      deleteWritingProjectFile,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));
    await waitFor(() => expect(result.current.activeFileId).toBe('root-file'));

    await act(() => result.current.openFile('other'));
    expect(result.current.activeFileId).toBe('other');

    await act(() => result.current.deleteFile('other'));
    expect(deleteWritingProjectFile).toHaveBeenCalledWith('w1', 'other');
    // Falls back to the project's root file rather than staying blank
    // (see deleteFile's own docstring) — the tree refresh triggered by
    // the delete resolves to a tree that no longer has 'other', and the
    // hook's own "default to root" effect re-selects root-file.
    await waitFor(() => expect(result.current.activeFileId).toBe('root-file'));
    expect(result.current.activeFileContent).toBe('root');
  });

  it('setRootFile() calls the client and refreshes the tree', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(makeTree());
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValue({ file: makeNode(), content_text: 'x' });
    const setWritingProjectRootFile = vi.fn().mockResolvedValue({ file: makeNode({ id: 'other' }) });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
      setWritingProjectRootFile,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));
    await waitFor(() => expect(result.current.treeState.status).toBe('success'));

    await act(() => result.current.setRootFile('other'));
    expect(setWritingProjectRootFile).toHaveBeenCalledWith('w1', 'other');
    expect(listWritingProjectFiles).toHaveBeenCalledTimes(2);
  });

  it('rejects opening a folder as an editable file', async () => {
    const listWritingProjectFiles = vi.fn().mockResolvedValue(
      makeTree({ files: [makeNode(), makeNode({ id: 'folder-1', kind: 'folder', name: 'sections', is_root: false })] })
    );
    const getWritingProjectFileContent = vi
      .fn()
      .mockResolvedValueOnce({ file: makeNode(), content_text: 'x' })
      .mockResolvedValueOnce({ file: makeNode({ id: 'folder-1', kind: 'folder' }), content_text: null });
    const client = {
      listWritingProjectFiles,
      getWritingProjectFileContent,
    } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useWritingProjectFiles(client, 'w1'));
    await waitFor(() => expect(result.current.activeFileId).toBe('root-file'));

    await act(() => result.current.openFile('folder-1'));
    expect(result.current.activeFileLoadState.status).toBe('error');
  });
});
