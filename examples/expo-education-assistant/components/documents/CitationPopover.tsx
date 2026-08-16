import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { CitationStyle } from 'education-assistant-client';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { copyToClipboard } from '@/lib/clipboard';
import { downloadTextFile, safeBibtexFilename } from '@/lib/downloadTextFile';
import { safeText } from '@/lib/format';
import { useTheme, usePreferences, type Theme } from '@/lib/Preferences';
import { useClient } from '@/lib/ClientProvider';

/** The one thing every citation surface (Documents, Reader, Chat Source
 * cards) already has on hand — deliberately narrower than the full
 * DocumentSummary/DocumentContentResponse shape so this popover can open
 * from any of them without a caller needing to construct/cast a fake
 * full document object just to satisfy a prop type. */
export interface CitationPopoverDocument {
  document_id: string;
  title?: string | null;
  source_filename: string;
}

export interface CitationPopoverProps {
  document: CitationPopoverDocument;
  onClose: () => void;
}

const STYLE_OPTIONS: { value: CitationStyle; label: string }[] = [
  { value: 'apa7', label: 'APA 7' },
  { value: 'ieee', label: 'IEEE' },
];

const CONFIRMATION_MS = 2500;

/**
 * Milestone 4.2 (Citation & BibTeX Foundation) Section 10 — the compact
 * citation surface: a style selector, the formatted citation text, and
 * Copy citation / Copy BibTeX / Download BibTeX. Deliberately NOT a
 * manuscript editor (Section 10: "keep it compact") — one document at a
 * time, no editing, no preview pane beyond the citation text itself.
 *
 * The formatted citation is fetched fresh (GET /documents/{id}/citation)
 * on open and on every style change — always the document's CURRENT
 * canonical metadata (Section 28/30), never a stale local guess. BibTeX
 * is fetched on demand only when the user actually asks for it (Copy/
 * Download), never eagerly (Section 36: "generate on demand where
 * reasonable").
 */
export function CitationPopover({ document, onClose }: CitationPopoverProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const { client } = useClient();
  const { preferences, update } = usePreferences();
  const [style, setStyle] = useState<CitationStyle>(preferences.citationStyle);

  const [formatted, setFormatted] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'copy-citation' | 'copy-bibtex' | 'download' | null>(
    null
  );
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    client
      .getDocumentCitation(document.document_id, style)
      .then((result) => {
        if (cancelled) return;
        setFormatted(result.formatted);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Could not load this citation. Try again.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, document.document_id, style]);

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

  function handleStyleChange(next: CitationStyle): void {
    setStyle(next);
    update('citationStyle', next);
  }

  async function handleCopyCitation(): Promise<void> {
    if (!formatted || busyAction) return;
    setBusyAction('copy-citation');
    const ok = await copyToClipboard(formatted);
    setBusyAction(null);
    showConfirmation(ok ? 'Citation copied' : 'Could not copy citation');
  }

  async function handleCopyBibtex(): Promise<void> {
    if (busyAction) return;
    setBusyAction('copy-bibtex');
    try {
      const result = await client.getDocumentBibtex(document.document_id);
      const ok = await copyToClipboard(result.bibtex);
      showConfirmation(ok ? 'BibTeX copied' : 'Could not copy BibTeX');
    } catch {
      showConfirmation('Could not load BibTeX');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDownloadBibtex(): Promise<void> {
    if (busyAction) return;
    setBusyAction('download');
    try {
      const result = await client.getDocumentBibtex(document.document_id);
      const filename = safeBibtexFilename(result.citation_key);
      await downloadTextFile(filename, result.bibtex, 'application/x-bibtex');
      showConfirmation('BibTeX downloaded');
    } catch {
      showConfirmation('Could not download BibTeX');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close citation"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              Citation
            </Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onClose}
            />
          </View>
          <Text style={styles.documentName} numberOfLines={2}>
            {safeText(document.title, document.source_filename)}
          </Text>

          <View
            style={styles.styleTrack}
            accessibilityRole="adjustable"
            accessibilityLabel="Citation style"
          >
            {STYLE_OPTIONS.map((option) => {
              const selected = option.value === style;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => handleStyleChange(option.value)}
                  accessibilityRole="button"
                  accessibilityLabel={`Citation style: ${option.label}`}
                  accessibilityState={{ selected }}
                  style={[styles.styleSegment, selected && styles.styleSegmentActive]}
                >
                  <Text
                    style={[styles.styleSegmentText, selected && styles.styleSegmentTextActive]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.citationBox}>
            {loading ? (
              <ActivityIndicator color={theme.accent} />
            ) : loadError ? (
              <Text style={styles.errorText}>{loadError}</Text>
            ) : (
              <Text style={styles.citationText} selectable>
                {formatted}
              </Text>
            )}
          </View>

          {confirmation && <Notice tone="ok" body={confirmation} />}

          <View style={styles.actions}>
            <Button
              label="Copy citation"
              variant="primary"
              size="sm"
              onPress={handleCopyCitation}
              disabled={!formatted || busyAction !== null}
              loading={busyAction === 'copy-citation'}
              style={styles.actionButton}
            />
            <Button
              label="Copy BibTeX"
              variant="secondary"
              size="sm"
              onPress={handleCopyBibtex}
              disabled={busyAction !== null}
              loading={busyAction === 'copy-bibtex'}
              style={styles.actionButton}
            />
            <Button
              label={Platform.OS === 'web' ? 'Download BibTeX' : 'Share BibTeX'}
              variant="ghost"
              size="sm"
              onPress={handleDownloadBibtex}
              disabled={busyAction !== null}
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
      width: 380,
      maxWidth: '92%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontFamily: theme.fonts.display, color: theme.text },
    documentName: { fontSize: 12, color: theme.subtext, fontFamily: theme.fonts.body },
    styleTrack: {
      flexDirection: 'row',
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      padding: 3,
      gap: 3,
      alignSelf: 'flex-start',
    },
    styleSegment: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: theme.radius.sm },
    styleSegmentActive: { backgroundColor: theme.accentSoft },
    styleSegmentText: { fontSize: 13, fontFamily: theme.fonts.bodyMedium, color: theme.subtext },
    styleSegmentTextActive: { color: theme.accent, fontFamily: theme.fonts.bodyBold },
    citationBox: {
      minHeight: 84,
      backgroundColor: theme.cardPressed,
      borderRadius: theme.radius.md,
      padding: 12,
      justifyContent: 'center',
    },
    citationText: { fontSize: 13, lineHeight: 20, color: theme.text, fontFamily: theme.fonts.body },
    errorText: { fontSize: 13, color: theme.danger, fontFamily: theme.fonts.body },
    actions: { gap: 8 },
    actionButton: { width: '100%' },
  });
}
