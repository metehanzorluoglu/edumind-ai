import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DuplicateDocumentCandidate } from 'education-assistant-client';
import { Button } from '@/components/ui/Button';
import { formatSourceIdentity, safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface DuplicateCandidateNoticeProps {
  candidate: DuplicateDocumentCandidate;
  /** Section 28 — navigates to the existing document instead of uploading. */
  onOpenExisting: () => void;
  /** Section 28 — dismisses the warning only; the upload itself is
   * unaffected either way (it always proceeds when the user presses
   * Upload, warning or not). */
  onKeepBoth: () => void;
}

/**
 * Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate Awareness)
 * Section 23/24/27/28 — a subtle, non-blocking heads-up shown during the
 * pre-upload metadata review step when the file's extracted DOI exactly
 * matches a document this same user already owns. "exact_doi" is
 * currently the only match_type the backend produces (fuzzy title/author
 * matching is deferred — see Milestone 4.1's report), so this always
 * renders as a high-confidence match, never hedged as merely "possible."
 */
export function DuplicateCandidateNotice({
  candidate,
  onOpenExisting,
  onKeepBoth,
}: DuplicateCandidateNoticeProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const identity = formatSourceIdentity(
    candidate.authors,
    candidate.publication_year,
    candidate.title
  );

  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.heading}>This reference may already be in your library</Text>
      <Text style={styles.body}>
        Existing: {identity}
        {candidate.folder_name ? ` · in ${candidate.folder_name}` : ''}
      </Text>
      <Text style={styles.filename}>{safeText(candidate.source_filename)}</Text>
      <View style={styles.actions}>
        <Button label="Open existing" variant="secondary" size="sm" onPress={onOpenExisting} />
        <Button label="Keep both" variant="ghost" size="sm" onPress={onKeepBoth} />
      </View>
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: {
      gap: 6,
      padding: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.warningSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.warning,
    },
    heading: { fontSize: 13, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    body: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    filename: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
    actions: { flexDirection: 'row', gap: 8, marginTop: 2 },
  });
}
