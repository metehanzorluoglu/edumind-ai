import { useState } from 'react';
import type { ReferenceMode, WritingProjectReferenceMode } from 'education-assistant-client';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { useTheme, type Theme } from '@/lib/Preferences';

const MODE_LABEL: Record<ReferenceMode, string> = {
  edum8_library: 'EduM8 Reference Library',
  imported_bib: 'Imported BibTeX',
  template_tex: 'Template-managed',
  inline_template: 'Template-managed (inline)',
};

export interface ReferenceModeCardProps {
  referenceMode: WritingProjectReferenceMode | null;
  /** Applies the CURRENT proposal (if any) — never called with a
   * hand-constructed find/replace; the confirm UI below only ever shows
   * what `referenceMode.edum8_switch_proposal` already contains. */
  onSwitchToEdum8: () => Promise<unknown>;
}

/**
 * Bibliography Source Detection — explains a Writing Project's ACTUAL
 * reference setup (never assumed EduM8-library just because
 * references.bib exists — see rag-backend's app/core/reference_mode.py)
 * and, for a mode where a SAFE automatic rewrite exists, offers an
 * explicit, confirm-before-apply "Use EduM8 references" switch. Never
 * silently deletes/rewrites anything on its own — see handleConfirm's
 * own two branches below.
 */
export function ReferenceModeCard({ referenceMode, onSwitchToEdum8 }: ReferenceModeCardProps) {
  const theme = useTheme();
  const styles = buildStyles(theme);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  if (!referenceMode) return null;

  async function handleConfirmSwitch(): Promise<void> {
    setSwitching(true);
    setSwitchError(null);
    try {
      await onSwitchToEdum8();
      setConfirming(false);
    } catch (error) {
      setSwitchError(
        error instanceof Error ? error.message : 'Could not switch to EduM8 references.'
      );
    } finally {
      setSwitching(false);
    }
  }

  const isEdum8Mode = referenceMode.mode === 'edum8_library';

  return (
    <View style={styles.card} accessibilityLabel="Project reference mode">
      <View style={styles.row}>
        <Text style={styles.label}>Project reference mode</Text>
        <Text style={styles.value}>{MODE_LABEL[referenceMode.mode]}</Text>
      </View>
      {referenceMode.bibliography_source && (
        <View style={styles.row}>
          <Text style={styles.label}>
            {isEdum8Mode ? 'Generated bibliography' : 'Bibliography source'}
          </Text>
          <Text style={styles.value}>{referenceMode.bibliography_source}</Text>
        </View>
      )}
      {!isEdum8Mode && (
        <View style={styles.row}>
          <Text style={styles.label}>EduM8 Reference Library</Text>
          <Text style={styles.value}>
            {referenceMode.edum8_available
              ? 'Available, not currently connected to this manuscript'
              : 'Not yet connected to this manuscript'}
          </Text>
        </View>
      )}

      {referenceMode.citation_key_source === 'none' && referenceMode.no_key_source_reason && (
        <Notice tone="warning" body={referenceMode.no_key_source_reason} />
      )}

      {!isEdum8Mode && !confirming && (
        <Button
          label="Use EduM8 references"
          variant="secondary"
          size="sm"
          onPress={() => setConfirming(true)}
          style={styles.switchButton}
        />
      )}

      {confirming && referenceMode.edum8_switch_proposal && (
        <View style={styles.proposalBox}>
          <Text style={styles.proposalLabel}>
            Proposed change in {referenceMode.edum8_switch_proposal.file_path}:
          </Text>
          <Text style={styles.proposalRemove}>− {referenceMode.edum8_switch_proposal.find}</Text>
          <Text style={styles.proposalAdd}>+ {referenceMode.edum8_switch_proposal.replace}</Text>
          <Text style={styles.proposalNote}>
            Your existing bibliography file is not deleted — it simply stops being referenced.
          </Text>
          {switchError && <Notice tone="danger" body={switchError} />}
          <View style={styles.proposalActions}>
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              onPress={() => setConfirming(false)}
              disabled={switching}
            />
            <Button
              label={switching ? 'Applying…' : 'Apply change'}
              variant="primary"
              size="sm"
              onPress={() => void handleConfirmSwitch()}
              disabled={switching}
            />
          </View>
        </View>
      )}

      {confirming &&
        !referenceMode.edum8_switch_proposal &&
        referenceMode.edum8_switch_instructions && (
          <View style={styles.proposalBox}>
            <Text style={styles.proposalNote}>{referenceMode.edum8_switch_instructions}</Text>
            <Button
              label="Close"
              variant="ghost"
              size="sm"
              onPress={() => setConfirming(false)}
              style={styles.switchButton}
            />
          </View>
        )}
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      gap: 6,
      padding: 12,
      borderRadius: theme.radius.md,
      backgroundColor: theme.cardPressed,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    row: { gap: 1 },
    label: {
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    value: { fontSize: 13, fontFamily: theme.fonts.body, color: theme.text },
    switchButton: { alignSelf: 'flex-start', marginTop: 2 },
    proposalBox: {
      marginTop: 4,
      gap: 6,
      padding: 10,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    proposalLabel: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.subtext },
    proposalRemove: { fontSize: 12, fontFamily: theme.fonts.mono, color: theme.danger },
    proposalAdd: { fontSize: 12, fontFamily: theme.fonts.mono, color: theme.accent },
    proposalNote: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
    proposalActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 2 },
  });
}
