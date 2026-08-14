import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * Combines any number of "attach imperative DOM listeners to this node,
 * return a cleanup" functions (see useLibraryDnD's `attachDragSource` /
 * `attachFolderDropTarget`) into the single ref callback a host `<div>`
 * (see documents.tsx's own pre-existing drop-zone pattern) actually takes.
 * No-ops on native — there is no DOM node to attach to there, and every
 * item stays reachable through the Move action regardless (requirement
 * #18: drag-and-drop is never the only way to move something).
 *
 * The returned callback's identity is permanently stable (empty
 * useCallback deps) so React only ever invokes it on the node's real
 * mount/unmount, never merely because the owning row/card re-rendered
 * (selection changed, a sibling started dragging, etc.) — that re-render
 * would otherwise tear down and re-attach every listener on every
 * keystroke of drag state, which is exactly the "excessive drag
 * re-renders" requirement #16 warns against. `attachers` is still always
 * read fresh via a ref updated on every render, so a real (re)mount picks
 * up whichever item/folderId this row currently represents.
 */
export function useCombinedDomRef(
  attachers: readonly (((node: HTMLElement) => (() => void) | void) | null | undefined)[]
): (node: HTMLElement | null) => void {
  const attachersRef = useRef(attachers);
  attachersRef.current = attachers;
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node || Platform.OS !== 'web') return;
    const cleanups = attachersRef.current
      .filter((fn): fn is (node: HTMLElement) => (() => void) | void => typeof fn === 'function')
      .map((fn) => fn(node))
      .filter((fn): fn is () => void => typeof fn === 'function');
    cleanupRef.current = () => cleanups.forEach((fn) => fn());
  }, []);
}
