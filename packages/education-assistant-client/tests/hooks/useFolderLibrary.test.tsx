import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFolderLibrary } from '../../src/hooks/useFolderLibrary';
import type { EducationAssistantClient } from '../../src/client/EducationAssistantClient';
import type { FolderContentsResponse, FolderResponse } from '../../src/types/folders';

function makeFolder(overrides: Partial<FolderResponse> = {}): FolderResponse {
  return {
    id: 'f1',
    name: 'Research',
    parent_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    folder_count: 0,
    document_count: 0,
    ...overrides,
  };
}

function makeContents(overrides: Partial<FolderContentsResponse> = {}): FolderContentsResponse {
  return {
    folder: null,
    breadcrumbs: [],
    folders: [],
    documents: [],
    documents_total: 0,
    ...overrides,
  };
}

describe('useFolderLibrary', () => {
  it('navigate(null) loads root contents: idle -> loading -> success', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents({ folders: [makeFolder()] }));
    const client = { getFolderContents } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    expect(result.current.contentsState.status).toBe('idle');

    act(() => {
      result.current.navigate(null);
    });
    expect(result.current.contentsState.status).toBe('loading');

    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));
    const state = result.current.contentsState;
    if (state.status !== 'success') throw new Error('expected success');
    expect(state.contents.folders).toHaveLength(1);
    expect(getFolderContents).toHaveBeenCalledWith({ folderId: null }, expect.anything());
    expect(result.current.currentFolderId).toBeNull();
  });

  it('navigate(folderId) requests that folder and updates currentFolderId', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(
      makeContents({ folder: makeFolder(), breadcrumbs: [{ id: 'f1', name: 'Research' }] })
    );
    const client = { getFolderContents } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate('f1');
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    expect(result.current.currentFolderId).toBe('f1');
    expect(getFolderContents).toHaveBeenCalledWith({ folderId: 'f1' }, expect.anything());
  });

  it('a failed load produces an error state', async () => {
    const getFolderContents = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { getFolderContents } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate(null);
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('error'));
  });

  it('createFolder() creates under the currently-open folder and refreshes contents', async () => {
    const getFolderContents = vi
      .fn()
      .mockResolvedValueOnce(makeContents({ folder: makeFolder({ id: 'parent' }) }))
      .mockResolvedValueOnce(
        makeContents({ folder: makeFolder({ id: 'parent' }), folders: [makeFolder({ id: 'child' })] })
      );
    const createFolder = vi.fn().mockResolvedValue(makeFolder({ id: 'child', parent_id: 'parent' }));
    const client = { getFolderContents, createFolder } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate('parent');
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    await act(async () => {
      await result.current.createFolder('Child');
    });

    expect(createFolder).toHaveBeenCalledWith({ name: 'Child', parentId: 'parent' });
    await waitFor(() => {
      const state = result.current.contentsState;
      if (state.status !== 'success') throw new Error('expected success');
      expect(state.contents.folders).toHaveLength(1);
    });
    expect(getFolderContents).toHaveBeenCalledTimes(2);
  });

  it('renameFolder() calls updateFolder with only name and refreshes', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents());
    const updateFolder = vi.fn().mockResolvedValue(makeFolder({ name: 'Renamed' }));
    const client = { getFolderContents, updateFolder } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate(null);
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    await act(async () => {
      await result.current.renameFolder('f1', 'Renamed');
    });

    expect(updateFolder).toHaveBeenCalledWith('f1', { name: 'Renamed' });
    expect(getFolderContents).toHaveBeenCalledTimes(2);
  });

  it('moveFolder() calls updateFolder with parentId (null for root) and refreshes', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents());
    const updateFolder = vi.fn().mockResolvedValue(makeFolder());
    const client = { getFolderContents, updateFolder } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate(null);
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    await act(async () => {
      await result.current.moveFolder('f2', null);
    });

    expect(updateFolder).toHaveBeenCalledWith('f2', { parentId: null });
  });

  it('deleteFolder() forwards moveContentsToRoot and refreshes on success', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents());
    const deleteFolder = vi
      .fn()
      .mockResolvedValue({ deleted: true, folder_id: 'f1', moved_folders: 1, moved_documents: 2 });
    const client = { getFolderContents, deleteFolder } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate(null);
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    const outcome = await act(() =>
      result.current.deleteFolder('f1', { moveContentsToRoot: true })
    );

    expect(deleteFolder).toHaveBeenCalledWith('f1', { moveContentsToRoot: true });
    expect(outcome.moved_folders).toBe(1);
    expect(getFolderContents).toHaveBeenCalledTimes(2);
  });

  it('deleteFolder() propagates a rejection (e.g. 409 not-empty) without refreshing', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents());
    const deleteFolder = vi.fn().mockRejectedValue(new Error('Folder is not empty'));
    const client = { getFolderContents, deleteFolder } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate(null);
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    await expect(
      act(() => result.current.deleteFolder('f1'))
    ).rejects.toThrow('Folder is not empty');
    expect(getFolderContents).toHaveBeenCalledTimes(1); // no refresh after a failed delete
  });

  it('moveDocument() moves a document and refreshes the current folder contents', async () => {
    const getFolderContents = vi.fn().mockResolvedValue(makeContents());
    const moveDocument = vi.fn().mockResolvedValue({
      document_id: 'd1',
      source_filename: 'notes.pdf',
      folder_id: 'f2',
      document_type: 'report',
      chunk_count: 1,
      ingested_at: '2026-01-01T00:00:00Z',
    });
    const client = { getFolderContents, moveDocument } as unknown as EducationAssistantClient;
    const { result } = renderHook(() => useFolderLibrary(client));

    act(() => {
      result.current.navigate('f1');
    });
    await waitFor(() => expect(result.current.contentsState.status).toBe('success'));

    const moved = await act(() => result.current.moveDocument('d1', 'f2'));

    expect(moved.folder_id).toBe('f2');
    expect(moveDocument).toHaveBeenCalledWith('d1', { folderId: 'f2' });
    expect(getFolderContents).toHaveBeenCalledTimes(2);
    // Refresh always targets the currently-open folder (f1), not the
    // document's new destination (f2) — moving a document out of the
    // currently-open folder should make it disappear from this listing.
    expect(getFolderContents).toHaveBeenLastCalledWith({ folderId: 'f1' }, expect.anything());
  });
});
