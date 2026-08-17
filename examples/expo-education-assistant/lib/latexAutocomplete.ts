/**
 * Milestone 5.5.1 Part 15-19 — LaTeX editor autocomplete.
 *
 * Pure, DOM-free logic (all string/offset math), independently unit-
 * testable without a real browser or the react-simple-code-editor/
 * prismjs dependency this feeds — those two only ever call INTO this
 * module (see components/writing/LatexCodeEditor.tsx), never the
 * reverse. Three completion sources, matching the spec's own list —
 * LaTeX commands (a curated, static set — this is deliberately NOT a
 * full LaTeX symbol/package command database; see LATEX_COMMANDS'
 * own comment), citation keys from the project's REAL, already-added
 * references (never invented), and project file paths (for
 * \input/\include) — and nothing else; no snippet engine, no
 * arbitrary-package awareness, matching Part 41's non-goals.
 *
 * Context detection is intentionally conservative, the same
 * "false negatives acceptable, false positives are not" ethos
 * documented on the compiler's own log_sanitizer.py: a bounded
 * backward scan (never the whole document) that gives up (returns
 * null — no suggestions, not wrong ones) rather than guess through
 * anything unusual (escaped braces, verbatim blocks, multi-paragraph
 * gaps). Autocomplete that occasionally doesn't fire is a minor
 * inconvenience; autocomplete that inserts the wrong thing into a
 * researcher's manuscript is a real bug.
 */

export type AutocompleteKind = 'command' | 'citation' | 'file';

export interface AutocompleteSuggestion {
  kind: AutocompleteKind;
  /** Shown as the suggestion's primary label in the dropdown. */
  label: string;
  /** Shown as smaller secondary text (a reference's title, a command's description). */
  detail?: string;
  /** The literal text that replaces the matched query range. */
  insertText: string;
  /**
   * How far back from the END of insertText the cursor should land
   * after insertion — 0 places it at the very end (the common case:
   * finishing a citation key or file path). LaTeX commands that take
   * a mandatory argument (e.g. "section{}") place the cursor INSIDE
   * the braces instead, so typing the argument can continue
   * immediately without a manual left-arrow.
   */
  cursorOffsetFromEnd: number;
}

export interface AutocompleteContext {
  kind: AutocompleteKind;
  /** Offset where the matched query text begins (replaced on accept). */
  rangeStart: number;
  /** Offset where the matched query text ends — always the cursor position. */
  rangeEnd: number;
  query: string;
}

interface LatexCommandDef {
  /** Command name, without the leading backslash. */
  name: string;
  /** What gets inserted after the backslash — usually "name{}" or "name". */
  insertAfterBackslash: string;
  /** Whether insertAfterBackslash ends with a "{}" the cursor should land inside. */
  hasArgument: boolean;
  detail: string;
}

