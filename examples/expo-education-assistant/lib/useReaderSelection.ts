import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { DocumentHighlightVisualAnchor } from 'education-assistant-client';

export interface ReaderSelection {
  /** The exact selected passage — never a paraphrase or a surrounding
   * expansion, per Frontend Milestone 3 §14/§15: this is the ONE thing
   * that becomes primary AI context, so it must be exactly what the user
   * highlighted, nothing more. */
  text: string;
  /**
   * Frontend Milestone 3.1: optional as of the original-PDF reader — a
   * selection made directly on the PDF's text layer may not best-effort
   * match any existing chunk (see lib/pdfHighlightGeometry.ts's
   * matchSelectionToChunk), in which case both are undefined and the
   * resulting highlight is saved visual-only. A selection made in the
   * extracted-text reader (ReaderContent) always has both, exactly as
   * before this milestone.
   */
  chunkId?: string;
  chunkIndex?: number;
  pageNumber: number;
  /** Viewport-relative bounding rect of the selection — positions the
   * floating contextual toolbar right next to it. */
  rect: { top: number; left: number; width: number; height: number };
  /** Frontend Milestone 3.1: the VISUAL anchor (PDF-space rects) — set
   * only for a selection captured from the original PDF's text layer
   * (see PdfReader); undefined for an extracted-text selection, which has
   * no PDF geometry to anchor to. */
  visualAnchor?: DocumentHighlightVisualAnchor;
}

/**
 * Frontend Milestone 3 (Document Reader) — web-only real text-selection
 * tracking. ReaderContent renders each chunk inside a host element
 * carrying `data-chunk-id`/`data-chunk-index`/`data-page-number` (the
 * same "escape react-native-web to a raw DOM attribute" technique
 * Milestone 1's drag-and-drop already established — see
 * lib/useLibraryDnD.ts) so a selection can be traced back to exactly
 * which chunk it started in via `selection.anchorNode`.
 *
 * A selection spanning more than one chunk is anchored to wherever it
 * STARTED (anchorNode, not focusNode/extentNode) — good enough for "which
 * passage is this," and documented rather than silently mishandled: see
 * the Frontend Milestone 3 report's Selection Architecture section.
 *
 * Mobile has no reliable cross-platform `selectionchange`-equivalent for
 * React Native Text — see ReaderContent's own long-press fallback for
 * the non-web selection story (§30/§31: selection actions must not be
 * the ONLY way to highlight/ask on mobile).
 */
export function useReaderSelection(containerRef: { current: HTMLElement | null }): {
  selection: ReaderSelection | null;
  clear: () => void;
} {
  const [selection, setSelection] = useState<ReaderSelection | null>(null);

  const clear = useCallback(() => {
    // typeof window.getSelection === 'function' (not just `typeof window
    // !== 'undefined'`): this app's RN-Web-backed test environment
    // provides a `window` global without a real `getSelection`
    // implementation — calling it unconditionally there throws rather
    // than being a harmless no-op.
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.getSelection === 'function') {
      window.getSelection()?.removeAllRanges();
    }
    setSelection(null);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;

    function handleSelectionChange(): void {
      const container = containerRef.current;
      const domSelection = window.getSelection();
      if (
        !container ||
        !domSelection ||
        domSelection.isCollapsed ||
        domSelection.rangeCount === 0
      ) {
        setSelection(null);
        return;
      }
      const text = domSelection.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const anchorNode = domSelection.anchorNode;
      if (!anchorNode || !container.contains(anchorNode)) {
        // Selection lives outside the reader content (e.g. the sidebar) —
        // never treated as a reader selection.
        setSelection(null);
        return;
      }
      const anchorElement =
        anchorNode.nodeType === Node.ELEMENT_NODE
          ? (anchorNode as HTMLElement)
          : anchorNode.parentElement;
      const chunkElement = anchorElement?.closest('[data-chunk-id]') as HTMLElement | null;
      if (!chunkElement) {
        setSelection(null);
        return;
      }
      const range = domSelection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }
      setSelection({
        text,
        chunkId: chunkElement.dataset.chunkId ?? '',
        chunkIndex: Number(chunkElement.dataset.chunkIndex ?? '0'),
        pageNumber: Number(chunkElement.dataset.pageNumber ?? '1'),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      });
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { selection, clear };
}
