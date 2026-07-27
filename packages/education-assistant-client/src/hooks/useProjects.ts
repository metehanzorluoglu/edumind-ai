import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  CreateProjectRequest,
  ListProjectsParams,
  ProjectConversation,
  ProjectSummary,
  UpdateProjectRequest,
} from '../types/projects';

export type ProjectsListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; projects: ProjectSummary[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type DeleteProjectState =
  | { status: 'deleting' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export type ProjectConversationsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; conversations: ProjectConversation[]; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type AddRemoveConversationState =
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseProjectsResult {
  listState: ProjectsListState;
  /** Fetches (or re-fetches) the project list, superseding any in-flight list request. */
  refresh: (params?: ListProjectsParams) => void;
  cancelList: () => void;

  /**
   * Creates a project and returns it directly (not routed through
   * listState) so the caller can e.g. auto-expand it immediately.
   * Optimistically prepends it to the current listState (if present) so
   * the sidebar reflects it without a refresh() round-trip.
   */
  createProject: (request: CreateProjectRequest) => Promise<ProjectSummary>;

  /**
   * Updates a project (rename and/or description) and returns the updated
   * summary directly. Optimistically patches the matching entry in the
   * current listState (if present).
   */
  updateProject: (projectId: string, request: UpdateProjectRequest) => Promise<ProjectSummary>;

  /**
   * Per-project delete state, keyed by project id — mirrors
   * useConversations' deleteStates. A project with no entry has never had
   * a delete attempted.
   */
  deleteStates: Record<string, DeleteProjectState>;
  /**
   * Deletes one project. A second call while one is already 'deleting' is
   * ignored. On success, removes it from the current listState
   * immediately — never touches any conversation that was in it.
   */
  deleteProject: (projectId: string) => void;
  resetDeleteState: (projectId: string) => void;

  /**
   * Per-project conversation-list state, keyed by project id — populated
   * only once loadProjectConversations() has been called for that project
   * (e.g. when the user expands it), not eagerly for every project up
   * front.
   */
  projectConversationsStates: Record<string, ProjectConversationsState>;
  loadProjectConversations: (projectId: string) => void;

  /**
   * Per-(project, conversation) pending/result state for add/remove
   * actions, keyed by `${projectId}:${conversationId}` — lets a picker UI
   * show a spinner on just the one row being toggled. On success, both
   * refreshes that project's conversation-count in listState and, if that
   * project's conversation list has already been loaded, its
   * projectConversationsStates entry too — so an already-expanded project
   * reflects the change without a manual reload.
   */
  addRemoveStates: Record<string, AddRemoveConversationState>;
  addConversationToProject: (projectId: string, conversationId: string) => Promise<void>;
  removeConversationFromProject: (projectId: string, conversationId: string) => Promise<void>;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

function addRemoveKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}

/** GET/POST/PATCH/DELETE /projects and /projects/{id}/conversations — the sidebar's Projects section data source. */
export function useProjects(client: EducationAssistantClient): UseProjectsResult {
  const [listState, setListState] = useState<ProjectsListState>({ status: 'idle' });
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteProjectState>>({});
  const [projectConversationsStates, setProjectConversationsStates] = useState<
    Record<string, ProjectConversationsState>
  >({});
  const [addRemoveStates, setAddRemoveStates] = useState<
    Record<string, AddRemoveConversationState>
  >({});
  const listGuard = useAsyncGuard();
  // Per-project-id version of useAsyncGuard's own generation-counter +
  // AbortController pattern, hand-rolled here rather than calling
  // useAsyncGuard() itself per key: the set of project ids is dynamic
  // (loaded from the server), and hooks can't be called conditionally or a
  // variable number of times — so loading project A's conversations can
  // never be raced/overwritten by a stale response for project B, and
  // re-loading the same project supersedes its own prior in-flight
  // request, without violating the Rules of Hooks.
  const conversationControllersRef = useRef<Map<string, AbortController>>(new Map());
  const conversationGenerationsRef = useRef<Map<string, number>>(new Map());

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      for (const controller of conversationControllersRef.current.values()) {
        controller.abort();
      }
    };
  }, []);

  const deletingIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(
    (params: ListProjectsParams = {}) => {
      const { signal, isCurrent } = listGuard.begin();
      setListState({ status: 'loading' });

      client
        .listProjects(params, { signal })
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
    },
    [client, listGuard]
  );

  const createProject = useCallback(
    async (request: CreateProjectRequest): Promise<ProjectSummary> => {
      const project = await client.createProject(request);
      if (isMountedRef.current) {
        setListState((prev) =>
          prev.status === 'success'
            ? { status: 'success', projects: [project, ...prev.projects], total: prev.total + 1 }
            : prev
        );
      }
      return project;
    },
    [client]
  );

  const updateProject = useCallback(
    async (projectId: string, request: UpdateProjectRequest): Promise<ProjectSummary> => {
      const updated = await client.updateProject(projectId, request);
      if (isMountedRef.current) {
        setListState((prev) =>
          prev.status === 'success'
            ? {
                status: 'success',
                projects: prev.projects.map((p) => (p.id === projectId ? updated : p)),
                total: prev.total,
              }
            : prev
        );
      }
      return updated;
    },
    [client]
  );

  const deleteProject = useCallback(
    (projectId: string) => {
      if (deletingIdsRef.current.has(projectId)) return;
      deletingIdsRef.current.add(projectId);

      setDeleteStates((prev) => ({ ...prev, [projectId]: { status: 'deleting' } }));

      client
        .deleteProject(projectId)
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

  const loadProjectConversations = useCallback(
    (projectId: string) => {
      conversationControllersRef.current.get(projectId)?.abort();
      const controller = new AbortController();
      conversationControllersRef.current.set(projectId, controller);
      const generation = (conversationGenerationsRef.current.get(projectId) ?? 0) + 1;
      conversationGenerationsRef.current.set(projectId, generation);
      const isCurrent = (): boolean =>
        isMountedRef.current && conversationGenerationsRef.current.get(projectId) === generation;

      setProjectConversationsStates((prev) => ({ ...prev, [projectId]: { status: 'loading' } }));

      client
        .listProjectConversations(projectId, {}, { signal: controller.signal })
        .then((response) => {
          if (!isCurrent()) return;
          setProjectConversationsStates((prev) => ({
            ...prev,
            [projectId]: {
              status: 'success',
              conversations: response.conversations,
              total: response.total,
            },
          }));
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) {
            setProjectConversationsStates((prev) => ({
              ...prev,
              [projectId]: { status: 'cancelled' },
            }));
            return;
          }
          setProjectConversationsStates((prev) => ({
            ...prev,
            [projectId]: { status: 'error', error: toAssistantError(error) },
          }));
        });
    },
    [client]
  );

  /** Bumps a project's conversation_count in listState by `delta` without a round-trip. */
  const bumpConversationCount = useCallback((projectId: string, delta: number) => {
    setListState((prev) =>
      prev.status === 'success'
        ? {
            status: 'success',
            projects: prev.projects.map((p) =>
              p.id === projectId
                ? { ...p, conversation_count: Math.max(0, p.conversation_count + delta) }
                : p
            ),
            total: prev.total,
          }
        : prev
    );
  }, []);

  const addConversationToProject = useCallback(
    async (projectId: string, conversationId: string): Promise<void> => {
      const key = addRemoveKey(projectId, conversationId);
      setAddRemoveStates((prev) => ({ ...prev, [key]: { status: 'pending' } }));
      try {
        await client.addProjectConversation(projectId, conversationId);
        if (!isMountedRef.current) return;
        setAddRemoveStates((prev) => ({ ...prev, [key]: { status: 'success' } }));
        bumpConversationCount(projectId, 1);
        if (projectConversationsStates[projectId]?.status === 'success') {
          loadProjectConversations(projectId);
        }
      } catch (error) {
        if (isMountedRef.current) {
          setAddRemoveStates((prev) => ({
            ...prev,
            [key]: { status: 'error', error: toAssistantError(error) },
          }));
        }
        throw error;
      }
    },
    [client, bumpConversationCount, loadProjectConversations, projectConversationsStates]
  );

  const removeConversationFromProject = useCallback(
    async (projectId: string, conversationId: string): Promise<void> => {
      const key = addRemoveKey(projectId, conversationId);
      setAddRemoveStates((prev) => ({ ...prev, [key]: { status: 'pending' } }));
      try {
        await client.removeProjectConversation(projectId, conversationId);
        if (!isMountedRef.current) return;
        setAddRemoveStates((prev) => ({ ...prev, [key]: { status: 'success' } }));
        bumpConversationCount(projectId, -1);
        setProjectConversationsStates((prev) => {
          const current = prev[projectId];
          if (current?.status !== 'success') return prev;
          return {
            ...prev,
            [projectId]: {
              status: 'success',
              conversations: current.conversations.filter(
                (c) => c.conversation_id !== conversationId
              ),
              total: Math.max(0, current.total - 1),
            },
          };
        });
      } catch (error) {
        if (isMountedRef.current) {
          setAddRemoveStates((prev) => ({
            ...prev,
            [key]: { status: 'error', error: toAssistantError(error) },
          }));
        }
        throw error;
      }
    },
    [client, bumpConversationCount]
  );

  return {
    listState,
    refresh,
    cancelList: listGuard.cancel,
    createProject,
    updateProject,
    deleteStates,
    deleteProject,
    resetDeleteState,
    projectConversationsStates,
    loadProjectConversations,
    addRemoveStates,
    addConversationToProject,
    removeConversationFromProject,
  };
}
