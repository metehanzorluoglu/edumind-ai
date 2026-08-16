import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
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

/**
 * Milestone 5.1 Part 22/36 — the compile result banner: a short,
 * structured summary near the editor/preview (never the raw noisy TeX
 * log dumped into the main UI by default), with an expandable "Show log"
 * disclosure for the full sanitized excerpt. Only rendered when there is
 * something to say — a bare "success" with zero diagnostics renders
 * nothing (the preview panel itself is the confirmation).
 */
export function CompileDiagnostics({
  status,
  diagnostics,
  logExcerpt,
}: {
  status: CompileStatus;
  diagnostics: CompileDiagnostic[];
  logExcerpt: string;
}) {
  const theme = useTheme();
  const [logOpen, setLogOpen] = useState(false);

  if (status === 'success' && diagnostics.length === 0) return null;

  const body =
    diagnostics.length > 0
      ? diagnostics
          .map((d) => (d.line != null ? `Line ${d.line}: ${d.message}` : d.message))
          .join('\n')
      : STATUS_TITLE[status];

  return (
    <View style={styles.container}>
      <Notice
        tone={STATUS_TONE[status]}
        title={STATUS_TITLE[status]}
        body={body}
        actionLabel={logExcerpt ? (logOpen ? 'Hide log' : 'Show log') : undefined}
        onAction={logExcerpt ? () => setLogOpen((v) => !v) : undefined}
      />
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
  logBox: {
    maxHeight: 200,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
  },
  logText: { fontSize: 11.5, lineHeight: 16 },
});
