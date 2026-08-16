import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAsyncGuard } from './internal/useAsyncGuard';
import { EducationAssistantError, RequestCancelledError } from '../client/errors';
import type { EducationAssistantClient } from '../client/EducationAssistantClient';
import type {
  CreateWritingProjectFromTemplateRequest,
  WritingTemplateDetail,
  WritingTemplateSummary,
} from '../types/writingTemplates';
import type { WritingProject } from '../types/writing';

export type WritingTemplatesListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; templates: WritingTemplateSummary[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: EducationAssistantError };

export type WritingTemplateDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; template: WritingTemplateDetail }
  | { status: 'error'; error: EducationAssistantError };

export type CreateFromTemplateState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'error'; error: EducationAssistantError };

export interface UseWritingTemplatesResult {
  /** Loads (or reloads) the full curated gallery — one call covers
   * every template; search/category filtering below is client-side
   * (Part 48: the registry is small by design — "start SMALL"). */
  listState: WritingTemplatesListState;
  refresh: () => void;

  /** Part 21 — substring match against name/description, applied
   * client-side over the already-fetched gallery. */
  search: string;
  setSearch: (value: string) => void;

  /** Part 21 — null (default) shows every category. Options are
   * derived from whatever categories the loaded templates actually
   * have — never a hardcoded list the registry could drift from. */
  category: string | null;
  setCategory: (value: string | null) => void;

  /** search+category applied to listState's templates, in gallery
   * order. Empty while listState isn't 'success'. */
  visibleTemplates: WritingTemplateSummary[];
  /** Every distinct category present in the loaded gallery, in first-
   * seen order — for rendering the category filter's own options. */
  categories: string[];

  /** GET /writing-templates/{id} — for the "Preview" screen's file
   * tree + root document. Cleared via clearDetail(). */
  detailState: WritingTemplateDetailState;
  loadDetail: (templateId: string) => void;
  clearDetail: () => void;

  /** POST /writing-templates/{id}/create — "Use template". Resolves
   * with the newly created WritingProject; the caller navigates to it. */
  createFromTemplate: (
    templateId: string,
    request: CreateWritingProjectFromTemplateRequest
  ) => Promise<WritingProject>;
  createState: CreateFromTemplateState;
  resetCreateState: () => void;
}

function toAssistantError(error: unknown): EducationAssistantError {
  return error instanceof EducationAssistantError
    ? error
    : new EducationAssistantError(String(error));
}

/**
 * Milestone 5.4 (LaTeX Templates & Project Import) Part 21/22 — the
 * curated template gallery's data source: list + client-side search/
 * category filter, on-demand detail/preview, and "Use template"
 * creation. Follows the exact same async-guard/optimistic-state
 * pattern as useWritingProjects.ts.
 */
export function useWritingTemplates(client: EducationAssistantClient): UseWritingTemplatesResult {
  const [listState, setListState] = useState<WritingTemplatesListState>({ status: 'idle' });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<WritingTemplateDetailState>({ status: 'idle' });
  const [createState, setCreateState] = useState<CreateFromTemplateState>({ status: 'idle' });
  const listGuard = useAsyncGuard();
  const detailGuard = useAsyncGuard();
  const isMountedRef = useRef(true);

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
      .listWritingTemplates({ signal })
      .then((response) => {
        if (!isCurrent()) return;
        setListState({ status: 'success', templates: response.templates });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof RequestCancelledError) {
          setListState({ status: 'cancelled' });
          return;
        }
        setListState({ status: 'error', error: toAssistantError(error) });
      });
  }, [client, listGuard]);

  const templates = listState.status === 'success' ? listState.templates : [];

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const t of templates) {
      if (!seen.includes(t.category)) seen.push(t.category);
    }
    return seen;
  }, [templates]);

  const visibleTemplates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (category && t.category !== category) return false;
      if (!q) return true;
      return t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [templates, search, category]);

  const loadDetail = useCallback(
    (templateId: string) => {
      const { signal, isCurrent } = detailGuard.begin();
      setDetailState({ status: 'loading' });

      client
        .getWritingTemplate(templateId, { signal })
        .then((template) => {
          if (!isCurrent()) return;
          setDetailState({ status: 'success', template });
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          if (error instanceof RequestCancelledError) return;
          setDetailState({ status: 'error', error: toAssistantError(error) });
        });
    },
    [client, detailGuard]
  );

  const clearDetail = useCallback(() => {
    detailGuard.cancel();
    setDetailState({ status: 'idle' });
  }, [detailGuard]);

  const createFromTemplate = useCallback(
    async (
      templateId: string,
      request: CreateWritingProjectFromTemplateRequest
    ): Promise<WritingProject> => {
      setCreateState({ status: 'creating' });
      try {
        const project = await client.createWritingProjectFromTemplate(templateId, request);
        if (isMountedRef.current) setCreateState({ status: 'idle' });
        return project;
      } catch (error) {
        if (isMountedRef.current) {
          setCreateState({ status: 'error', error: toAssistantError(error) });
        }
        throw error;
      }
    },
    [client]
  );

  const resetCreateState = useCallback(() => setCreateState({ status: 'idle' }), []);

  return {
    listState,
    refresh,
    search,
    setSearch,
    category,
    setCategory,
    visibleTemplates,
    categories,
    detailState,
    loadDetail,
    clearDetail,
    createFromTemplate,
    createState,
    resetCreateState,
  };
}