// Milestone 5.5.1 Part 15 — a curated set of the commands a researcher
// actually types constantly while drafting (sectioning, math, refs,
// figures/tables, emphasis), not an exhaustive database of every
// command any LaTeX package ever defines — that would need a live
// package-aware language server, well beyond "the smallest mature
// integration that meets the requirements" this milestone calls for.
export const LATEX_COMMANDS: LatexCommandDef[] = [
  {
    name: 'section',
    insertAfterBackslash: 'section{}',
    hasArgument: true,
    detail: 'Section heading',
  },
  {
    name: 'subsection',
    insertAfterBackslash: 'subsection{}',
    hasArgument: true,
    detail: 'Subsection heading',
  },
  {
    name: 'subsubsection',
    insertAfterBackslash: 'subsubsection{}',
    hasArgument: true,
    detail: 'Sub-subsection heading',
  },
  {
    name: 'paragraph',
    insertAfterBackslash: 'paragraph{}',
    hasArgument: true,
    detail: 'Paragraph heading',
  },
  {
    name: 'chapter',
    insertAfterBackslash: 'chapter{}',
    hasArgument: true,
    detail: 'Chapter heading (book/report classes)',
  },
  {
    name: 'label',
    insertAfterBackslash: 'label{}',
    hasArgument: true,
    detail: 'Cross-reference label',
  },
  { name: 'ref', insertAfterBackslash: 'ref{}', hasArgument: true, detail: 'Reference a \\label' },
  {
    name: 'eqref',
    insertAfterBackslash: 'eqref{}',
    hasArgument: true,
    detail: 'Reference an equation label',
  },
  { name: 'cite', insertAfterBackslash: 'cite{}', hasArgument: true, detail: 'Cite a reference' },
  {
    name: 'citep',
    insertAfterBackslash: 'citep{}',
    hasArgument: true,
    detail: 'Cite (parenthetical, natbib)',
  },
  {
    name: 'citet',
    insertAfterBackslash: 'citet{}',
    hasArgument: true,
    detail: 'Cite (textual, natbib)',
  },
  { name: 'textbf', insertAfterBackslash: 'textbf{}', hasArgument: true, detail: 'Bold text' },
  { name: 'textit', insertAfterBackslash: 'textit{}', hasArgument: true, detail: 'Italic text' },
  { name: 'emph', insertAfterBackslash: 'emph{}', hasArgument: true, detail: 'Emphasized text' },
  { name: 'footnote', insertAfterBackslash: 'footnote{}', hasArgument: true, detail: 'Footnote' },
  {
    name: 'caption',
    insertAfterBackslash: 'caption{}',
    hasArgument: true,
    detail: 'Figure/table caption',
  },
  {
    name: 'includegraphics',
    insertAfterBackslash: 'includegraphics{}',
    hasArgument: true,
    detail: 'Insert an image',
  },
  {
    name: 'input',
    insertAfterBackslash: 'input{}',
    hasArgument: true,
    detail: 'Include another .tex file',
  },
  {
    name: 'include',
    insertAfterBackslash: 'include{}',
    hasArgument: true,
    detail: 'Include another .tex file (own page)',
  },
  {
    name: 'usepackage',
    insertAfterBackslash: 'usepackage{}',
    hasArgument: true,
    detail: 'Load a package',
  },
  {
    name: 'documentclass',
    insertAfterBackslash: 'documentclass{}',
    hasArgument: true,
    detail: 'Set the document class',
  },
  {
    name: 'begin',
    insertAfterBackslash: 'begin{}',
    hasArgument: true,
    detail: 'Begin an environment',
  },
  { name: 'end', insertAfterBackslash: 'end{}', hasArgument: true, detail: 'End an environment' },
  { name: 'item', insertAfterBackslash: 'item ', hasArgument: false, detail: 'List item' },
  { name: 'frac', insertAfterBackslash: 'frac{}{}', hasArgument: true, detail: 'Fraction' },
  { name: 'sqrt', insertAfterBackslash: 'sqrt{}', hasArgument: true, detail: 'Square root' },
  { name: 'sum', insertAfterBackslash: 'sum', hasArgument: false, detail: 'Summation symbol' },
  { name: 'infty', insertAfterBackslash: 'infty', hasArgument: false, detail: 'Infinity symbol' },
  { name: 'alpha', insertAfterBackslash: 'alpha', hasArgument: false, detail: 'Greek letter α' },
  { name: 'beta', insertAfterBackslash: 'beta', hasArgument: false, detail: 'Greek letter β' },
  {
    name: 'newpage',
    insertAfterBackslash: 'newpage',
    hasArgument: false,
    detail: 'Force a page break',
  },
  {
    name: 'tableofcontents',
    insertAfterBackslash: 'tableofcontents',
    hasArgument: false,
    detail: 'Table of contents',
  },
  {
    name: 'maketitle',
    insertAfterBackslash: 'maketitle',
    hasArgument: false,
    detail: 'Render the title block',
  },
  {
    name: 'bibliography',
    insertAfterBackslash: 'bibliography{}',
    hasArgument: true,
    detail: 'Bibliography file (BibTeX)',
  },
  {
    name: 'bibliographystyle',
    insertAfterBackslash: 'bibliographystyle{}',
    hasArgument: true,
    detail: 'Bibliography style',
  },
];

const CITATION_COMMANDS = [
  'cite',
  'citep',
  'citet',
  'parencite',
  'textcite',
  'autocite',
  'citeauthor',
  'citeyear',
];
const FILE_COMMANDS = ['input', 'include', 'includegraphics'];

// Conservative bound on how far back the brace-matching scan looks —
// long enough to cover any realistic \cite{...}/\input{...} call
// (these are never more than a couple hundred characters in real
// manuscripts), short enough to keep every keystroke's context check
// O(1)-ish rather than O(document length).
const MAX_BACKWARD_SCAN = 400;

function isCommandNameChar(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

/**
 * Finds the nearest enclosing `{...}` argument the cursor sits inside
 * (if any), and the LaTeX command name immediately before its opening
 * brace (skipping one optional `[...]` group, e.g. `\cite[p.
 * 12]{<cursor>}`). Returns null if the cursor isn't inside such an
 * argument within MAX_BACKWARD_SCAN characters, or if brace nesting
 * doesn't resolve cleanly — the conservative "give up, don't guess"
 * case documented on the module.
 */
function findEnclosingCommandArgument(
  text: string,
  cursor: number
): { command: string; braceOpenIndex: number } | null {
  let depth = 0;
  const floor = Math.max(0, cursor - MAX_BACKWARD_SCAN);
  for (let i = cursor - 1; i >= floor; i -= 1) {
    const ch = text[i];
    if (ch === '\n' && cursor - i > 2 && text.slice(Math.max(0, i - 1), i + 2) === '\n\n') {
      // A blank-line paragraph break within the scan window — bail
      // out rather than assume a command argument spans it.
      return null;
    }
    if (ch === '}') {
      depth += 1;
    } else if (ch === '{') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      // Found our opening brace. Walk back further past an optional
      // "[...]" (e.g. \cite[see][p. 3]{...}) and then read the
      // command name.
      let j = i - 1;
      while (j >= floor && text[j] === ']') {
        let bracketDepth = 1;
        j -= 1;
        while (j >= floor && bracketDepth > 0) {
          if (text[j] === ']') bracketDepth += 1;
          else if (text[j] === '[') bracketDepth -= 1;
          j -= 1;
        }
      }
      const nameEnd = j + 1;
      let nameStart = nameEnd;
      while (nameStart > floor && isCommandNameChar(text[nameStart - 1]!)) {
        nameStart -= 1;
      }
      if (nameStart <= floor || text[nameStart - 1] !== '\\' || nameStart === nameEnd) {
        return null;
      }
      return { command: text.slice(nameStart, nameEnd), braceOpenIndex: i };
    }
  }
  return null;
}

