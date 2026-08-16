import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  CreateWritingProjectRequest,
  WritingProject,
  WritingProjectSummary,
} from '../types/writing';

export type WritingProjectSort = 'updated_at' | 'name' | 'created_at';

export type WritingProjectsListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; projects: WritingProjectSummary[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type DeleteWritingProjectState =
  | { status: 'deleting' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export type ProjectActionState =
  | { status: 'working' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseWritingProjectsResult {
  listState: WritingProjectsListState;
  /** Fetches (or re-fetches) the writing-project list, superseding any
   * in-flight list request, using the current search/sort/archived
   * filters. */
  refresh: () => void;
  cancelList: () => void;

  /** Milestone 5.3 Part 27 — title/description substring search, applied
   * server-side. Changing this does NOT auto-refresh; call refresh()
   * (or use the returned setter + a debounced effect in the caller). */
  search: string;
  setSearch: (value: string) => void;

  /** Milestone 5.3 Part 28 — "updated_at" (default) | "name" | "created_at". */
  sort: WritingProjectSort;
  setSort: (value: WritingProjectSort) => void;

  /** Milestone 5.3 Part 30 — false (default) shows only active projects;
   * true shows ONLY archived projects (never a mixed view). */
  showArchived: boolean;
  setShowArchived: (value: boolean) => void;

  /**
   * Creates a writing project (seeded with the backend's minimal honest
   * template) and returns it directly. Optimistically prepends its
   * summary to the current listState (if present) so the list reflects
   * it without a refresh() round-trip.
   */
  createProject: (request: CreateWritingProjectRequest) => Promise<WritingProjectSummary>;

  /** Per-project delete state, keyed by project id. A project with no
   * entry has never had a delete attempted. */
  deleteStates: Record<string, DeleteWritingProjectState>;
  /** Deletes one writing project. A second call while one is already
   * 'deleting' is ignored. On success, removes it from the current
   * listState immediately — never touches any referenced Document. */
  deleteProject: (projectId: string) => void;
  resetDeleteState: (projectId: string) => void;

  /** Milestone 5.3 Part 30 — archive/restore state per project id. */
  archiveStates: Record<string, ProjectActionState>;
  /** Archives a project (hides it from the active list) and removes it
   * from the CURRENT listState immediately if that state is the active
   * (non-archived) view — a caller viewing the archived view should
   * refresh() after this to see it appear there. */
  archiveProject: (projectId: string) => void;
  /** Restores an archived project. */
  restoreProject: (projectId: string) => void;

  /** Milestone 5.3 Part 29 — duplicate state per SOURCE project id. */
  duplicateStates: Record<string, ProjectActionState>;
  /** Duplicates a project (metadata + full file tree + references —
   * never Documents/Notebook/Chat) and prepends the new copy's summary
   * to the current listState. Returns the new project. */
  duplicateProject: (projectId: string, title?: string) => Promise<WritingProjectSummary>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

function summaryFromProject(project: WritingProject): WritingProjectSummary {
  return {
    id: project.id,
    title: project.title,
    description: project.description ?? null,
    reference_count: 0,
    file_count: 1,
    archived_at: project.archived_at ?? null,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation), extended by
 * Milestone 5.3 (Part 26-30: dashboard, search, sort, duplicate,
 * archive/restore) — GET/POST/DELETE /writing-projects: the Writing home
 * screen's list data source. Follows the exact same async-guard/
 * optimistic-update pattern as useProjects.ts. Single-project detail,
 * editing, references, and bibliography/export live in
 * useWritingProject.ts instead — this hook only ever holds
 * WritingProjectSummary rows (no main_tex_content).
 */
export function useWritingProjects(client: EducationAssistantClient): UseWritingProjectsResult {
  const [listState, setListState] = useState<WritingProjectsListState>({ status: 'idle' });
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteWritingProjectState>>({});
  const [archiveStates, setArchiveStates] = useState<Record<string, ProjectActionState>>({});
  const [duplicateStates, setDuplicateStates] = useState<Record<string, ProjectActionState>>({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<WritingProjectSort>('updated_at');
  const [showArchived, setShowArchived] = useState(false);
  const listGuard = useAsyncGuard();
  const isMountedRef = useRef(true);
  const deletingIdsRef = useRef<Set<string>>(new Set());
  const archivingIdsRef = useRef<Set<string>>(new Set());
  const duplicatingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    const { signal, isCurrent } = listGuard.begin();
    setListState({ status: 'loading' });

    client
      .listWritingProjects({ q: search || undefined, sort, archived: showArchived }, { signal })
      .then((response) => {
        if (!isCurrent()) return;
        setListState({ status: 'success', projects: response.projects, total: response.total });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof RequestCancelledError) {
          setListState({ status: 'cancelled' });
          return;
        }
        setListState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, listGuard, search, sort, showArchived]);

  const createProject = useCallback(
    async (request: CreateWritingProjectRequest): Promise<WritingProjectSummary> => {
      const project = await client.createWritingProject(request);
      const summary = summaryFromProject(project);
      if (isMountedRef.current) {
        setListState((prev) =>
          prev.status === 'success'
            ? { status: 'success', projects: [summary, ...prev.projects], total: prev.total + 1 }
            : prev
        );
      }
      return summary;
    },
    [client]
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      if (deletingIdsRef.current.has(projectId)) return;
      deletingIdsRef.current.add(projectId);

      setDeleteStates((prev) => ({ ...prev, [projectId]: { status: 'deleting' } }));

      client
        .deleteWritingProject(projectId)
        .then(() => {
          deletingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({ ...prev, [projectId]: { status: 'success' } }));
          setListState((prev) =>
            prev.status === 'success'
              ? {
                  status: 'success',
                  projects: prev.projects.filter((p) => p.id !== projectId),
                  total: Math.max(0, prev.total - 1),
                }
              : prev
          );
        })
        .catch((error: unknown) => {
          deletingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setDeleteStates((prev) => ({
            ...prev,
            [projectId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client]
  );

  const resetDeleteState = useCallback((projectId: string) => {
    setDeleteStates((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  const archiveProject = useCallback(
    (projectId: string) => {
      if (archivingIdsRef.current.has(projectId)) return;
      archivingIdsRef.current.add(projectId);
      setArchiveStates((prev) => ({ ...prev, [projectId]: { status: 'working' } }));

      client
        .archiveWritingProject(projectId)
        .then(() => {
          archivingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setArchiveStates((prev) => ({ ...prev, [projectId]: { status: 'success' } }));
          setListState((prev) =>
            prev.status === 'success' && !showArchived
              ? {
                  status: 'success',
                  projects: prev.projects.filter((p) => p.id !== projectId),
                  total: Math.max(0, prev.total - 1),
                }
              : prev
          );
        })
        .catch((error: unknown) => {
          archivingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setArchiveStates((prev) => ({
            ...prev,
            [projectId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client, showArchived]
  );

  const restoreProject = useCallback(
    (projectId: string) => {
      if (archivingIdsRef.current.has(projectId)) return;
      archivingIdsRef.current.add(projectId);
      setArchiveStates((prev) => ({ ...prev, [projectId]: { status: 'working' } }));

      client
        .restoreWritingProject(projectId)
        .then(() => {
          archivingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setArchiveStates((prev) => ({ ...prev, [projectId]: { status: 'success' } }));
          setListState((prev) =>
            prev.status === 'success' && showArchived
              ? {
                  status: 'success',
                  projects: prev.projects.filter((p) => p.id !== projectId),
                  total: Math.max(0, prev.total - 1),
                }
              : prev
          );
        })
        .catch((error: unknown) => {
          archivingIdsRef.current.delete(projectId);
          if (!isMountedRef.current) return;
          setArchiveStates((prev) => ({
            ...prev,
            [projectId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client, showArchived]
  );

  const duplicateProject = useCallback(
    async (projectId: string, title?: string): Promise<WritingProjectSummary> => {
      if (duplicatingIdsRef.current.has(projectId)) {
        throw new EducationAssistantError('A duplicate of this project is already in progress.');
      }
      duplicatingIdsRef.current.add(projectId);
      setDuplicateStates((prev) => ({ ...prev, [projectId]: { status: 'working' } }));
      try {
        const copy = await client.duplicateWritingProject(projectId, title);
        const summary = summaryFromProject(copy);
        if (isMountedRef.current) {
          setDuplicateStates((prev) => ({ ...prev, [projectId]: { status: 'success' } }));
          setListState((prev) =>
            prev.status === 'success'
              ? { status: 'success', projects: [summary, ...prev.projects], total: prev.total + 1 }
              : prev
          );
        }
        return summary;
      } catch (error) {
        if (isMountedRef.current) {
          setDuplicateStates((prev) => ({
            ...prev,
            [projectId]: { status: 'error', error: toAssistantError(error) },
          }));
        }
        throw error;
      } finally {
        duplicatingIdsRef.current.delete(projectId);
      }
    },
    [client]
  );

  return {
    listState,
    refresh,
    cancelList: listGuard.cancel,
    search,
    setSearch,
    sort,
    setSort,
    showArchived,
    setShowArchived,
    createProject,
    deleteStates,
    deleteProject,
    resetDeleteState,
    archiveStates,
    archiveProject,
    restoreProject,
    duplicateStates,
    duplicateProject,
  };
}
