import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type {
  DocumentEnrichmentResponse,
  DocumentSummary,
  DocumentType,
  UpdateDocumentMetadataRequest,
} from 'education-assistant-client';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { TextField } from '@/components/ui/TextField';
import { CloseIcon } from '@/components/icons';
import { IconButton } from '@/components/ui/IconButton';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_LABELS } from '@/lib/enums';
import { useTheme, type Theme } from '@/lib/Preferences';

export interface EditMetadataModalProps {
  document: DocumentSummary;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  /** Only the fields that actually changed from `document`'s current
   * values — see buildMetadataDiff below. Never called with an empty
   * diff (the Save button is disabled in that case instead). */
  onSave: (diff: Partial<UpdateDocumentMetadataRequest>) => void;
  /**
   * Milestone 4.1 (Authoritative Metadata Enrichment & Duplicate
   * Awareness) Section 11 — the "Refresh metadata" action. Optional so
   * any other embedding of this modal that doesn't want the action can
   * simply omit it. Only enabled when `document.has_usable_doi` is true
   * (Section 11: "Only show/enable when the document has a usable DOI").
   * On success, this modal applies ONLY the specific fields the response
   * reports as updated onto its own local form state — never a full
   * reset — so any UNSAVED edit the user was mid-typing in an unrelated
   * field survives a refresh untouched.
   */
  onRefreshMetadata?: () => Promise<DocumentEnrichmentResponse>;
  refreshingMetadata?: boolean;
}

type FormUpdater = (updater: (prev: EditMetadataFormState) => EditMetadataFormState) => void;

/** Maps a backend field name — exactly as it appears in
 * DocumentEnrichmentResponse.fields_updated, which is the SQL `documents`
 * column name (snake_case), NOT the SDK's camelCase request field name —
 * to how to render the fresh DocumentSummary value into this form's text
 * representation for that field. The inverse of buildMetadataDiff's
 * per-field parsing. */
const ENRICHABLE_FIELDS: Record<string, (document: DocumentSummary, setForm: FormUpdater) => void> =
  {
    title: (doc, set) => set((prev) => ({ ...prev, title: doc.title ?? prev.title })),
    authors: (doc, set) => set((prev) => ({ ...prev, authorsText: joinCommaList(doc.authors) })),
    document_type: (doc, set) => set((prev) => ({ ...prev, documentType: doc.document_type })),
    publication_year: (doc, set) =>
      set((prev) => ({
        ...prev,
        publicationYearText: doc.publication_year ? String(doc.publication_year) : '',
      })),
    source_venue: (doc, set) => set((prev) => ({ ...prev, sourceVenue: doc.source_venue ?? '' })),
    volume: (doc, set) => set((prev) => ({ ...prev, volume: doc.volume ?? '' })),
    issue: (doc, set) => set((prev) => ({ ...prev, issue: doc.issue ?? '' })),
    page_start: (doc, set) =>
      set((prev) => ({ ...prev, pageStartText: doc.page_start ? String(doc.page_start) : '' })),
    page_end: (doc, set) =>
      set((prev) => ({ ...prev, pageEndText: doc.page_end ? String(doc.page_end) : '' })),
    publisher: (doc, set) => set((prev) => ({ ...prev, publisher: doc.publisher ?? '' })),
    doi: (doc, set) => set((prev) => ({ ...prev, doi: doc.doi ?? '' })),
    source_url: (doc, set) => set((prev) => ({ ...prev, sourceUrl: doc.source_url ?? '' })),
    abstract: (doc, set) => set((prev) => ({ ...prev, abstract: doc.abstract ?? '' })),
    language: (doc, set) => set((prev) => ({ ...prev, language: doc.language ?? '' })),
  };

/** Milestone 4.1 §33 — concise, non-alarming copy for every possible
 * enrichment outcome. Never implies infallibility ("verified") — a
 * successful lookup is reported as what changed, not as a correctness
 * guarantee. */
