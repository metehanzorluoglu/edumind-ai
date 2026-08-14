import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Frontend Milestone 1 (Finder-style Document Library) — desktop-style
 * multi-selection over whichever folders+documents are currently rendered
 * (grid or list, same hook either way). Plain click selects one item;
 * Cmd/Ctrl+click toggles; Shift+click extends a range from the last
 * "anchor" click, matching macOS Finder / Windows Explorer. Native
 * touch/mobile is unaffected: FolderRow-style tap-to-open and the actions
 * menu's Move/Delete stay the only way to act on an item there, so this
 * hook never makes the mobile experience worse (see the milestone's
 * requirement #9/#17) — modifier keys simply never fire on a touchscreen
 * with no physical keyboard.
 */
export interface UseLibrarySelectionResult {
  selectedIds: ReadonlySet<string>;
  isSelected: (id: string) => boolean;
  /** `orderedIds` is the currently visible list in on-screen order — needed
   * only to resolve a Shift+click range; passing the wrong order just
   * produces a different (still harmless) range. */
  selectItem: (
    id: string,
    orderedIds: readonly string[],
    modifiers: { toggle: boolean; range: boolean }
  ) => void;
  clearSelection: () => void;
  /** Drops any selected id no longer present after a refresh/navigation —
   * called with the freshly loaded folder's item ids. */
  pruneSelection: (validIds: readonly string[]) => void;
  selectedCount: number;
}

/** Reads Shift/Cmd/Ctrl off a Pressable's press event — react-native-web
 * forwards the underlying DOM MouseEvent's modifier keys onto
 * `nativeEvent`, but native touch events have no such concept. Callers on
 * native never pass a modifier-bearing event in the first place (no
 * physical keyboard), so this only ever matters on web. */
export function readSelectionModifiers(event: unknown): { toggle: boolean; range: boolean } {
  if (Platform.OS !== 'web') return { toggle: false, range: false };
  const nativeEvent = (event as { nativeEvent?: Record<string, unknown> } | undefined)?.nativeEvent;
  if (!nativeEvent) return { toggle: false, range: false };
  const toggle = Boolean(nativeEvent.metaKey) || Boolean(nativeEvent.ctrlKey);
  const range = Boolean(nativeEvent.shiftKey);
  return { toggle, range };
}

export function useLibrarySelection(): UseLibrarySelectionResult {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const anchorIndexRef = useRef<number | null>(null);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const selectItem = useCallback<UseLibrarySelectionResult['selectItem']>(
    (id, orderedIds, { toggle, range }) => {
      const index = orderedIds.indexOf(id);

      if (range && anchorIndexRef.current !== null && index >= 0) {
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        setSelectedIds(new Set(orderedIds.slice(start, end + 1)));
        return;
      }

      if (toggle) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
        anchorIndexRef.current = index >= 0 ? index : anchorIndexRef.current;
        return;
      }

      setSelectedIds(new Set([id]));
      anchorIndexRef.current = index >= 0 ? index : null;
    },
    []
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorIndexRef.current = null;
  }, []);

  const pruneSelection = useCallback((validIds: readonly string[]) => {
    const validSet = new Set(validIds);
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, []);

  return useMemo(
    () => ({
      selectedIds,
      isSelected,
      selectItem,
      clearSelection,
      pruneSelection,
      selectedCount: selectedIds.size,
    }),
    [selectedIds, isSelected, selectItem, clearSelection, pruneSelection]
  );
}
