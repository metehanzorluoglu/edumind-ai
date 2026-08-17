import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { CompileDiagnostic, CompileStatus } from 'education-assistant-client';
import { Notice, type NoticeTone } from '@/components/ui/Notice';
import { useTheme } from '@/lib/Preferences';

const STATUS_TONE: Record<CompileStatus, NoticeTone> = {
  success: 'ok',
  error: 'danger',
  timeout: 'danger',
  busy: 'warning',
  unavailable: 'warning',
};

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
   * reported line). */
  onOpenDiagnostic?: (diagnostic: CompileDiagnostic) => void;
}

/**
 * Milestone 5.1 Part 22/36, extended by 5.5 Part 13/14 — the compile
 * result banner: a short, structured summary near the editor/preview
 * (never the raw noisy TeX log dumped into the main UI by default), with
 * an expandable "Show log" disclosure for the full sanitized excerpt.
 * Only rendered when there is something to say — a bare "success" with
 * zero diagnostics renders nothing (the preview panel itself is the
 * confirmation). Diagnostics that name a real, still-existing project
 * file each get their own "Open file"/"Go to line" action underneath the
 * summary — never fabricated navigation for a diagnostic whose file
 * can't be confirmed to exist right now.
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
  const [logOpen, setLogOpen] = useState(false);

  if (status === 'success' && diagnostics.length === 0) return null;

  const body =
    diagnostics.length > 0
      ? diagnostics
          .map((d) => (d.line != null ? `Line ${d.line}: ${d.message}` : d.message))
          .join('\n')
      : STATUS_TITLE[status];

  const navigableDiagnostics =
    onOpenDiagnostic && resolveDiagnosticFile
      ? diagnostics.filter((d) => d.file && resolveDiagnosticFile(d.file))
      : [];

  return (
    <View style={styles.container}>
      <Notice
        tone={STATUS_TONE[status]}
        title={STATUS_TITLE[status]}
        body={body}
        actionLabel={logExcerpt ? (logOpen ? 'Hide log' : 'Show log') : undefined}
        onAction={logExcerpt ? () => setLogOpen((v) => !v) : undefined}
      />
      {navigableDiagnostics.map((d, index) => {
        // Same file already open: "Go to line" (a cursor move within the
        // current buffer); a different file: "Open file" (a file switch
        // first). Cosmetic only — both call the same onOpenDiagnostic.
        const label = d.file === activeFilePath ? 'Go to line' : 'Open file';
        return (
          <View key={`${d.file}-${d.line}-${index}`} style={styles.diagnosticRow}>
            <Text
              style={[
                styles.diagnosticText,
                { color: theme.subtext, fontFamily: theme.fonts.mono },
              ]}
              numberOfLines={1}
            >
              {d.file}
              {d.line != null ? `:${d.line}` : ''}
            </Text>
            <Pressable
              onPress={() => onOpenDiagnostic?.(d)}
              accessibilityRole="button"
              accessibilityLabel={`${label}: ${d.file}${d.line != null ? `, line ${d.line}` : ''}`}
              hitSlop={8}
              style={({ pressed }) => [
                styles.diagnosticAction,
                { borderColor: theme.border },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[
                  styles.diagnosticActionText,
                  { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {logOpen && logExcerpt && (
        <ScrollView
          style={[styles.logBox, { backgroundColor: theme.cardPressed, borderColor: theme.border }]}
          accessibilityLabel="Compile log"
        >
          <Text style={[styles.logText, { color: theme.text, fontFamily: theme.fonts.mono }]}>
            {logExcerpt}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  diagnosticRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 4,
  },
  diagnosticText: { flex: 1, fontSize: 12 },
  diagnosticAction: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  diagnosticActionText: { fontSize: 11.5 },
  logBox: {
    maxHeight: 200,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
  },
  logText: { fontSize: 11.5, lineHeight: 16 },
});
