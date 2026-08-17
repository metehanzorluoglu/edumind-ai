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
}

const DROPDOWN_WIDTH = 280;
const DROPDOWN_MAX_HEIGHT = 220;

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
          minHeight: 0,
          borderRadius: theme.radius.md,
          overflow: 'hidden',
        }}
      >
        <Editor
          value={value}
          onValueChange={onValueChange}
          highlight={(code) => highlightLatex(code, theme)}
          disabled={!editable}
          textareaId={textareaId}
          placeholder={placeholder}
          padding={16}
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