export function describeEnrichmentOutcome(result: DocumentEnrichmentResponse): {
  tone: 'ok' | 'info' | 'danger';
  message: string;
} {
  switch (result.status) {
    case 'succeeded': {
      const updated = (result.fields_updated ?? []).length;
      if (updated === 0) {
        return { tone: 'info', message: 'Metadata is already up to date.' };
      }
      const fieldWord = updated === 1 ? 'field' : 'fields';
      const preserved = result.manual_fields_preserved;
      const preservedNote =
        preserved > 0
          ? ` ${preserved} manually confirmed ${preserved === 1 ? 'field was' : 'fields were'} preserved.`
          : '';
      return {
        tone: 'ok',
        message: `Updated ${updated} ${fieldWord} from Crossref.${preservedNote}`,
      };
    }
    case 'not_found':
      return { tone: 'info', message: 'No scholarly metadata was found for this DOI.' };
    case 'timeout':
    case 'unavailable':
    case 'malformed_response':
    case 'unknown_error':
      return { tone: 'info', message: 'Metadata lookup is temporarily unavailable.' };
    case 'rate_limited':
      return {
        tone: 'info',
        message: 'Metadata lookup is temporarily rate-limited — try again shortly.',
      };
    case 'disabled':
      return { tone: 'info', message: 'Metadata lookup is not enabled on this server.' };
    case 'no_doi':
    case 'not_found_document':
    default:
      return { tone: 'info', message: 'Metadata lookup is unavailable for this document.' };
  }
}

const MAX_ABSTRACT_CHARS = 8000;

function joinCommaList(values: readonly string[] | null | undefined): string {
  return (values ?? []).join(', ');
}

/** Mirrors the backend's own comma-splitting (see POST /documents' `authors`
 * Form field) — trims each piece, drops empty ones, never invents an entry
 * out of stray punctuation. */
