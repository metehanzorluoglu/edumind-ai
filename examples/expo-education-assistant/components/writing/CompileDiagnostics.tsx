import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CompileDiagnostic, CompileStatus } from 'education-assistant-client';
import { useTheme, type Theme } from '@/lib/Preferences';

const STATUS_TITLE: Record<CompileStatus, string> = {
  success: 'Compiled successfully',
  error: 'Compilation failed',
  timeout: 'Compilation timed out',
  busy: 'Compiler busy',
  unavailable: 'Compiler unavailable',
};

export interface CompileDiagnosticsProps {
  status: CompileStatus;
  diagnostics: CompileDiagnostic[];
  logExcerpt: string;
  /**
   * Milestone 5.5 Part 14 — resolves a diagnostic's `file` (a
   * project-relative path, e.g. "sections/introduction.tex") against the
   * CURRENT file tree. Undefined, or returning false, means "no
   * navigation offered" — this component never guesses at a file that
   * might not exist (a diagnostic from a stale compile against a file
   * since renamed/deleted, for instance). Omit entirely to disable file
   * navigation altogether (e.g. a caller with no file tree available).
   */
  resolveDiagnosticFile?: (path: string) => boolean;
  /** The path of the file currently open in the editor, if any — purely
   * cosmetic (picks "Go to line" vs "Open file" as the button label);
   * never affects whether the action is offered. */
  activeFilePath?: string | null;
  /** Fired when the researcher chooses to jump to a diagnostic that
   * resolveDiagnosticFile confirmed exists. The caller owns what
   * "jump" means (switch active file, position the cursor at the
   * reported line, and — Part 9/11 — set the editor's own persistent
   * error decoration for that file). */
  onOpenDiagnostic?: (diagnostic: CompileDiagnostic) => void;
}

/**
 * Milestone 5.1 Part 22/36, extended by 5.5 Part 13/14 and by the
 * 5.5.3 continuation's "Preview diagnostics are primary home" —
 * previously a full-width banner spanning the whole workspace above
 * the editor/preview/research columns; now meant to be rendered
 * INSIDE the Preview pane itself (see app/(tabs)/writing/[id].tsx's
 * own previewInner), where a failed compile has no PDF of its own to
 * show anyway. Errors and warnings are kept in their own separate,
 * clearly-labeled sections (never classified by AI — deterministic
 * only, from `diagnostic.severity`, which the backend already sets
 * from real, well-known LaTeX log signatures — see rag-backend's own
 * log_sanitizer.py). The raw sanitized log stays available underneath
 * an explicit "Show log" disclosure, never dumped into the UI by
 * default. Renders nothing for a clean success with zero diagnostics —
 * the PDF itself is the confirmation in that case.
 */
export function CompileDiagnostics({
  status,
  diagnostics,
  logExcerpt,
  resolveDiagnosticFile,
  activeFilePath,
  onOpenDiagnostic,
}: CompileDiagnosticsProps) {
  const theme = useTheme();
  const styles = buildStyles(theme);
  const [logOpen, setLogOpen] = useState(false);

  if (status === 'success' && diagnostics.length === 0) return null;

  // Deterministic split — never an LLM classifying arbitrary log text
  // (Part 8 of the spec this satisfies). Anything that isn't literally
  // `severity === 'warning'` is treated as an error, matching the
  // backend's own two-value convention (see latex-compiler's
  // log_sanitizer.py, which only ever emits "error" or "warning").
  const errors = diagnostics.filter((d) => d.severity !== 'warning');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  // A compiler-level outcome with NO parsed diagnostics at all (busy/
  // unavailable/timeout, or an error whose log didn't match any known
  // signature) still needs to say SOMETHING — the plain status title,
  // same as before this component was restructured.
  const showFallbackStatus = diagnostics.length === 0 && status !== 'success';

  function renderRow(d: CompileDiagnostic, index: number) {
    const navigable = Boolean(onOpenDiagnostic && d.file && resolveDiagnosticFile?.(d.file));
    const label = d.file === activeFilePath ? 'Go to line' : 'Open file';
    const location = d.file != null ? `${d.file}${d.line != null ? `:${d.line}` : ''}` : null;
    return (
      <View key={`${d.severity}-${d.file}-${d.line}-${index}`} style={styles.row}>
        <View style={styles.rowBody}>
          {location && (
            <Text style={styles.rowLocation} numberOfLines={1}>
              {location}
            </Text>
          )}
          <Text style={styles.rowMessage}>{d.message}</Text>
        </View>
        {navigable && (
          <Pressable
            onPress={() => onOpenDiagnostic?.(d)}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${d.file}${d.line != null ? `, line ${d.line}` : ''}`}
            hitSlop={8}
            style={({ pressed }) => [styles.rowAction, pressed && { opacity: 0.7 }]}
          >
            <Text style={styles.rowActionText}>{label}</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container} accessibilityLabel="Compile diagnostics">
      <Text style={styles.title}>{STATUS_TITLE[status]}</Text>

      {showFallbackStatus && (
        <Text style={styles.fallbackText}>
          {status === 'busy'
            ? 'The compiler is busy with another job — try again in a moment.'
            : status === 'unavailable'
              ? 'The compiler is temporarily unavailable.'
              : status === 'timeout'
                ? 'The compile took too long and was stopped.'
                : 'See the full log below for details.'}
        </Text>
      )}

      {errors.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Errors ({errors.length})</Text>
          {errors.map(renderRow)}
        </View>
      )}

      {warnings.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Warnings ({warnings.length})</Text>
          {warnings.map(renderRow)}
        </View>
      )}

      {logExcerpt && (
        <Pressable
          onPress={() => setLogOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={logOpen ? 'Hide log' : 'Show log'}
          style={styles.showLogButton}
        >
          <Text style={styles.showLogText}>{logOpen ? 'Hide log' : 'Show full log'}</Text>
        </Pressable>
      )}
      {logOpen && logExcerpt && (
        <ScrollView style={styles.logBox} accessibilityLabel="Compile log">
          <Text style={styles.logText}>{logExcerpt}</Text>
        </ScrollView>
      )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { gap: 10, padding: 16 },
    title: { fontSize: 15, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    fallbackText: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.subtext },
    section: { gap: 2 },
    sectionLabel: {
      fontSize: 12,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
      marginBottom: 2,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 8,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    rowBody: { flex: 1, gap: 2 },
    rowLocation: {
      fontSize: 12,
      fontFamily: theme.fonts.mono,
      color: theme.subtext,
    },
    rowMessage: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    rowAction: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    rowActionText: {
      fontSize: 11.5,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.accent,
    },
    showLogButton: { alignSelf: 'flex-start' },
    showLogText: { fontSize: 12.5, fontFamily: theme.fonts.bodySemibold, color: theme.accent },
    logBox: {
      maxHeight: 240,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 8,
      padding: 10,
      backgroundColor: theme.cardPressed,
    },
    logText: { fontSize: 11.5, lineHeight: 16, fontFamily: theme.fonts.mono, color: theme.text },
  });
}
