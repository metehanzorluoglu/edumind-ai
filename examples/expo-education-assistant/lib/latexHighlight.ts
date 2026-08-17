import Prism from 'prismjs';
import 'prismjs/components/prism-latex';
import type { Theme } from './Preferences';

/**
 * Milestone 5.5.1 Part 11-14 — LaTeX syntax highlighting, web only
 * (see components/writing/LatexCodeEditor.tsx for the native fallback).
 * Uses prismjs's OWN bundled "latex" grammar (components/prism-latex.js)
 * unmodified — the token types below (comment/string/keyword/url/
 * class-name/selector/regex/punctuation) are exactly what that grammar
 * emits, not an invented scheme. prismjs was chosen over CodeMirror/
 * Monaco specifically for this: a mature, single-purpose tokenizer with
 * no editor/UI opinions of its own to fight — react-simple-code-editor
 * supplies the actual editing surface (native textarea) separately.
 *
 * Colors are resolved from the app's OWN theme tokens (never hardcoded
 * hexes) via Prism's documented `hooks.add('wrap', ...)` extension
 * point, so highlighting repaints correctly on a light/dark toggle
 * without needing a companion stylesheet or CSS class definitions to
 * keep in sync — the same "no separate visual system to maintain"
 * reasoning as the rest of this app's theme-driven styling.
 */

let hookRegistered = false;
// Mutable by design: Prism.hooks are process-global, but Prism.highlight
// is synchronous, so setting this immediately before each call (see
// highlightLatex below) is race-free in JS's single-threaded model —
// no concurrent highlight() call can observe a different value.
let currentStyleByTokenType: Record<string, string> = {};

function ensureHookRegistered(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  Prism.hooks.add(
    'wrap',
    (env: { type: string; classes: string[]; attributes: Record<string, string> }) => {
      // `env.type` is only the token's OWN grammar key (e.g. "function"
      // for a command name) — prism-latex.js aliases several of those
      // to friendlier names (e.g. "selector") via `alias: 'selector'`,
      // and the alias only shows up in `env.classes` (Prism.
      // Token.stringify pushes both the real type and every alias in
      // there — see prism.js's own `env.classes.push(aliases)`), never
      // in `env.type` itself. Checking classes (not just type) is what
      // makes tokenStylesForTheme's alias-keyed entries ("selector",
      // "class-name", "regex") actually take effect.
      const style = env.classes.map((cls) => currentStyleByTokenType[cls]).find(Boolean);
      if (style) {
        env.attributes.style = style;
      }
    }
  );
}

function tokenStylesForTheme(theme: Theme): Record<string, string> {
  return {
    comment: `color:${theme.faint};font-style:italic;`,
    // "equation" is aliased to 'string' by prism-latex's own grammar.
    string: `color:${theme.citation};`,
    // \cite{...}/\ref{...}/\label{...}/\usepackage{...} arguments.
    keyword: `color:${theme.accent};`,
    url: `color:${theme.accent};text-decoration:underline;`,
    // "headline" (section/chapter/... arguments) is aliased to 'class-name'.
    'class-name': `color:${theme.text};font-weight:600;`,
    // "function" (the command name itself, e.g. \section) is aliased to 'selector'.
    selector: `color:${theme.accent};font-weight:600;`,
    // "equation-command" (a command used INSIDE math mode) is aliased to 'regex'.
    regex: `color:${theme.citation};`,
    punctuation: `color:${theme.subtext};`,
  };
}

/** Returns Prism-tokenized LaTeX as an HTML string with inline,
 * theme-derived colors — passed directly as react-simple-code-editor's
 * `highlight` prop. */
export function highlightLatex(code: string, theme: Theme): string {
  // `Prism.languages` is a plain index signature (any string key is
  // theoretically valid), so TS sees this lookup as possibly
  // undefined even though importing 'prismjs/components/prism-latex'
  // above unconditionally registers it. Falling back to the raw,
  // HTML-escaped code rather than asserting non-null keeps this
  // function total (never throws) even in some future/edge bundling
  // arrangement where that side effect somehow didn't run.
  const grammar = Prism.languages.latex;
  if (!grammar) {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  ensureHookRegistered();
  currentStyleByTokenType = tokenStylesForTheme(theme);
  return Prism.highlight(code, grammar, 'latex');
}