/**
 * Determines what (if anything) should be autocompleted at `cursor`
 * within `text`. Checked in order: an in-progress bare `\command`
 * (no argument yet) always wins — it's the most common case and the
 * cheapest to detect; otherwise, whether the cursor sits inside a
 * citation or file-path command's argument.
 */
export function detectAutocompleteContext(
  text: string,
  cursor: number
): AutocompleteContext | null {
  if (cursor < 0 || cursor > text.length) return null;

  // Case 1: a bare "\word" being typed, not yet followed by "{" or
  // whitespace that would mark the command name as finished.
  let nameStart = cursor;
  while (nameStart > 0 && isCommandNameChar(text[nameStart - 1]!)) {
    nameStart -= 1;
  }
  if (nameStart > 0 && text[nameStart - 1] === '\\') {
    return {
      kind: 'command',
      rangeStart: nameStart,
      rangeEnd: cursor,
      query: text.slice(nameStart, cursor),
    };
  }

  // Case 2 / 3: inside a recognized command's {...} argument. Only the
  // LAST comma-separated segment (up to the cursor) is the query —
  // \cite{smith2020,jo<cursor> completes "jo", not the whole list.
  const enclosing = findEnclosingCommandArgument(text, cursor);
  if (!enclosing) return null;
  const isCitation = CITATION_COMMANDS.includes(enclosing.command);
  const isFile = FILE_COMMANDS.includes(enclosing.command);
  if (!isCitation && !isFile) return null;

  const argStart = enclosing.braceOpenIndex + 1;
  const argSoFar = text.slice(argStart, cursor);
  if (isCitation) {
    const lastComma = argSoFar.lastIndexOf(',');
    const segStart = argStart + (lastComma === -1 ? 0 : lastComma + 1);
    const query = text.slice(segStart, cursor).replace(/^\s+/, '');
    const rangeStart = segStart + (text.slice(segStart, cursor).length - query.length);
    return { kind: 'citation', rangeStart, rangeEnd: cursor, query };
  }
  // File-path arguments (\input, \include, \includegraphics) are
  // single-valued — no comma splitting.
  return { kind: 'file', rangeStart: argStart, rangeEnd: cursor, query: argSoFar };
}

export interface AutocompleteData {
  citationKeys: { key: string; title?: string | null }[];
  filePaths: string[];
}

const MAX_SUGGESTIONS = 8;

/** Case-insensitive "starts with" prefix filter, matching most code
 * editors' own default completion behavior — not a fuzzy matcher, to
 * keep the ranking obvious and the implementation small. */
function matchesQuery(candidate: string, query: string): boolean {
  return query.length === 0 || candidate.toLowerCase().startsWith(query.toLowerCase());
}

export function getSuggestions(
  context: AutocompleteContext,
  data: AutocompleteData
): AutocompleteSuggestion[] {
  if (context.kind === 'command') {
    return LATEX_COMMANDS.filter((cmd) => matchesQuery(cmd.name, context.query))
      .slice(0, MAX_SUGGESTIONS)
      .map((cmd) => ({
        kind: 'command' as const,
        label: `\\${cmd.name}`,
        detail: cmd.detail,
        insertText: cmd.insertAfterBackslash,
        cursorOffsetFromEnd: cmd.hasArgument ? 1 : 0,
      }));
  }
  if (context.kind === 'citation') {
    return data.citationKeys
      .filter((c) => matchesQuery(c.key, context.query))
      .slice(0, MAX_SUGGESTIONS)
      .map((c) => ({
        kind: 'citation' as const,
        label: c.key,
        detail: c.title ?? undefined,
        insertText: c.key,
        cursorOffsetFromEnd: 0,
      }));
  }
  // 'file'
  return data.filePaths
    .filter((p) => matchesQuery(p, context.query))
    .slice(0, MAX_SUGGESTIONS)
    .map((p) => ({
      kind: 'file' as const,
      label: p,
      insertText: p,
      cursorOffsetFromEnd: 0,
    }));
}

/** Applies a chosen suggestion to `text`, replacing the matched query
 * range and returning the new text plus where the cursor should land. */
export function applySuggestion(
  text: string,
  context: AutocompleteContext,
  suggestion: AutocompleteSuggestion
): { text: string; cursor: number } {
  const before = text.slice(0, context.rangeStart);
  const after = text.slice(context.rangeEnd);
  const next = before + suggestion.insertText + after;
  const cursor = before.length + suggestion.insertText.length - suggestion.cursorOffsetFromEnd;
  return { text: next, cursor };
}
