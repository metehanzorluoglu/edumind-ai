import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  DocumentSummary,
  EducationAssistantClient,
  FolderResponse,
} from 'education-assistant-client';
import { libraryItemId, type LibraryItem } from '@/lib/libraryItems';

/**
 * Frontend Milestone 1 (Finder-style Document Library) — real HTML5
 * pointer drag-and-drop for moving documents/folders, plus a clean seam
 * for the *external* OS-file-drop-to-upload case (requirement #8).
 *
 * Design notes (see the milestone report's "Drag-and-Drop Architecture"
 * section for the full writeup):
 *
 * - Every draggable/droppable surface is a plain host `<div>` (via
 *   `createElement`, exactly like the pre-existing top-of-page upload drop
 *   zone in documents.tsx) — react-native-web's `<View>` does not forward
 *   `onDrag*`/`onDrop` props at all, so those must never be attached to a
 *   `View`.
 * - A ref callback only fires again when the underlying DOM node itself is
 *   mounted or unmounted — NOT on every re-render just because a prop
 *   changed (see useCombinedDomRef.ts). That means every listener attached
 *   here must read whatever it needs through a REF, refreshed every
 *   render, rather than closing directly over a prop/derived value —
 *   otherwise a folder/document card that stays mounted across a
 *   navigation (or any div whose listeners were attached once, early)
 *   would keep answering drag questions with data from whenever it first
 *   mounted. `itemsByIdRef`, `selectedIdsRef`, `breadcrumbFolderIdsRef`,
 *   and the callback refs below all exist for exactly this reason — every
 *   `attach*` function is built once (stable identity, cheap to attach)
 *   and reads current data through these on each actual drag event.
 * - "What is currently being dragged" lives in a plain ref
 *   (`draggingIdsRef`), set synchronously in `onDragStart` and cleared in
 *   `onDragEnd`/`onDrop` — NOT in React state. `dragover` fires
 *   continuously (like `mousemove`) for as long as the pointer sits over a
 *   target, so driving it through `setState` would re-render on every
 *   frame; a ref sidesteps that entirely; the ref's value never needs to
 *   *render* anything itself, only the discrete "which target is currently
 *   hovered, and is it valid" transition does, and that's tracked in
 *   React state below.
 * - `dataTransfer.types` (readable during `dragover`, unlike
 *   `getData()`, which most browsers only allow on `drop`) distinguishes
 *   an OS file drag (`types` includes `"Files"`) from a same-page item
 *   drag. Because item drags never touch `dataTransfer.getData()` at all
 *   (the dragged ids live in `draggingIdsRef`, read directly — this is a
 *   same-page drag, there is no cross-window handoff to support), this
 *   works reliably across Chrome/Firefox/Safari without depending on any
 *   browser's particular `getData`-during-`dragover` behavior.
 * - Validity (self-drop / already-there / unsupported target) is computed
 *   on `dragenter`/`dragover`, *before* the drop: an invalid target simply
 *   never calls `preventDefault()`, so the browser shows its native
 *   "not allowed" cursor and refuses the drop on its own — no extra code
 *   needed to "block" it, and no wasted request ever gets a chance to
 *   fire (requirement #6).
 */

export type DropTarget =
  | {
      kind: 'folder';
      folderId: string;
      /** Root→…→target folder-id chain, INCLUDING the target itself
       * (GET /folders/contents' own `breadcrumbs` already includes the
       * folder it's for — see routes_folders.py — so building this never
       * costs an extra fetch; requirement #16). Used to catch both
       * "folder dropped onto itself" (chain's last id) and "folder
       * dropped into one of its own subfolders" (chain contains the
       * dragged folder's id anywhere) in one check. */
      ancestorChain: readonly string[];
    }
  | { kind: 'root' };

interface MovePlan {
  valid: boolean;
  reason?: string;
  itemsToMove: LibraryItem[];
}

function currentParentId(item: LibraryItem): string | null {
  return item.kind === 'folder' ? (item.data.parent_id ?? null) : (item.data.folder_id ?? null);
}

/**
 * Pure — no I/O, no React — so it's directly unit-testable and is the one
 * place every "is this drop allowed" rule lives (requirement #6).
 *
 * The self-drop and descendant-drop checks collapse into one: if any
 * dragged folder's id appears anywhere in the target's own root-to-target
 * ancestor chain, the target is either that folder itself (last link) or
 * nested somewhere underneath it (an earlier link) — both moves would
 * either no-op or create a cycle. Root is never a descendant of anything,
 * so it always skips this check.
 */
