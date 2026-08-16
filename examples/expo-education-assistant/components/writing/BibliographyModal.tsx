import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CloseIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { copyToClipboard } from '@/lib/clipboard';
import { downloadTextFile } from '@/lib/downloadTextFile';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface BibliographyModalProps {
  visible: boolean;
  loading: boolean;
  loadError: string | null;
  bibtex: string | null;
  projectTitle: string;
  onClose: () => void;
}

const CONFIRMATION_MS = 2500;

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Part 13 — "References
 * → View BibTeX": READ-ONLY (Part 13: editing here would create a second
 * bibliographic-truth source — the project's references.bib is always
 * regenerated fresh from the current reference set via the exact
 * Milestone 4.2 engine, see useWritingProject.loadBibliography). Offers
 * Copy BibTeX and Download references.bib only.
 */
export function BibliographyModal({
  visible,
  loading,
  loadError,
  bibtex,
  projectTitle,
  onClose,
}: BibliographyModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [busyAction, setBusyAction] = useState<'copy' | 'download' | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmationTimer.current) clearTimeout(confirmationTimer.current);
    };
  }, []);

  function showConfirmation(message: string): void {
    setConfirmation(message);
    if (confirmationTimer.current) clearTimeout(confirmationTimer.current);
    confirmationTimer.current = setTimeout(() => setConfirmation(null), CONFIRMATION_MS);
  }

  async function handleCopy(): Promise<void> {
    if (!bibtex || busyAction) return;
    setBusyAction('copy');
    const ok = await copyToClipboard(bibtex);
    setBusyAction(null);
    showConfirmation(ok ? 'BibTeX copied' : 'Could not copy BibTeX');
  }

  async function handleDownload(): Promise<void> {
    if (!bibtex || busyAction) return;
    setBusyAction('download');
    try {
      await downloadTextFile('references.bib', bibtex, 'application/x-bibtex');
      showConfirmation('references.bib downloaded');
    } catch {
      showConfirmation('Could not download references.bib');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close BibTeX preview"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              references.bib — {projectTitle}
            </Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onClose}
            />
          </View>

          <ScrollView style={styles.bibtexBox} contentContainerStyle={styles.bibtexBoxContent}>
            {loading && <ActivityIndicator color={theme.accent} />}
            {!loading && loadError && <Notice tone="danger" body={loadError} />}
            {!loading && !loadError && bibtex !== null && (
              <Text style={styles.bibtexText} selectable>
                {bibtex || '% No references yet — add references to this project.'}
              </Text>
            )}
          </ScrollView>

          {confirmation && <Notice tone="ok" body={confirmation} />}

          <View style={styles.actions}>
            <Button
              label="Copy BibTeX"
              variant="primary"
              size="sm"
              onPress={() => void handleCopy()}
              disabled={!bibtex || busyAction !== null}
              loading={busyAction === 'copy'}
              style={styles.actionButton}
            />
            <Button
              label={Platform.OS === 'web' ? 'Download references.bib' : 'Share references.bib'}
              variant="secondary"
              size="sm"
              onPress={() => void handleDownload()}
              disabled={!bibtex || busyAction !== null}
              loading={busyAction === 'download'}
              style={styles.actionButton}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 45,
      elevation: 45,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      width: 560,
      maxWidth: '92%',
      maxHeight: '80%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    title: { flex: 1, fontSize: 15, fontFamily: theme.fonts.display, color: theme.text },
    bibtexBox: {
      minHeight: 120,
      maxHeight: 380,
      backgroundColor: theme.cardPressed,
      borderRadius: theme.radius.md,
    },
    bibtexBoxContent: { padding: 12 },
    bibtexText: { fontSize: 12, lineHeight: 18, color: theme.text, fontFamily: theme.fonts.mono },
    actions: { flexDirection: 'row', gap: 8 },
    actionButton: { flex: 1 },
  });
}
