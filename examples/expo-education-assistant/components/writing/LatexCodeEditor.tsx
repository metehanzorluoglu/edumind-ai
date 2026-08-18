import getCaretCoordinates from 'textarea-caret';
import type React from 'react';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Editor from 'react-simple-code-editor';
import { Platform, TextInput } from 'react-native';
import {
  applySuggestion,
  detectAutocompleteContext,
  getSuggestions,
  type AutocompleteData,
  type AutocompleteSuggestion,
} from '@/lib/latexAutocomplete';
import { highlightLatex } from '@/lib/latexHighlight';
import type { Theme } from '@/lib/Preferences';

export interface LatexCodeEditorHandle {
  focus: () => void;
}

interface LatexCodeEditorProps {
  value: string;
  onValueChange: (text: string) => void;
  selection: { start: number; end: number };
  onSelectionChange: (next: { start: number; end: number }) => void;
  editable: boolean;
  placeholder?: string;
  theme: Theme;
  /** Milestone 5.5 Part 12's Cmd/Ctrl+S/Enter/K handler — see [id].tsx's
   * handleShortcutKey. Wired the same way the old plain TextInput's
   * onKeyPress was: RNW/DOM elements stop keydown propagation while
   * focused, so the document-level listener alone can't reach it. */
  onShortcutKeyDown?: (e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    preventDefault: () => void;
  }) => void;
  autocompleteData: AutocompleteData;
  accessibilityLabel?: string;
  /** Milestone 5.5.3 — "go to line" (compiler diagnostics, Part 14's
   * own file/line navigation) previously only moved the caret/scroll —
   * manual testing found that alone doesn't read as "this is the line
   * the compiler referred to." Set this (with a freshly-changed
   * `token` — e.g. `Date.now()` — on every navigation, even to the
   * SAME line twice in a row) to flash-highlight that whole line for a
   * few seconds. `line` is 1-indexed, matching every other line number
   * in this app (diagnostics, offsetForLine). */
  flashLine?: { line: number; token: number } | null;
  /**
   * Milestone 5.5.3 continuation — PERSISTENT compiler-error
   * decoration, distinct from `flashLine` above (a temporary "you just
   * navigated here" band that fades on its own). A compilation error
   * is not merely a navigation event — the caller (already filtered to
   * whichever diagnostics name THIS file, by path) passes the current
   * failed compile's error lines here, and they stay decorated (a
   * gutter marker plus a whole-line background/underline — never an
   * invented character range) until the caller's own `compileState`
   * changes: a successful compile naturally produces an empty array
   * (clearing every mark), a different failed compile naturally
   * produces the NEW set (replacing the old one) — this component
   * itself does no lifecycle bookkeeping, it just renders whatever the
   * caller currently passes. 1-indexed, matching flashLine.
   */
  errorLines?: { line: number; message: string }[];
}

const DROPDOWN_WIDTH = 280;
const DROPDOWN_MAX_HEIGHT = 220;
// Milestone 5.5.3 continuation — the editor's own fixed per-line
// geometry, now that soft-wrapping is disabled (see the whiteSpace:
// 'pre' effect below): every logical line occupies EXACTLY one visual
// row of this height, at this top padding, so a line's Y position is
// simple arithmetic rather than a DOM measurement — matching lines 537
// / 557's own existing `paddingTop: 16` / `lineHeight: '20px'`
// hardcoded values (kept as the same two named constants here so the
// gutter, the flash band, and the persistent error decoration can
// never silently drift out of sync with each other).
const CONTENT_PADDING_TOP_PX = 16;
const LINE_HEIGHT_PX = 20;

/**
 * Milestone 5.5.1 Part 11-19 — the LaTeX source editor. Native (iOS/
 * Android) keeps the exact plain multiline TextInput this screen has
 * always used — unchanged, zero regression risk there. Web gets real
 * syntax highlighting (prismjs, via lib/latexHighlight.ts) and
 * autocomplete (lib/latexAutocomplete.ts) on top of
 * react-simple-code-editor — a ~200-line textarea-overlay editor
 * chosen specifically because it delegates ALL actual text editing
 * (cursor, selection, IME, copy/paste, native undo/redo, screen-reader
 * behavior) to a real `<textarea>`, rather than reimplementing any of
 * that. CodeMirror/Monaco were deliberately not used — see this
 * milestone's own report for the "smallest mature integration that
 * meets the requirements" reasoning.
 *
 * A raw DOM `<textarea>`, unlike react-native-web's TextInput, does
 * NOT stop keydown propagation — so in principle the document-level
 * shortcut listener in [id].tsx would already reach it unassisted, but
 * `onShortcutKeyDown` is still wired explicitly below for the same
 * belt-and-suspenders reason the old code documented: never depend on
 * unforced event bubbling for a release-critical shortcut path.
 */