export function planLibraryMove(
  draggedItems: readonly LibraryItem[],
  target: DropTarget
): MovePlan {
  if (draggedItems.length === 0) return { valid: false, itemsToMove: [] };
  const targetFolderId = target.kind === 'folder' ? target.folderId : null;

  if (target.kind === 'folder') {
    const cyclicDrop = draggedItems.some(
      (item) => item.kind === 'folder' && target.ancestorChain.includes(item.data.id)
    );
    if (cyclicDrop) {
      return {
        valid: false,
        reason: "A folder can't be moved into itself or one of its own subfolders.",
        itemsToMove: [],
      };
    }
  }

  // Drop onto the location an item is already in is a no-op, not an error
  // — silently skip those items rather than surfacing a message for
  // something the user didn't do anything wrong to trigger.
  const itemsToMove = draggedItems.filter((item) => currentParentId(item) !== targetFolderId);
  if (itemsToMove.length === 0) {
    return { valid: false, reason: 'Already there.', itemsToMove: [] };
  }

  return { valid: true, itemsToMove };
}

export interface UseLibraryDnDResult {
  /** Web-only. Spread onto a draggable item's host `<div>` ref callback
   * consumer (see LibraryContentsView/LibraryEntry — they build the actual
   * ref callback via useCombinedDomRef; this just supplies the imperative
   * listeners to attach). `itemId` (not the full LibraryItem) is all that's
   * needed — the current item data is always looked up fresh at drag time
   * (see the module doc above on why nothing here closes over data that
   * could go stale). */
  attachDragSource: (node: HTMLElement, itemId: string) => () => void;
  /** Web-only. Attaches drop-target listeners for a folder card/row inside
   * the currently-open folder's own listing. */
  attachFolderDropTarget: (node: HTMLElement, folderId: string) => () => void;
  /** Web-only. Attaches drop-target listeners for an ANCESTOR breadcrumb
   * segment (not the root crumb — see attachRootDropTarget) — its
   * ancestor chain is a prefix of the currently-open folder's own
   * breadcrumbs, not `folderId` appended to them (see attachFolderDropTarget). */
  attachBreadcrumbDropTarget: (node: HTMLElement, folderId: string) => () => void;
  /** Web-only. Attaches drop-target listeners for the root ("Documents")
   * breadcrumb segment / label — requirement #7. */
  attachRootDropTarget: (node: HTMLElement) => () => void;
  dropVisualState: (key: string) => 'none' | 'valid' | 'invalid';
  isMoving: (id: string) => boolean;
  isBeingDragged: (id: string) => boolean;
  error: string | null;
  dismissError: () => void;
}

export interface UseLibraryDnDParams {
  client: EducationAssistantClient;
  visibleFolders: readonly FolderResponse[];
  visibleDocuments: readonly DocumentSummary[];
  /** Root→…→currently-open-folder id chain, INCLUDING the open folder
   * itself — exactly GET /folders/contents' own `breadcrumbs` field
   * mapped to ids (empty at root). Used only to build each drop target's
   * `ancestorChain` for planLibraryMove's cycle guard — never fetched
   * separately. */
  breadcrumbFolderIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  /** Called with an id right when a drag starts on an item that ISN'T
   * already part of the current multi-selection — mirrors Finder: dragging
   * a selected item drags the whole group, dragging an unselected one
   * selects (and drags) just that one. */
  selectOnly: (id: string) => void;
  /** Refreshes the open folder's contents — called once after a move
   * completes (success or partial failure), never per-item (requirement
   * #16: no unnecessary per-item refresh). */
  onMoveSettled: () => void;
  /** A file was dragged in from the user's OS (not from within this page)
   * and dropped on `targetFolderId` — hands off to the existing
   * pick-a-file-and-review-metadata flow (requirement #8: reuses the
   * upload pipeline; never a silent auto-upload that skips the same
   * duplicate-check/metadata-review step a picked file goes through). */
  onExternalFileDrop: (file: File, targetFolderId: string | null) => void;
}

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** Keeps `ref.current` equal to `value` on every render, returning the
 * ref — the standard escape hatch for a stable callback that still needs
 * to read the latest value of something without listing it as a
 * useCallback dependency (which would force re-creating — and, for the
 * `attach*` functions here, effectively re-*attaching* — the callback on
 * every change). */
function useLiveRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function useLibraryDnD(params: UseLibraryDnDParams): UseLibraryDnDResult {
  const {
    client,
    visibleFolders,
    visibleDocuments,
    breadcrumbFolderIds,
    selectedIds,
    selectOnly,
    onMoveSettled,
    onExternalFileDrop,
  } = params;

  const itemsById = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    visibleFolders.forEach((data) => map.set(data.id, { kind: 'folder', data }));
    visibleDocuments.forEach((data) => map.set(data.document_id, { kind: 'document', data }));
    return map;
  }, [visibleFolders, visibleDocuments]);

  // See useLiveRef's doc and the module doc above: every `attach*`
  // function below is built once and attached to its `<div>` once (its
  // host element never remounts just because folder contents changed), so
  // anything it needs that CAN change over that div's lifetime — which
  // folder/document is currently visible, the breadcrumb chain, the
  // current multi-selection, the callbacks passed in as props — must be
  // read through a live ref, never closed over directly.
  const itemsByIdRef = useLiveRef(itemsById);
  const breadcrumbFolderIdsRef = useLiveRef(breadcrumbFolderIds);
  const selectedIdsRef = useLiveRef(selectedIds);
  const selectOnlyRef = useLiveRef(selectOnly);
  const onMoveSettledRef = useLiveRef(onMoveSettled);
  const onExternalFileDropRef = useLiveRef(onExternalFileDrop);
  const clientRef = useLiveRef(client);

  const draggingIdsRef = useRef<string[] | null>(null);
  // Per-target dragenter/dragleave counters, exactly like the top-level
  // upload dropzone's own dragCounterRef — absorbs the enter/leave pairs
  // fired when the pointer crosses a nested child inside the same drop
  // target, which would otherwise flicker the highlight off and on.
  const enterCountsRef = useRef<Map<string, number>>(new Map());

  const [hovered, setHovered] = useState<{ key: string; valid: boolean } | null>(null);
  const [movingIds, setMovingIds] = useState<ReadonlySet<string>>(new Set());
  const [draggingIds, setDraggingIds] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const resolveDragged = useCallback(
    (ids: string[]): LibraryItem[] => {
      const map = itemsByIdRef.current;
      return ids.map((id) => map.get(id)).filter((item): item is LibraryItem => item != null);
    },
    [itemsByIdRef]
  );

  const performMove = useCallback(
    async (itemsToMove: LibraryItem[], targetFolderId: string | null) => {
      setMovingIds(new Set(itemsToMove.map(libraryItemId)));
      setError(null);
      const results = await Promise.allSettled(
        itemsToMove.map((item) =>
          item.kind === 'folder'
            ? clientRef.current.updateFolder(item.data.id, { parentId: targetFolderId })
            : clientRef.current.moveDocument(item.data.document_id, { folderId: targetFolderId })
        )
      );
      setMovingIds(new Set());
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failures.length > 0) {
        const firstMessage =
          failures[0]!.reason instanceof Error
            ? failures[0]!.reason.message
            : String(failures[0]!.reason);
        setError(
          itemsToMove.length === 1
            ? firstMessage
            : `${failures.length} of ${itemsToMove.length} item(s) couldn't be moved: ${firstMessage}`
        );
      }
      // One refresh regardless of how many items moved/failed — the
      // successfully-moved items must still disappear from this listing,
      // and a failed item was never touched visually, so nothing here
      // needs a rollback (requirement #5's "lightweight moving state,
      // refresh after success" path, not optimistic-with-rollback).
      onMoveSettledRef.current();
    },
    [clientRef, onMoveSettledRef]
  );

  const setTargetHover = useCallback((key: string, valid: boolean, entering: boolean) => {
    const counts = enterCountsRef.current;
    const next = (counts.get(key) ?? 0) + (entering ? 1 : -1);
    counts.set(key, Math.max(0, next));
    if (entering) {
      setHovered({ key, valid });
    } else if ((counts.get(key) ?? 0) === 0) {
      setHovered((prev) => (prev?.key === key ? null : prev));
    }
  }, []);

  const attachDragSource = useCallback(
    (node: HTMLElement, id: string): (() => void) => {
      function onDragStart(event: DragEvent): void {
        const selectedIds = selectedIdsRef.current;
        const group = selectedIds.has(id) && selectedIds.size > 1 ? Array.from(selectedIds) : [id];
        if (group.length === 1) selectOnlyRef.current(id);
        draggingIdsRef.current = group;
        setDraggingIds(new Set(group));
        // Firefox refuses to start a drag at all without at least one
        // setData call; the value itself is never read back (see the
        // module doc — dragged ids live in draggingIdsRef, a same-page
        // ref, not dataTransfer).
        event.dataTransfer?.setData('text/plain', group.length > 1 ? `${group.length} items` : id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      }

      function onDragEnd(): void {
        draggingIdsRef.current = null;
        setDraggingIds(new Set());
        enterCountsRef.current.clear();
        setHovered(null);
      }

      node.setAttribute('draggable', 'true');
      node.addEventListener('dragstart', onDragStart);
      node.addEventListener('dragend', onDragEnd);
      return () => {
        node.removeEventListener('dragstart', onDragStart);
        node.removeEventListener('dragend', onDragEnd);
      };
    },
    [selectedIdsRef, selectOnlyRef]
  );

  const attachDropTarget = useCallback(
    (node: HTMLElement, key: string, getTarget: () => DropTarget): (() => void) => {
      function evaluateInternal(): MovePlan | null {
        const draggedIds = draggingIdsRef.current;
        if (!draggedIds) return null;
        return planLibraryMove(resolveDragged(draggedIds), getTarget());
      }

      function onDragEnter(event: DragEvent): void {
        const plan = evaluateInternal();
        if (plan) {
          setTargetHover(key, plan.valid, true);
          return;
        }
        if (isFileDrag(event)) setTargetHover(key, true, true);
      }

      function onDragOver(event: DragEvent): void {
        const plan = evaluateInternal();
        if (plan) {
          if (!plan.valid) return; // no preventDefault -> native "not allowed" cursor, drop refused
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          return;
        }
        if (isFileDrag(event)) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        }
      }

      function onDragLeave(event: DragEvent): void {
        const plan = evaluateInternal();
        const valid = plan ? plan.valid : isFileDrag(event);
        setTargetHover(key, valid, false);
      }

      function onDrop(event: DragEvent): void {
        event.preventDefault();
        enterCountsRef.current.set(key, 0);
        setHovered(null);
        const draggedIds = draggingIdsRef.current;
        draggingIdsRef.current = null;
        setDraggingIds(new Set());
        const target = getTarget();

        if (draggedIds) {
          const plan = planLibraryMove(resolveDragged(draggedIds), target);
          if (!plan.valid) {
            if (plan.reason && plan.reason !== 'Already there.') setError(plan.reason);
            return;
          }
          void performMove(plan.itemsToMove, target.kind === 'folder' ? target.folderId : null);
          return;
        }

        if (isFileDrag(event)) {
          const file = event.dataTransfer?.files?.[0];
          if (file)
            onExternalFileDropRef.current(file, target.kind === 'folder' ? target.folderId : null);
        }
      }

      node.addEventListener('dragenter', onDragEnter);
      node.addEventListener('dragover', onDragOver);
      node.addEventListener('dragleave', onDragLeave);
      node.addEventListener('drop', onDrop);
      return () => {
        node.removeEventListener('dragenter', onDragEnter);
        node.removeEventListener('dragover', onDragOver);
        node.removeEventListener('dragleave', onDragLeave);
        node.removeEventListener('drop', onDrop);
      };
    },
    [resolveDragged, performMove, onExternalFileDropRef, setTargetHover]
  );

  const attachFolderDropTarget = useCallback(
    (node: HTMLElement, folderId: string) =>
      attachDropTarget(node, `folder:${folderId}`, () => ({
        kind: 'folder',
        folderId,
        // A card in the currently-open folder's own listing is always a
        // direct child of it — its ancestor chain is simply the open
        // folder's own breadcrumb chain (already includes the open folder
        // itself) plus this card's id. Read fresh from the ref every call
        // (see the module doc) — the open folder can change without this
        // particular `<div>` ever unmounting.
        ancestorChain: [...breadcrumbFolderIdsRef.current, folderId],
      })),
    [attachDropTarget, breadcrumbFolderIdsRef]
  );

  const attachBreadcrumbDropTarget = useCallback(
    (node: HTMLElement, folderId: string) =>
      attachDropTarget(node, `folder:${folderId}`, () => {
        const chain = breadcrumbFolderIdsRef.current;
        const index = chain.indexOf(folderId);
        return {
          kind: 'folder',
          folderId,
          ancestorChain: index >= 0 ? chain.slice(0, index + 1) : [folderId],
        };
      }),
    [attachDropTarget, breadcrumbFolderIdsRef]
  );

  const attachRootDropTarget = useCallback(
    (node: HTMLElement) => attachDropTarget(node, 'root', () => ({ kind: 'root' })),
    [attachDropTarget]
  );

  const dropVisualState = useCallback(
    (key: string): 'none' | 'valid' | 'invalid' => {
      if (!hovered || hovered.key !== key) return 'none';
      return hovered.valid ? 'valid' : 'invalid';
    },
    [hovered]
  );

  const isMoving = useCallback((id: string) => movingIds.has(id), [movingIds]);
  const isBeingDragged = useCallback((id: string) => draggingIds.has(id), [draggingIds]);
  const dismissError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      attachDragSource,
      attachFolderDropTarget,
      attachBreadcrumbDropTarget,
      attachRootDropTarget,
      dropVisualState,
      isMoving,
      isBeingDragged,
      error,
      dismissError,
    }),
    [
      attachDragSource,
      attachFolderDropTarget,
      attachBreadcrumbDropTarget,
      attachRootDropTarget,
      dropVisualState,
      isMoving,
      isBeingDragged,
      error,
      dismissError,
    ]
  );
}