function splitCommaList(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseOptionalInt(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Milestone 4 (Reference Library & Bibliographic Metadata Foundation)
 * Section 9: everything the "Edit metadata" action actually changed,
 * relative to `document`'s current values — never the whole form
 * unconditionally, so PATCH /documents/{id}/metadata's per-field "user"
 * provenance stamp (see its own docstring) only ever lands on fields the
 * user genuinely touched, not every field merely because the form was
 * saved. Returns {} (nothing to send) when nothing changed — the caller
 * treats that as a no-op, never an empty network request.
 */
export function buildMetadataDiff(
  document: DocumentSummary,
  form: EditMetadataFormState
): Partial<UpdateDocumentMetadataRequest> {
  const diff: Partial<UpdateDocumentMetadataRequest> = {};

  const trimmedTitle = form.title.trim();
  if (trimmedTitle !== (document.title ?? '')) diff.title = trimmedTitle;

  const authors = splitCommaList(form.authorsText);
  if (!arraysEqual(authors, document.authors ?? [])) diff.authors = authors;

  if (form.documentType !== document.document_type) diff.documentType = form.documentType;

  const publicationYear = parseOptionalInt(form.publicationYearText);
  if (publicationYear !== (document.publication_year ?? null)) {
    diff.publicationYear = publicationYear;
  }

  const sourceVenue = form.sourceVenue.trim() || null;
  if (sourceVenue !== (document.source_venue ?? null)) diff.sourceVenue = sourceVenue;

  const doi = form.doi.trim() || null;
  if (doi !== (document.doi ?? null)) diff.doi = doi;

  const sourceUrl = form.sourceUrl.trim() || null;
  if (sourceUrl !== (document.source_url ?? null)) diff.sourceUrl = sourceUrl;

  const volume = form.volume.trim() || null;
  if (volume !== (document.volume ?? null)) diff.volume = volume;

  const issue = form.issue.trim() || null;
  if (issue !== (document.issue ?? null)) diff.issue = issue;

  const pageStart = parseOptionalInt(form.pageStartText);
  if (pageStart !== (document.page_start ?? null)) diff.pageStart = pageStart;

  const pageEnd = parseOptionalInt(form.pageEndText);
  if (pageEnd !== (document.page_end ?? null)) diff.pageEnd = pageEnd;

  const publisher = form.publisher.trim() || null;
  if (publisher !== (document.publisher ?? null)) diff.publisher = publisher;

  const abstract = form.abstract.trim() || null;
  if (abstract !== (document.abstract ?? null)) diff.abstract = abstract;

  const keywords = splitCommaList(form.keywordsText);
  if (!arraysEqual(keywords, document.keywords ?? [])) diff.keywords = keywords;

  const language = form.language.trim() || null;
  if (language !== (document.language ?? null)) diff.language = language;

  return diff;
}

export interface EditMetadataFormState {
  title: string;
  authorsText: string;
  documentType: DocumentType;
  publicationYearText: string;
  sourceVenue: string;
  doi: string;
  sourceUrl: string;
  volume: string;
  issue: string;
  pageStartText: string;
  pageEndText: string;
  publisher: string;
  abstract: string;
  keywordsText: string;
  language: string;
}

function initialFormState(document: DocumentSummary): EditMetadataFormState {
  return {
    title: document.title ?? document.source_filename,
    authorsText: joinCommaList(document.authors),
    documentType: document.document_type,
    publicationYearText: document.publication_year ? String(document.publication_year) : '',
    sourceVenue: document.source_venue ?? '',
    doi: document.doi ?? '',
    sourceUrl: document.source_url ?? '',
    volume: document.volume ?? '',
    issue: document.issue ?? '',
    pageStartText: document.page_start ? String(document.page_start) : '',
    pageEndText: document.page_end ? String(document.page_end) : '',
    publisher: document.publisher ?? '',
    abstract: document.abstract ?? '',
    keywordsText: joinCommaList(document.keywords),
    language: document.language ?? '',
  };
}

/**
 * Milestone 4 Section 9 — the "Edit metadata" action: existing values
 * prefilled, save persists only what actually changed through
 * PATCH /documents/{id}/metadata (SQL-only — never re-uploads, re-chunks,
 * re-embeds, or touches Qdrant, so highlights/Research Notes/project
 * membership/Reader anchors are all untouched), cancel changes nothing.
 * Title cannot be saved empty (same rule the backend itself enforces);
 * every other field can be cleared by deleting its text.
 */
export function EditMetadataModal({
  document,
  saving,
  error,
  onCancel,
  onSave,
  onRefreshMetadata,
  refreshingMetadata = false,
}: EditMetadataModalProps) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [form, setForm] = useState<EditMetadataFormState>(() => initialFormState(document));
  const [refreshOutcome, setRefreshOutcome] = useState<DocumentEnrichmentResponse | null>(null);

  const titleTrimmed = form.title.trim();
  const diff = buildMetadataDiff(document, form);
  const canSave = titleTrimmed.length > 0 && Object.keys(diff).length > 0 && !saving;
  const busy = saving || refreshingMetadata;

  function set<K extends keyof EditMetadataFormState>(key: K, value: EditMetadataFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleRefreshMetadata(): Promise<void> {
    if (!onRefreshMetadata || refreshingMetadata) return;
    setRefreshOutcome(null);
    const result = await onRefreshMetadata();
    setRefreshOutcome(result);
    // Section 8/12: apply ONLY the fields the backend actually changed —
    // any other field the user is mid-editing here (unsaved) is left
    // exactly as they typed it, never overwritten by a refresh.
    for (const field of result.fields_updated ?? []) {
      const apply = ENRICHABLE_FIELDS[field];
      apply?.(result.document, setForm);
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close edit metadata"
        />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Edit metadata</Text>
            <IconButton
              label="Close"
              icon={<CloseIcon size={16} color={theme.faint} />}
              size="sm"
              onPress={onCancel}
            />
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <TextField
              label="Title"
              value={form.title}
              onChangeText={(v) => set('title', v)}
              editable={!busy}
              error={titleTrimmed.length === 0 ? 'Title cannot be empty' : null}
            />
            <TextField
              label="Authors"
              value={form.authorsText}
              onChangeText={(v) => set('authorsText', v)}
              placeholder="Comma-separated (optional)"
              editable={!busy}
            />

            <Text style={styles.sectionLabel}>Reference type</Text>
            <View style={styles.chipWrap}>
              {DOCUMENT_TYPES.map((type) => (
                <Pressable
                  key={type}
                  onPress={() => set('documentType', type)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: form.documentType === type }}
                  accessibilityLabel={DOCUMENT_TYPE_LABELS[type]}
                  disabled={busy}
                  style={[styles.chip, form.documentType === type && styles.chipActive]}
                >
                  <Text
                    style={[styles.chipText, form.documentType === type && styles.chipTextActive]}
                  >
                    {DOCUMENT_TYPE_LABELS[type]}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Publication</Text>
            <TextField
              label="Publication year"
              value={form.publicationYearText}
              onChangeText={(v) => set('publicationYearText', v)}
              placeholder="Optional"
              keyboardType="number-pad"
              editable={!busy}
            />
            <TextField
              label="Venue / journal"
              value={form.sourceVenue}
              onChangeText={(v) => set('sourceVenue', v)}
              placeholder="Optional"
              editable={!busy}
            />
            <View style={styles.row}>
              <View style={styles.rowField}>
                <TextField
                  label="Volume"
                  value={form.volume}
                  onChangeText={(v) => set('volume', v)}
                  placeholder="Optional"
                  editable={!busy}
                />
              </View>
              <View style={styles.rowField}>
                <TextField
                  label="Issue"
                  value={form.issue}
                  onChangeText={(v) => set('issue', v)}
                  placeholder="Optional"
                  editable={!busy}
                />
              </View>
            </View>
            <View style={styles.row}>
              <View style={styles.rowField}>
                <TextField
                  label="Page start"
                  value={form.pageStartText}
                  onChangeText={(v) => set('pageStartText', v)}
                  placeholder="Optional"
                  keyboardType="number-pad"
                  editable={!busy}
                />
              </View>
              <View style={styles.rowField}>
                <TextField
                  label="Page end"
                  value={form.pageEndText}
                  onChangeText={(v) => set('pageEndText', v)}
                  placeholder="Optional"
                  keyboardType="number-pad"
                  editable={!busy}
                />
              </View>
            </View>
            <TextField
              label="Publisher"
              value={form.publisher}
              onChangeText={(v) => set('publisher', v)}
              placeholder="Optional"
              editable={!busy}
            />
            <TextField
              label="DOI"
              value={form.doi}
              onChangeText={(v) => set('doi', v)}
              placeholder="Optional"
              autoCapitalize="none"
              editable={!busy}
            />

            {onRefreshMetadata && (
              <View style={styles.refreshRow}>
                <View style={styles.refreshTextGroup}>
                  <Text style={styles.refreshLabel}>Authoritative metadata</Text>
                  <Text style={styles.refreshHint}>
                    {document.has_usable_doi
                      ? 'Look up this DOI against Crossref and fill in or correct fields Crossref covers.'
                      : 'Add a DOI above and save first — a DOI is required to look up authoritative metadata.'}
                  </Text>
                </View>
                <Button
                  label="Refresh metadata"
                  variant="secondary"
                  size="sm"
                  onPress={handleRefreshMetadata}
                  disabled={!document.has_usable_doi || busy}
                  loading={refreshingMetadata}
                />
              </View>
            )}
            {refreshOutcome &&
              (() => {
                const outcome = describeEnrichmentOutcome(refreshOutcome);
                return <Notice tone={outcome.tone} body={outcome.message} />;
              })()}

            <TextField
              label="Source URL"
              value={form.sourceUrl}
              onChangeText={(v) => set('sourceUrl', v)}
              placeholder="Optional"
              autoCapitalize="none"
              editable={!busy}
            />

            <Text style={styles.sectionLabel}>Description</Text>
            <TextField
              label="Abstract"
              value={form.abstract}
              onChangeText={(v) => set('abstract', v)}
              placeholder="Optional"
              multiline
              maxLength={MAX_ABSTRACT_CHARS}
              editable={!busy}
            />
            <TextField
              label="Keywords"
              value={form.keywordsText}
              onChangeText={(v) => set('keywordsText', v)}
              placeholder="Comma-separated (optional)"
              editable={!busy}
            />
            <TextField
              label="Language"
              value={form.language}
              onChangeText={(v) => set('language', v)}
              placeholder="e.g. en (optional)"
              autoCapitalize="none"
              editable={!busy}
            />

            {error && <Notice tone="danger" body={error} />}
          </ScrollView>

          <View style={styles.footer}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} disabled={busy} />
            <Button
              label="Save"
              variant="primary"
              size="sm"
              onPress={() => onSave(diff)}
              disabled={!canSave}
              loading={saving}
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
      zIndex: 40,
      elevation: 40,
    },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: theme.overlay },
    panel: {
      width: 420,
      maxWidth: '92%',
      maxHeight: '86%',
      backgroundColor: theme.card,
      borderRadius: theme.radius.lg,
      padding: 16,
      gap: 10,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontFamily: theme.fonts.display, color: theme.text },
    scroll: { flexGrow: 0 },
    scrollContent: { gap: 10, paddingBottom: 4 },
    sectionLabel: {
      fontSize: 11,
      fontFamily: theme.fonts.bodySemibold,
      color: theme.faint,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: 6,
    },
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: theme.radius.pill,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    chipActive: { backgroundColor: theme.accentSoft, borderColor: theme.accent },
    chipText: { fontSize: 12, fontFamily: theme.fonts.body, color: theme.subtext },
    chipTextActive: { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
    row: { flexDirection: 'row', gap: 10 },
    rowField: { flex: 1 },
    refreshRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 10,
      borderRadius: theme.radius.md,
      backgroundColor: theme.cardPressed,
    },
    refreshTextGroup: { flex: 1, gap: 2 },
    refreshLabel: { fontSize: 12, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    refreshHint: { fontSize: 11, fontFamily: theme.fonts.body, color: theme.faint },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.divider,
    },
  });
}
