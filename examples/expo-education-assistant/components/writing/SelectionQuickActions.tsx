import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from '@/lib/Preferences';
import { type UseWritingAskResult, type WritingAskEditorContext } from '@/lib/useWritingAsk';

/**
 * Milestone 6.2 Part 10 — a restrained, selection-aware quick-action row
 * for the Writing editor: Grammar / Improve / Concise / Explain / Ask
 * EduM8. Each is a plain, explicit model REQUEST sent through the exact
 * same live writing_context path a manually-typed Ask EduM8 question
 * already uses (never a second AI pathway) — the answer appears as an
 * ordinary turn in the SAME Ask EduM8 panel/tab, with the same evidence
 * cards, same Stop control, same streaming. None of these ever modify
 * the manuscript directly: there is no Accept/Reject, no inline diff, no
 * automatic replacement here or anywhere else in M6.2 — a generated
 * rewrite is something the researcher reads and copies themselves (the
 * existing MarkdownAnswer text is already selectable/copyable), never
 * something this bar applies on their behalf. That whole class of
 * behavior (tracked AI edits, Accept/Reject, inline diff) is explicitly
 * out of scope until Milestone 6.3.
 *
 * Deliberately NOT a floating toolbar anchored to the text selection
 * (the Overleaf pattern the spec explicitly warns against copying
 * mechanically) — computing a reliable caret-relative pixel position for
 * this app's plain-textarea-based LatexCodeEditor (react-simple-code-
 * editor) would be fragile, and a floating overlay is exactly the kind
 * of desktop-only affordance that breaks down on mobile ("no floating
 * desktop toolbar forced onto mobile" — Part 33). Instead this is a
 * quiet, docked row that appears directly above the editor only while
 * there's a real (non-collapsed) selection, using the same restrained
 * chip/pill visual language as the rest of Writing's toolbars (see
 * PanelTabButton/MobileTabButton in writing/[id].tsx) — small, wraps
 * naturally on a narrow screen, never horizontally scrolling.
 */
export interface SelectionQuickActionsProps {
  visible: boolean;
  selectedText: string;
  disabled: boolean;
  ask: UseWritingAskResult;
  editorContext: Omit<WritingAskEditorContext, 'selectedText'>;
  /** Switches to/opens the Ask EduM8 panel or tab so the researcher can
   * watch the request stream in — called on every quick-action press,
   * including the bare "Ask EduM8" one (which opens the panel without
   * sending anything, same as today's composer). */
  onOpenAskPanel: () => void;
}

interface QuickAction {
  key: string;
  label: string;
  /** `null` for the bare "Ask EduM8" action — it only opens the panel,
   * exactly like pressing the existing "Ask EduM8" toggle already does,
   * so the researcher can type their own question. */
  buildPrompt: ((selectedText: string) => string) | null;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    key: 'grammar',
    label: 'Grammar',
    buildPrompt: () =>
      'Check the grammar and spelling of the selected passage. List each issue you find ' +
      'and a suggested correction — do not rewrite the whole passage.',
  },
  {
    key: 'improve',
    label: 'Improve',
    buildPrompt: () =>
      'Suggest ways to improve the clarity and flow of the selected passage, preserving its ' +
      'meaning. Explain your suggestions.',
  },
  {
    key: 'concise',
    label: 'Concise',
    buildPrompt: () =>
      'Suggest a more concise version of the selected passage that preserves its meaning. ' +
      'Explain what you condensed or removed.',
  },
  {
    key: 'explain',
    label: 'Explain',
    buildPrompt: () => 'Explain what the selected passage is saying, in plain language.',
  },
  { key: 'ask', label: 'Ask EduM8', buildPrompt: null },
];

export function SelectionQuickActions({
  visible,
  selectedText,
  disabled,
  ask,
  editorContext,
  onOpenAskPanel,
}: SelectionQuickActionsProps) {
  const theme = useTheme();
  const styles = buildStyles(theme);

  if (!visible) return null;

  function handlePress(action: QuickAction): void {
    onOpenAskPanel();
    if (!action.buildPrompt) return; // bare "Ask EduM8" — just opens the panel
    const fullContext: WritingAskEditorContext = { ...editorContext, selectedText };
    void ask.ask(action.buildPrompt(selectedText), fullContext, { skipScopeGate: true });
  }

  return (
    <View style={styles.row} accessibilityRole="toolbar" testID="selection-quick-actions">
      {QUICK_ACTIONS.map((action) => (
        <Pressable
          key={action.key}
          accessibilityRole="button"
          accessibilityLabel={
            action.buildPrompt ? `${action.label} — ask EduM8 about the selection` : 'Ask EduM8'
          }
          disabled={disabled || ask.asking}
          onPress={() => handlePress(action)}
          style={({ pressed }) => [
            styles.chip,
            action.key === 'ask' && styles.chipPrimary,
            (disabled || ask.asking) && styles.chipDisabled,
            pressed && !disabled && !ask.asking && styles.chipPressed,
          ]}
        >
          <Text
            style={[styles.chipLabel, action.key === 'ask' && styles.chipLabelPrimary]}
            numberOfLines={1}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
      backgroundColor: theme.card,
    },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      minHeight: 32,
      justifyContent: 'center',
      borderRadius: theme.radius.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    chipPrimary: { backgroundColor: theme.accentSoft, borderColor: theme.accent },
    chipDisabled: { opacity: 0.5 },
    chipPressed: { opacity: 0.7 },
    chipLabel: { fontSize: 12.5, fontFamily: theme.fonts.bodySemibold, color: theme.subtext },
    chipLabelPrimary: { color: theme.accent },
  });
}