export const LatexCodeEditor = forwardRef<LatexCodeEditorHandle, LatexCodeEditorProps>(
  function LatexCodeEditor(props, ref) {
    const {
      value,
      onValueChange,
      selection,
      onSelectionChange,
      editable,
      placeholder,
      theme,
      onShortcutKeyDown,
      autocompleteData,
      accessibilityLabel,
      flashLine,
      errorLines,
    } = props;

    const nativeInputRef = useRef<TextInput>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const textareaId = `latex-editor-${useId()}`;

    // "Latest" refs — the DOM listeners below are attached once per
    // textareaId (never re-subscribed on every keystroke's re-render),
    // so the callbacks they invoke are read through a ref that's kept
    // current instead of being a direct dependency.
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;
    const onShortcutKeyDownRef = useRef(onShortcutKeyDown);
    onShortcutKeyDownRef.current = onShortcutKeyDown;

    const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
    const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null);
    const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

    // Milestone 5.5.1 Part 15-19 — pure derivation from value/selection,
    // no DOM access needed (see lib/latexAutocomplete.ts) — recomputed
    // synchronously on every keystroke/cursor move, never a render
    // behind. A real (non-collapsed) selection never triggers
    // autocomplete — it's ambiguous whether the researcher is about to
    // type over it or just reading, and Part 5's own selection-safety
    // fix already established "never surprise-mutate an active
    // selection" as this screen's convention.
    const autocompleteMatch = useMemo(() => {
      if (Platform.OS !== 'web' || !editable || selection.start !== selection.end) return null;
      const context = detectAutocompleteContext(value, selection.start);
      if (!context) return null;
      const suggestions = getSuggestions(context, autocompleteData);
      if (suggestions.length === 0) return null;
      const key = `${context.kind}:${context.rangeStart}:${context.rangeEnd}`;
      return { context, suggestions, key };
    }, [value, selection.start, selection.end, editable, autocompleteData]);

    const autocompleteOpen =
      autocompleteMatch !== null && autocompleteMatch.key !== dismissedContextKey;

    // Milestone 5.5.3 — line-number gutter, similar in principle to
    // Overleaf. Width expands with the actual line count (never a
    // fixed guess) so it stays correctly sized from a 10-line file up
    // through 1,000+ lines without ever clipping a digit. ~7.8px is
    // this editor's own monospace digit width at font-size 13 — a
    // measured constant, not calculated per-render (avoids a DOM
    // measurement on every keystroke for what only ever changes when
    // the digit COUNT changes, i.e. crossing a power of ten).
    const lineCount = useMemo(() => value.split('\n').length, [value]);
    const gutterWidth = useMemo(
      () => Math.max(32, Math.ceil(Math.log10(lineCount + 1)) * 8 + 24),
      [lineCount]
    );
    // A single `white-space: pre` text block (ONE DOM text node) rather
    // than one element per line — real files run to 1,000+ lines, and
    // a per-line <div> would mean that many extra DOM nodes recreated
    // on every keystroke. `textAlign: 'right'` right-aligns each
    // newline-delimited row within the block on its own, no per-row
    // markup needed for that either.
    const gutterText = useMemo(
      () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
      [lineCount]
    );

    // Milestone 5.5.3 continuation — persistent error decoration's own
    // Y positions, computed the SAME way the gutter computes each
    // number's row (fixed arithmetic, not a DOM measurement) — valid
    // now that soft-wrapping is disabled, so one logical line really is
    // one visual row. Clamped into [0, lineCount) so a stale diagnostic
    // referencing a line past the CURRENT (edited-since) end of the
    // file never renders below the real content. Recomputed whenever
    // either the diagnostics themselves or the file's own line count
    // changes (an edit can shift how many lines exist).
    const errorLineMarks = useMemo(() => {
      if (!errorLines || errorLines.length === 0) return [];
      const seen = new Set<number>();
      const marks: { line: number; top: number; message: string }[] = [];
      for (const { line, message } of errorLines) {
        const clamped = Math.max(1, Math.min(line, lineCount));
        if (seen.has(clamped)) continue;
        seen.add(clamped);
        marks.push({
          line: clamped,
          top: CONTENT_PADDING_TOP_PX + (clamped - 1) * LINE_HEIGHT_PX,
          message,
        });
      }
      return marks;
    }, [errorLines, lineCount]);

    useEffect(() => {
      setSelectedSuggestionIndex(0);
    }, [autocompleteMatch?.key]);

    function acceptSuggestion(suggestion: AutocompleteSuggestion): void {
      if (!autocompleteMatch) return;
      const result = applySuggestion(value, autocompleteMatch.context, suggestion);
      onValueChange(result.text);
      onSelectionChange({ start: result.cursor, end: result.cursor });
    }

    // Milestone 5.5.1 Part 25 native-parity note — the native branch
    // below is intentionally untouched from the pre-5.5.1 implementation.
    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          if (Platform.OS !== 'web') {
            nativeInputRef.current?.focus();
            return;
          }
          if (typeof document === 'undefined') return;
          const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
          el?.focus();
        },
      }),
      [textareaId]
    );

    // react-simple-code-editor's Props type is `HTMLAttributes<HTMLDivElement>
    // & {...}` — any prop not in its own explicit list (like aria-label)
    // would spread onto the WRAPPING div via its own `...rest`, not onto
    // the actual <textarea> a screen reader focuses. Setting it directly
    // on the real textarea node is the only way to label the right element.
    useEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined' || !accessibilityLabel) return;
      const el = document.getElementById(textareaId);
      el?.setAttribute('aria-label', accessibilityLabel);
    }, [textareaId, accessibilityLabel]);

    // Milestone 5.5.3 — real-browser validation (mouse wheel positioned
    // directly over the textarea, on a document long enough to actually
    // need scrolling) found react-simple-code-editor's OWN default
    // textarea style sets `overflow-y: hidden`. That does not disable
    // scrolling outright — keyboard cursor movement past the fold and
    // direct `el.scrollTop =` assignment both still worked, confirmed by
    // testing each independently — but it DOES suppress the browser's
    // native wheel-to-scroll gesture specifically, which is how most
    // people actually try to scroll a text area. This is a real,
    // separate defect from Part 1's highlight-overlay desync (the two
    // look similar — "the editor doesn't scroll right" — but have
    // different causes: that one was the highlighted <pre> layer
    // failing to follow an ALREADY-scrolling textarea; this one is the
    // textarea itself refusing the wheel gesture in the first place).
    // The library exposes no prop to override this (its own `style`
    // prop, per its source, only ever reaches the outer wrapping div —
    // see the aria-label effect's own comment above for the same
    // constraint), so it's set directly on the real DOM node here,
    // matching every other imperative fix in this file.
    useEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      if (el) el.style.overflowY = 'auto';
    }, [textareaId]);

    // Milestone 5.5.3 continuation — real-browser testing with a
    // genuinely long line (a real .bib entry, a long \bibitem, a long
    // comment — not just MANY short lines) found the line-number
    // gutter drifting out of sync and eventually running out of
    // numbers before the real end of the source. Root cause:
    // react-simple-code-editor's own default style sets
    // `white-space: pre-wrap` on BOTH the textarea and the highlighted
    // <pre> (confirmed by reading its source — see the aria-label
    // effect's own comment for why this can only be overridden
    // imperatively, on the real DOM nodes, not via this component's
    // own `style` prop). A logical line LONGER than the editor's width
    // silently wraps into 2+ VISUAL rows — but the gutter lays out its
    // numbers at a FIXED 20px per LOGICAL line (this editor's own
    // line-height), correct only when every logical line occupies
    // exactly one visual row. Once wrapping happens even once, the
    // gutter's total height (lineCount * 20px) is SMALLER than the
    // textarea's real scrollable content height, so scrolling to the
    // true end of the file scrolls the gutter past its own last
    // number while real text keeps going.
    //
    // Fix: disable soft-wrapping entirely — one row per logical line,
    // always, with horizontal scroll for anything that overflows,
    // matching how source-code editors (this feature's own explicit
    // "Overleaf-style" target) handle long lines. This is what makes a
    // fixed-height-per-line gutter geometrically correct at all. The
    // existing scroll-sync effect above already transforms the <pre>
    // by `-el.scrollLeft` too (previously dormant — wrapped content
    // rarely needed horizontal scroll; now load-bearing).
    useEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      const pre = wrapperRef.current?.querySelector('pre') ?? null;
      if (el) {
        el.style.whiteSpace = 'pre';
        el.style.overflowX = 'auto';
      }
      if (pre) {
        (pre as HTMLElement).style.whiteSpace = 'pre';
      }
    }, [textareaId]);

    // Milestone 5.5.2 Part 1 — real-browser validation with a document
    // long enough to actually scroll (M5.5.1's own testing never used
    // one) found the root cause of the reported "typed characters don't
    // appear where the caret is shown" / highlighted-vs-editable-text
    // divergence: react-simple-code-editor overlays a highlighted <pre>
    // UNDER the real (transparent-text) <textarea>, but never syncs the
    // <pre>'s scrollTop/scrollLeft to the textarea's own — confirmed by
    // reading its source (no scroll listener anywhere in the package).
    // Scrolling the textarea (mouse wheel, arrow keys past the fold,
    // clicking a line off-screen) leaves the highlighted layer frozen
    // wherever it last was, so the visible (pre-rendered) text and the
    // real caret position drift apart by exactly the missed scroll
    // distance — the textarea itself was never miscomputing anything.
    // This is the library's own well-known integration requirement for
    // ANY consumer with scrollable content, not a coordinate offset to
    // patch around.
    useEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      const wrapEl = wrapperRef.current;
      if (!el || !wrapEl) return;
      const pre = wrapEl.querySelector('pre') as HTMLElement | null;
      if (!pre) return;
      // Milestone 5.5.3 — the line-number gutter (below) is driven by
      // this SAME scroll-sync mechanism, not an independently
      // scrolling text copy of its own: one real scroll source (the
      // textarea), transformed onto every layer that needs to visually
      // track it. Only the vertical component applies to the gutter —
      // it's pinned to the wrapper's own left edge and must never
      // shift when a long line scrolls the textarea horizontally.
      const gutter = wrapEl.querySelector('[data-latex-gutter-lines]') as HTMLElement | null;
      // Milestone 5.5.3 continuation — the persistent error-decoration
      // layer (below) rides the SAME transform-sync as the gutter: a
      // fixed-position band computed once from line arithmetic, then
      // moved vertically by whatever the real scroll offset currently
      // is — never an independently-scrolling copy of its own, same
      // discipline as the gutter's own comment already documents.
      const errorLayer = wrapEl.querySelector('[data-latex-error-lines]') as HTMLElement | null;
      // The <pre> has no `overflow`/fixed-height of its own — it's a
      // plain block sized to its FULL content height (confirmed via
      // real-browser inspection: a long document's <pre> measured
      // several thousand px tall), simply clipped by this wrapper's own
      // `overflow: hidden`. It is therefore NOT a scroll container —
      // setting `pre.scrollTop` is a silent no-op. Shifting it with a
      // transform achieves the same visual effect (the correct slice of
      // the tall, pre-rendered highlighted content lines up with
      // whatever the textarea's real internal scroll position is).
      const sync = (): void => {
        pre.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
        if (gutter) gutter.style.transform = `translateY(${-el.scrollTop}px)`;
        if (errorLayer) errorLayer.style.transform = `translateY(${-el.scrollTop}px)`;
      };
      sync();
      el.addEventListener('scroll', sync);
      return () => el.removeEventListener('scroll', sync);
    }, [textareaId]);

    // Real-browser validation (Part 11) caught a genuine race here: the
    // original guard below compared the incoming `selection` PROP
    // against the DOM's CURRENT (real-time) selection, on the
    // assumption that they'd already match for an ordinary typing echo.
    // But React state updates are async — while the user is typing
    // quickly, the DOM can already be several keystrokes ahead of
    // whatever stale `selection` value this component's last COMMITTED
    // render still holds, so that comparison found a mismatch and
    // yanked the caret BACKWARD to the stale position mid-keystroke,
    // corrupting exactly where subsequent characters landed. Tracking
    // what THIS component itself last reported (via the listener below)
    // and skipping re-application whenever the incoming prop is just
    // that value's own echo — regardless of what the DOM has moved on
    // to since — fixes it: only a genuinely EXTERNAL selection change
    // (one this component never reported itself) should ever move the
    // caret imperatively.
    const lastReportedSelectionRef = useRef<{ start: number; end: number } | null>(null);

    // Selection tracking: a native <textarea>'s selection can change via
    // typing, arrow keys, mouse drag, or Shift+click/arrow — 'select' via
    // document-level 'selectionchange' (filtered to when this textarea is
    // actually focused) covers all of those in one listener in every
    // evergreen browser; 'keyup'/'click' are a cheap, redundant fallback.
    useEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      if (!el) return;
      const sync = (): void => {
        if (document.activeElement !== el) return;
        const next = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
        lastReportedSelectionRef.current = next;
        onSelectionChangeRef.current(next);
      };
      document.addEventListener('selectionchange', sync);
      el.addEventListener('keyup', sync);
      el.addEventListener('click', sync);
      return () => {
        document.removeEventListener('selectionchange', sync);
        el.removeEventListener('keyup', sync);
        el.removeEventListener('click', sync);
      };
    }, [textareaId]);

    // Applies an EXTERNALLY-driven selection change (file switch's
    // remembered-cursor restore, Part 14's diagnostic "go to line", or
    // insertAtCursor's own post-insert cursor placement) to the real DOM
    // selection. Guarded so it never fights the user's own live
    // typing/clicking — see lastReportedSelectionRef's own comment above
    // for why that guard compares against what THIS component last
    // reported, not the DOM's live selection.
    useLayoutEffect(() => {
      if (Platform.OS !== 'web' || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      if (!el) return;
      const last = lastReportedSelectionRef.current;
      if (last && last.start === selection.start && last.end === selection.end) return;
      el.setSelectionRange(selection.start, selection.end);
      lastReportedSelectionRef.current = { start: selection.start, end: selection.end };
      // Bring the caret into view for a jump the user didn't scroll to
      // themselves (diagnostic "go to line" is the whole point of this —
      // see CompileDiagnostics.tsx's handleOpenDiagnostic). getCaretCoordinates
      // returns a position relative to the textarea's own unscrolled content
      // box, so comparing it against the current scroll offset tells us
      // whether the caret is currently out of view.
      try {
        const caret = getCaretCoordinates(el, selection.start);
        if (caret.top < el.scrollTop) {
          el.scrollTop = caret.top;
        } else if (caret.top + caret.height > el.scrollTop + el.clientHeight) {
          el.scrollTop = caret.top + caret.height - el.clientHeight;
        }
      } catch {
        // getCaretCoordinates only throws outside a browser — never in
        // this Platform.OS === 'web' branch — but a scroll nicety is
        // never worth a hard crash if some edge environment disagrees.
      }
    }, [textareaId, selection.start, selection.end, value]);

    // Positions the autocomplete dropdown just below the caret,
    // clamped so it never renders outside the editor's own bounds
    // (same clamping idea as ActionSheet.tsx's popoverPosition).
    useLayoutEffect(() => {
      if (Platform.OS !== 'web' || !autocompleteOpen || typeof document === 'undefined') {
        setDropdownPos(null);
        return;
      }
      const wrapEl = wrapperRef.current;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      if (!wrapEl || !el) return;
      const caret = getCaretCoordinates(el, selection.start);
      const taRect = el.getBoundingClientRect();
      const wrapRect = wrapEl.getBoundingClientRect();
      const top = taRect.top - wrapRect.top + caret.top - el.scrollTop + caret.height + 4;
      const rawLeft = taRect.left - wrapRect.left + caret.left - el.scrollLeft;
      const left = Math.max(0, Math.min(rawLeft, wrapRect.width - DROPDOWN_WIDTH));
      setDropdownPos({ top, left });
    }, [textareaId, autocompleteOpen, selection.start]);

    // Milestone 5.5.3 — "go to line" full-line flash highlight. A
    // full-width horizontal band at the target line's Y position (not
    // an underline of just its text) reads unambiguously as "this
    // whole line," matching most IDEs' own "current line" convention.
    // Self-contained: given just a 1-indexed line number, it finds that
    // line's own start offset from the CURRENT `value` — no
    // coordination needed with the caller beyond "here's a line
    // number and a fresh token."
    const [flashRect, setFlashRect] = useState<{
      top: number;
      width: number;
      height: number;
    } | null>(null);
    const [flashVisible, setFlashVisible] = useState(false);
    useLayoutEffect(() => {
      if (Platform.OS !== 'web' || !flashLine || typeof document === 'undefined') return;
      const el = document.getElementById(textareaId) as HTMLTextAreaElement | null;
      const wrapEl = wrapperRef.current;
      if (!el || !wrapEl) return;
      const lines = value.split('\n');
      const targetIndex = Math.max(0, Math.min(flashLine.line - 1, lines.length - 1));
      let lineStart = 0;
      for (let i = 0; i < targetIndex; i += 1) lineStart += lines[i]!.length + 1;
      const caret = getCaretCoordinates(el, lineStart);
      const taRect = el.getBoundingClientRect();
      const wrapRect = wrapEl.getBoundingClientRect();
      setFlashRect({
        top: taRect.top - wrapRect.top + caret.top - el.scrollTop,
        width: wrapRect.width,
        height: caret.height,
      });
      setFlashVisible(true);
      // Visible long enough to orient ("keep the highlight visible long
      // enough for the user to orient themselves"), then fades via the
      // CSS transition on opacity below, then unmounts once fully
      // transparent.
      const fadeTimer = setTimeout(() => setFlashVisible(false), 1600);
      const removeTimer = setTimeout(() => setFlashRect(null), 2200);
      return () => {
        clearTimeout(fadeTimer);
        clearTimeout(removeTimer);
      };
      // Deliberately keyed on the token, not `value` — this must fire
      // exactly once per navigation request, including a re-request of
      // the SAME line, never re-run on every keystroke.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flashLine?.token, textareaId]);

    if (Platform.OS !== 'web') {
      return (
        <TextInput
          ref={nativeInputRef}
          value={value}
          onChangeText={onValueChange}
          selection={selection}
          onSelectionChange={(e) => onSelectionChange(e.nativeEvent.selection)}
          multiline
          editable={editable}
          style={{
            flex: 1,
            fontFamily: theme.fonts.mono,
            fontSize: 13,
            lineHeight: 20,
            color: theme.text,
            backgroundColor: theme.cardPressed,
            borderRadius: theme.radius.md,
            padding: 16,
          }}
          placeholder={placeholder}
          placeholderTextColor={theme.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          textAlignVertical="top"
          accessibilityLabel={accessibilityLabel}
        />
      );
    }

    function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
      if (autocompleteOpen && autocompleteMatch) {
        const { suggestions } = autocompleteMatch;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedSuggestionIndex((i) => (i + 1) % suggestions.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          acceptSuggestion(suggestions[selectedSuggestionIndex] ?? suggestions[0]!);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setDismissedContextKey(autocompleteMatch.key);
          return;
        }
      }
      onShortcutKeyDownRef.current?.(
        e as unknown as Parameters<NonNullable<typeof onShortcutKeyDown>>[0]
      );
    }

    return (
      <div
        ref={wrapperRef}
        style={{
          position: 'relative',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          borderRadius: theme.radius.md,
          overflow: 'hidden',
        }}
      >
        {/* Milestone 5.5.3 continuation — PERSISTENT compiler-error
            decoration (distinct from the temporary flash band below):
            a whole-line tint + bottom underline for every current
            error line in THIS file, scroll-synced the same way the
            gutter is (via `[data-latex-error-lines]`) — never an
            invented character range, and never left stale: the caller
            derives `errorLines` fresh from its own compile state on
            every render, so a successful recompile or a different
            failed one naturally replaces what's shown here. */}
        {errorLineMarks.length > 0 && (
          <div
            data-latex-error-lines
            aria-hidden="true"
            style={{ position: 'absolute', left: 0, right: 0, top: 0, pointerEvents: 'none' }}
          >
            {errorLineMarks.map((mark) => (
              <div
                key={`error-line-${mark.line}`}
                title={mark.message}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: mark.top,
                  height: LINE_HEIGHT_PX,
                  backgroundColor: theme.dangerSoft,
                  borderBottomWidth: 2,
                  borderBottomColor: theme.danger,
                  borderBottomStyle: 'solid',
                }}
              />
            ))}
          </div>
        )}
        {flashRect && (
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: flashRect.top,
              width: flashRect.width,
              height: flashRect.height,
              backgroundColor: theme.accentSoft,
              opacity: flashVisible ? 1 : 0,
              transition: 'opacity 600ms ease-out',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        )}
        {/* Milestone 5.5.3 — the line-number gutter. Opaque (its own
            background) and a higher z-index than the flash-highlight
            band above, so a flashed line's tint never bleeds into the
            gutter's own numbers oddly. Scroll-synced by the SAME
            effect that syncs the highlighted <pre> layer (see its own
            comment) via `[data-latex-gutter-lines]` — never an
            independently scrolling copy. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: gutterWidth,
            overflow: 'hidden',
            backgroundColor: theme.card,
            borderRightWidth: 1,
            borderRightColor: theme.border,
            borderRightStyle: 'solid',
            zIndex: 2,
            pointerEvents: 'none',
          }}
        >
          {/* Milestone 5.5.3 continuation — the gutter's own persistent
              error MARKER (a colored bar at the affected line's own
              row number) — a sibling of the numbers text, both inside
              this SAME `data-latex-gutter-lines` wrapper so one
              transform assignment in the scroll-sync effect moves them
              together; never a second, independently-tracked copy. */}
          <div data-latex-gutter-lines style={{ position: 'relative' }}>
            {errorLineMarks.map((mark) => (
              <div
                key={`gutter-mark-${mark.line}`}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: mark.top,
                  width: 4,
                  height: LINE_HEIGHT_PX,
                  backgroundColor: theme.danger,
                }}
              />
            ))}
            <div
              data-latex-gutter-numbers
              style={{
                paddingTop: CONTENT_PADDING_TOP_PX,
                paddingRight: 8,
                whiteSpace: 'pre',
                fontSize: 13,
                fontFamily: theme.fonts.mono,
                lineHeight: `${LINE_HEIGHT_PX}px`,
                color: theme.faint,
                textAlign: 'right',
              }}
            >
              {gutterText}
            </div>
          </div>
        </div>
        <Editor
          value={value}
          onValueChange={onValueChange}
          highlight={(code) => highlightLatex(code, theme)}
          disabled={!editable}
          textareaId={textareaId}
          placeholder={placeholder}
          padding={{
            top: CONTENT_PADDING_TOP_PX,
            right: 16,
            bottom: 16,
            left: gutterWidth + 8,
          }}
          tabSize={2}
          // react-simple-code-editor's Props type extends BOTH
          // HTMLAttributes<HTMLDivElement> (its own wrapping div) AND
          // separately redeclares onKeyDown typed for HTMLTextAreaElement
          // (the one that's actually forwarded to the real textarea, per
          // its own source) — TS intersects the two into an
          // unsatisfiable KeyboardEventHandler<Div> & KeyboardEventHandler
          // <TextArea>. The cast reflects what the library's own runtime
          // behavior actually does (always the textarea's event).
          onKeyDown={
            handleTextareaKeyDown as unknown as React.KeyboardEventHandler<HTMLDivElement> &
              React.KeyboardEventHandler<HTMLTextAreaElement>
          }
          style={{
            flex: 1,
            height: '100%',
            minHeight: 0,
            fontFamily: theme.fonts.mono,
            fontSize: 13,
            lineHeight: '20px',
            color: theme.text,
            backgroundColor: theme.cardPressed,
          }}
        />
        {autocompleteOpen && autocompleteMatch && dropdownPos && (
          <div
            role="listbox"
            aria-label="LaTeX autocomplete suggestions"
            style={{
              position: 'absolute',
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: DROPDOWN_WIDTH,
              maxHeight: DROPDOWN_MAX_HEIGHT,
              overflowY: 'auto',
              backgroundColor: theme.card,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radius.md,
              boxShadow: '0 4px 20px rgba(0,0,0,0.16)',
              padding: 4,
              zIndex: 40,
            }}
          >
            {autocompleteMatch.suggestions.map((suggestion, index) => (
              <div
                key={`${suggestion.kind}:${suggestion.label}:${index}`}
                role="option"
                aria-selected={index === selectedSuggestionIndex}
                // Prevents the textarea from ever losing focus on click —
                // the accept still happens via the click that follows.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => acceptSuggestion(suggestion)}
                onMouseEnter={() => setSelectedSuggestionIndex(index)}
                style={{
                  padding: '6px 8px',
                  borderRadius: theme.radius.sm,
                  cursor: 'pointer',
                  backgroundColor:
                    index === selectedSuggestionIndex ? theme.accentSoft : 'transparent',
                }}
              >
                <div style={{ fontFamily: theme.fonts.mono, fontSize: 13, color: theme.text }}>
                  {suggestion.label}
                </div>
                {suggestion.detail && (
                  <div style={{ fontSize: 11, color: theme.subtext, marginTop: 2 }}>
                    {suggestion.detail}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);
