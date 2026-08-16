import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { DOCUMENT_TYPE_LABELS } from '@/lib/enums';
import { fileExtension } from '@/lib/documentUpload';
import { formatLibraryDate, libraryItemName, type LibraryItem } from '@/lib/libraryItems';
import { formatAuthors, safeText } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/Preferences';
import { FileIcon, FolderIcon, CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';

export interface DetailsPanelProps {
  item: LibraryItem | null;
  /** Name of the folder the item currently lives in — "My Library" at
   * root. Resolved by the caller (documents.tsx already knows the open
   * folder's name/breadcrumb; this panel never fetches anything of its
   * own, per requirement #12: "do not add backend work merely to fill the
   * panel"). */
  locationLabel: string;
  selectedCount: number;
  onClose: () => void;
  /**
   * Frontend Milestone 2 §12 — shown only in the multi-selection state,
   * and only when at least one selected item is a document (folders
   * aren't valid chat sources; the caller already filters). Omitted
   * (button hidden) when the conversation-scope feature flag is off, same
   * as the single-document actions-menu equivalent.
   */
  onUseSelectedInChat?: () => void;
  selectedDocumentCount?: number;
  /** Frontend Milestone 3 (Document Reader): shown only for a single
   * selected document (folders have no reader) — a second, always-visible
   * entry point into the reader alongside double-activate and the actions
   * menu's own "Open". */
  onOpenDocument?: () => void;
  /** Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
   * Section 9 — a second, always-visible entry point into "Edit metadata"
   * alongside the row/card menu's own copy, shown only for a single
   * selected document. */
  onEditMetadata?: () => void;
  /** Milestone 4.2 (Citation & BibTeX Foundation) Section 10/24 — a
   * second, always-visible entry point into the Citation popover
   * alongside the row/card menu's own copy, shown only for a single
   * selected document. */
  onCitation?: () => void;
  /** Milestone 4.2 Section 20 — shown only in the multi-selection state,
   * when at least one selected item is a document (same gating as
   * onUseSelectedInChat above). Exports every selected document as one
   * `.bib` file. */
  onExportBibtexSelected?: () => void;
  exportingBibtex?: boolean;
  /** Milestone 5 (Academic Writing & LaTeX Foundation) Part 34 — shown
   * only in the multi-selection state, when at least one selected item
   * is a document (same gating as onUseSelectedInChat above). Opens the
   * AddToWritingProjectModal for the selected document(s). */
  onAddSelectedToWritingProject?: () => void;
}

interface Row {
  label: string;
  value: string;
}

/**
 * Frontend Milestone 1 (Finder-style Document Library) — the optional
 * right-side info panel (requirement #12). Every field shown here already
 * exists on FolderResponse/DocumentSummary as returned by
 * GET /folders/contents — nothing is fetched separately and nothing is
 * invented. Notably absent: a document's file size. DocumentSummary
 * carries no size_bytes field (only the transient upload-time responses
 * do), so a "Size" row would have to be fabricated — see the milestone
 * report's Limitations section instead of showing one here.
 */
export function DetailsPanel({
  item,
  locationLabel,
  selectedCount,
  onClose,
  onUseSelectedInChat,
  selectedDocumentCount = 0,
  onOpenDocument,
  onEditMetadata,
  onCitation,
  onExportBibtexSelected,
  exportingBibtex = false,
  onAddSelectedToWritingProject,
}: DetailsPanelProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);

  if (selectedCount > 1) {
    return (
      <View style={styles.panel}>
        <PanelHeader onClose={onClose} />
        <View style={styles.emptyBody}>
          <Text style={styles.emptyText}>{selectedCount} items selected</Text>
          {onUseSelectedInChat && selectedDocumentCount > 0 && (
            <Button
              label={`Use ${selectedDocumentCount} in chat`}
              variant="secondary"
              size="sm"
              onPress={onUseSelectedInChat}
              style={styles.useInChatButton}
            />
          )}
          {onExportBibtexSelected && selectedDocumentCount > 0 && (
            <Button
              label={`Export ${selectedDocumentCount} as BibTeX`}
              variant="ghost"
              size="sm"
              onPress={onExportBibtexSelected}
              loading={exportingBibtex}
              style={styles.useInChatButton}
            />
          )}
          {onAddSelectedToWritingProject && selectedDocumentCount > 0 && (
            <Button
              label={`Add ${selectedDocumentCount} to writing project`}
              variant="ghost"
              size="sm"
              onPress={onAddSelectedToWritingProject}
              style={styles.useInChatButton}
            />
          )}
        </View>
      </View>
    );
  }

  if (!item) {
    return (
      <View style={styles.panel}>
        <PanelHeader onClose={onClose} />
        <View style={styles.emptyBody}>
          <Text style={styles.emptyText}>Select a file or folder to see its details.</Text>
        </View>
      </View>
    );
  }

  const rows: Row[] = buildRows(item, locationLabel);

  return (
    <View style={styles.panel}>
      <PanelHeader onClose={onClose} />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.iconBadge}>
          {item.kind === 'folder' ? (
            <FolderIcon size={28} color={theme.subtext} />
          ) : (
            <FileIcon size={28} color={theme.subtext} />
          )}
        </View>
        <Text style={styles.name} numberOfLines={3}>
          {libraryItemName(item)}
        </Text>
        <View style={styles.rows}>
          {rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue} numberOfLines={3}>
                {row.value}
              </Text>
            </View>
          ))}
        </View>
        {item.kind === 'document' && (onOpenDocument || onEditMetadata || onCitation) && (
          <View style={styles.actionRow}>
            {onOpenDocument && (
              <Button
                label="Open"
                variant="primary"
                size="sm"
                onPress={onOpenDocument}
                style={styles.actionButton}
              />
            )}
            {onEditMetadata && (
              <Button
                label="Edit metadata"
                variant="secondary"
                size="sm"
                onPress={onEditMetadata}
                style={styles.actionButton}
              />
            )}
            {onCitation && (
              <Button
                label="Citation"
                variant="ghost"
                size="sm"
                onPress={onCitation}
                style={styles.actionButton}
              />
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text
        style={{
          fontSize: 12,
          fontFamily: theme.fonts.bodySemibold,
          color: theme.subtext,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        Details
      </Text>
      <IconButton
        label="Close details panel"
        icon={<CloseIcon size={14} color={theme.subtext} />}
        size="sm"
        onPress={onClose}
      />
    </View>
  );
}

function buildRows(item: LibraryItem, locationLabel: string): Row[] {
  if (item.kind === 'folder') {
    return [
      { label: 'Name', value: safeText(item.data.name, 'Untitled folder') },
      { label: 'Location', value: locationLabel },
      { label: 'Subfolders', value: String(item.data.folder_count) },
      { label: 'Documents', value: String(item.data.document_count) },
      { label: 'Modified', value: formatLibraryDate(item.data.updated_at) },
    ];
  }
  const ext = fileExtension(item.data.source_filename).replace(/^\./, '').toUpperCase();
  const doc = item.data;
  // Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
  // Section 6/9: bibliographic rows, each shown only when there's a real
  // value — "unknown means unknown" (Section 4): a pre-M4 or
  // not-yet-reviewed document simply shows none of these, exactly the
  // pre-M4 panel, rather than a wall of "Not available" rows.
  const bibliographicRows: Row[] = [
    doc.authors && doc.authors.length > 0
      ? { label: 'Authors', value: formatAuthors(doc.authors) }
      : null,
    doc.publication_year ? { label: 'Year', value: String(doc.publication_year) } : null,
    doc.source_venue ? { label: 'Venue', value: doc.source_venue } : null,
    doc.volume || doc.issue
      ? { label: 'Volume/Issue', value: [doc.volume, doc.issue].filter(Boolean).join(' / ') }
      : null,
    doc.page_start || doc.page_end
      ? {
          label: 'Pages',
          value:
            doc.page_start && doc.page_end
              ? `${doc.page_start}–${doc.page_end}`
              : String(doc.page_start ?? doc.page_end),
        }
      : null,
    doc.publisher ? { label: 'Publisher', value: doc.publisher } : null,
    doc.doi ? { label: 'DOI', value: doc.doi } : null,
  ].filter((row): row is Row => row !== null);

  return [
    { label: 'Name', value: safeText(doc.title, doc.source_filename) },
    ...bibliographicRows,
    { label: 'File', value: doc.source_filename },
    { label: 'Type', value: ext || DOCUMENT_TYPE_LABELS[doc.document_type] },
    { label: 'Category', value: DOCUMENT_TYPE_LABELS[doc.document_type] },
    { label: 'Location', value: locationLabel },
    { label: 'Chunks', value: String(doc.chunk_count) },
    { label: 'Uploaded', value: formatLibraryDate(doc.ingested_at) },
  ];
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    panel: {
      width: 260,
      flexShrink: 0,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: theme.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 10,
    },
    emptyBody: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 32 },
    emptyText: {
      color: theme.faint,
      fontSize: 12,
      fontFamily: theme.fonts.body,
      textAlign: 'center',
      maxWidth: 180,
    },
    useInChatButton: { marginTop: 4 },
    actionRow: { width: '100%', gap: 8, marginTop: 4 },
    actionButton: { width: '100%' },
    body: { alignItems: 'center', paddingTop: 8, gap: 10 },
    iconBadge: {
      width: 56,
      height: 56,
      borderRadius: theme.radius.lg,
      backgroundColor: theme.cardPressed,
      alignItems: 'center',
      justifyContent: 'center',
    },
    name: {
      fontSize: 14,
      color: theme.text,
      fontFamily: theme.fonts.bodySemibold,
      textAlign: 'center',
    },
    rows: { width: '100%', gap: 10, marginTop: 6 },
    row: { gap: 2 },
    rowLabel: {
      fontSize: 10,
      color: theme.faint,
      fontFamily: theme.fonts.bodySemibold,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    rowValue: { fontSize: 13, color: theme.text, fontFamily: theme.fonts.body },
  });
}
