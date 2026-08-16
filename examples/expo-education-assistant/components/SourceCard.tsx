import type { Citation, MappedSource } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { FileIcon } from '@/components/icons';
import { useClient } from '@/lib/ClientProvider';
import { copyToClipboard } from '@/lib/clipboard';
import { formatAuthorsCompact, parseJournalCitation, safeText } from '@/lib/format';
import { useTheme, usePreferences } from '@/lib/Preferences';
import { isSampleSource } from '@/lib/sampleDocument';

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

// react-test-renderer never actually lays text out, so there is no
// reliable cross-platform "did this text actually wrap past N lines"
// signal available at render time (RN's Text#onTextLayout only fires
// against a real text-measurement engine). This character-count estimate
// is a deliberately conservative proxy for "would ~4 lines of this card's
// body text actually clip" — approximate, but it means "Show more" only
// ever appears when the excerpt is genuinely long, and never hides a
// truncated excerpt behind no toggle at all.
const TRUNCATION_THRESHOLD_CHARS = 200;
const COLLAPSED_NUMBER_OF_LINES = 4;
const COPY_FEEDBACK_MS = 1500;

function buildDoiUrl(doi: string | null): string | null {
  if (!doi) return null;
  const trimmed = doi.trim();
  return DOI_PATTERN.test(trimmed) ? `https://doi.org/${trimmed}` : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Deliberately narrower than "is this a URL": source_url is extracted from
 * uploaded document metadata (an HTML file's own og:url/canonical tag, an
 * embedded PDF/DOCX property, ...) — attacker-controlled content, not
 * something this app generated. Restricting to http(s) means a crafted
 * `javascript:`/`data:`/`file:` value can never end up passed to
 * Linking.openURL() just because `new URL()` happened to parse it.
 */
function isValidUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Picks one link to show, preferring HTTPS. A source_url that isn't valid
 * HTTPS falls back to a DOI link (validated against the real DOI shape,
 * never assumed) before falling back to the source_url over plain HTTP as
 * a last resort. Never fabricates a URL that wasn't actually provided.
 */
function preferredLink(
  sourceUrl: string | null,
  doi: string | null
): { label: string; url: string } | null {
  if (sourceUrl && isHttpsUrl(sourceUrl)) return { label: 'Open source', url: sourceUrl };
  const doiUrl = buildDoiUrl(doi);
  if (doiUrl) return { label: 'Open via DOI', url: doiUrl };
  if (sourceUrl && isValidUrl(sourceUrl))
    return { label: 'Open source (unencrypted link)', url: sourceUrl };
  return null;
}

/** "Page 17" for a single page, "Pages 17–18" for a genuine range — never a bare number. Both fields come from the same citation and are equal today (chunks never span pages, see app/core/citation.py), but this handles a future range honestly either way. */
function formatPageRange(pageStart: number | null, pageEnd: number | null): string | null {
  const start = pageStart ?? pageEnd;
  const end = pageEnd ?? pageStart;
  if (start === null || end === null) return null;
  return start === end ? `Page ${start}` : `Pages ${start}–${end}`;
}

export interface SourceCardProps {
  source: MappedSource;
  highlighted?: boolean;
}

export function SourceCard({ source, highlighted = false }: SourceCardProps) {
  const theme = useTheme();
  const { client } = useClient();
  const { preferences } = usePreferences();
  const { citation, chunk } = source;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [citationCopied, setCitationCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const citationCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (citationCopyTimeoutRef.current) clearTimeout(citationCopyTimeoutRef.current);
    };
  }, []);

  const link = useMemo(
    () => preferredLink(citation.source_url, citation.doi),
    [citation.source_url, citation.doi]
  );
  // A source_venue shaped like a journal issue/volume citation (see
  // parseJournalCitation) carries its own page range (267-289, the
  // published page numbers) — a citable range that's far more useful on a
  // source card than the chunk's own page-within-the-PDF location, so it
  // takes priority whenever the venue decomposes into that shape.
  const parsedVenue = useMemo(
    () => parseJournalCitation(citation.source_venue),
    [citation.source_venue]
  );
  const pageLabel = useMemo(() => {
    if (parsedVenue) return formatPageRange(parsedVenue.pageStart, parsedVenue.pageEnd);
    return formatPageRange(citation.page_start, citation.page_end);
  }, [parsedVenue, citation.page_start, citation.page_end]);

  const excerpt = safeText(chunk.text, '(no excerpt available)');
  // This is the complete, backend-stored retrieved chunk (see
  // ConversationsRepository.add_assistant_message) — never the whole
  // source document, and never re-truncated here. "Show more" only
  // changes how much of it is *visible*, not what was fetched.
  const isTruncatable = excerpt.length > TRUNCATION_THRESHOLD_CHARS;

  async function handleOpen(): Promise<void> {
    if (!link) return;
    try {
      const supported = await Linking.canOpenURL(link.url);
      if (supported) await Linking.openURL(link.url);
    } catch {
      // Swallow: a broken external link must not crash the app.
    }
  }

  async function handleCopyExcerpt(): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
        await navigator.clipboard.writeText(excerpt);
      } else {
        // react-native's own Clipboard is deprecated in favor of
        // @react-native-clipboard/clipboard, but adding a new native
        // dependency is out of scope for this optional action — this
        // still works in a full (non-Expo-Go) build, and fails silently
        // below if it doesn't.
        Clipboard.setString(excerpt);
      }
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Swallow: clipboard access can be unavailable/denied and must
      // never crash the app over an optional convenience action.
    }
  }

  // Milestone 4.2 (Citation & BibTeX Foundation) Section 27 — a
  // bibliographic reference citation, distinct from the provenance
  // "Copy excerpt" action above: this copies a formatted APA/IEEE
  // citation of the SOURCE DOCUMENT, never the retrieved passage text.
  // Only offered when this citation actually maps to a library Document
  // (document_id present) — an attachment-kind citation has no
  // bibliographic identity to cite. Never replaces or alters the [S1]
  // provenance marker/excerpt UI above.
  async function handleCopyReferenceCitation(): Promise<void> {
    if (!citation.document_id) return;
    try {
      const result = await client.getDocumentCitation(
        citation.document_id,
        preferences.citationStyle
      );
      const ok = await copyToClipboard(result.formatted);
      if (!ok) return;
      setCitationCopied(true);
      if (citationCopyTimeoutRef.current) clearTimeout(citationCopyTimeoutRef.current);
      citationCopyTimeoutRef.current = setTimeout(() => setCitationCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Swallow: an optional convenience action must never crash the
      // conversation view over a failed lookup.
    }
  }

  const isSample = isSampleSource(chunk.source_filename);

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
          borderRadius: theme.radius.md,
        },
        highlighted && { borderColor: theme.citation, backgroundColor: theme.citationSoft },
      ]}
    >
      <View style={styles.headerRow}>
        <Text
          style={[styles.sourceId, { color: theme.citation, fontFamily: theme.fonts.bodyBold }]}
        >
          [{source.sourceId}]
        </Text>
        {chunk.scope === 'project' && (
          // Frontend Milestone 2.1 §19 — `scope` already reaches every
          // source/citation end-to-end (RetrievedChunk.scope ->
          // MessageSourceResponse.scope -> DisplaySource.scope, stamped
          // server-side by execute_scope_plan — see
          // app/core/retrieval_schemas.py), so this only ever labels a
          // chunk that genuinely came from the project retrieval tier —
          // never a guess. Deliberately doesn't also label "chat"/
          // "general" sources: those are the default, unlabeled
          // expectation: "this citation came from somewhere other than
          // your own selected/general library" is the one distinction
          // worth surfacing here.
          <View
            style={[
              styles.projectBadge,
              { backgroundColor: theme.accentSoft, borderRadius: theme.radius.sm },
            ]}
          >
            <Text
              style={[
                styles.projectBadgeText,
                { color: theme.accent, fontFamily: theme.fonts.bodyBold },
              ]}
            >
              Project
            </Text>
          </View>
        )}
        {isSample && (
          <View
            style={[
              styles.sampleBadge,
              { backgroundColor: theme.warningSoft, borderRadius: theme.radius.sm },
            ]}
          >
            <Text
              style={[
                styles.sampleBadgeText,
                { color: theme.warning, fontFamily: theme.fonts.bodyBold },
              ]}
            >
              Sample content — not real evidence
            </Text>
          </View>
        )}
      </View>
      <Text style={[styles.title, { color: theme.text, fontFamily: theme.fonts.bodySemibold }]}>
        {safeText(citation.title, 'Untitled source')}
      </Text>
      <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}>
        {formatAuthorsCompact(citation.authors)}
        {citation.publication_year ? ` · ${citation.publication_year}` : ''}
      </Text>
      {citation.source_venue ? (
        <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}>
          {parsedVenue?.journalTitle ?? citation.source_venue}
        </Text>
      ) : null}
      {pageLabel ? (
        <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}>
          {pageLabel}
        </Text>
      ) : null}
      {citation.doi ? (
        <Text style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.mono }]}>
          DOI: {citation.doi}
        </Text>
      ) : null}

      <Text
        style={[styles.excerpt, { color: theme.text, fontFamily: theme.fonts.body }]}
        numberOfLines={expanded || !isTruncatable ? undefined : COLLAPSED_NUMBER_OF_LINES}
        selectable
      >
        {excerpt}
      </Text>
      {isTruncatable && (
        <Pressable
          onPress={() => setExpanded((current) => !current)}
          style={styles.toggleButton}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
        >
          <Text
            style={[styles.toggleText, { color: theme.accent, fontFamily: theme.fonts.bodyBold }]}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </Pressable>
      )}

      <View style={styles.actionsRow}>
        {link ? (
          <Pressable
            onPress={handleOpen}
            style={styles.linkButton}
            accessibilityRole="button"
            hitSlop={8}
          >
            <Text
              style={[
                styles.linkText,
                { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
              ]}
            >
              {link.label}
            </Text>
          </Pressable>
        ) : (
          <Text style={[styles.noLink, { color: theme.faint, fontFamily: theme.fonts.body }]}>
            No link available
          </Text>
        )}
        <Pressable
          onPress={handleCopyExcerpt}
          style={styles.linkButton}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text
            style={[styles.linkText, { color: theme.accent, fontFamily: theme.fonts.bodySemibold }]}
          >
            {copied ? 'Copied!' : 'Copy excerpt'}
          </Text>
        </Pressable>
        {citation.document_id && (
          <Pressable
            onPress={handleCopyReferenceCitation}
            style={styles.linkButton}
            accessibilityRole="button"
            accessibilityLabel="Copy reference citation"
            hitSlop={8}
          >
            <Text
              style={[
                styles.linkText,
                { color: theme.accent, fontFamily: theme.fonts.bodySemibold },
              ]}
            >
              {citationCopied ? 'Copied!' : 'Copy citation'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export interface AttachmentSourceCardProps {
  citation: Citation;
  highlighted?: boolean;
  /** Present only when this citation's attachment is actually openable in
   * this turn's lightbox (see ConversationTurnCard's viewableAttachments
   * lookup by attachment_id) — omitted rather than a no-op so the card
   * never looks pressable when there's nothing to open (e.g. a citation
   * surviving from an attachment that failed to load). */
  onPress?: () => void;
}

/**
 * Frontend/Platform Milestone 3.2.2 Part C — the display half of making a
 * message attachment a real, citeable source (see
 * app/core/citation.build_attachment_citations for the backend half).
 * Deliberately much thinner than SourceCard: an attachment citation has
 * no chunk text/score/DOI/venue — the honest thing to show is its label
 * and filename, with a way to open the actual file, never a fabricated
 * excerpt or metadata SourceCard implies exists for a retrieved corpus
 * chunk.
 */
export function AttachmentSourceCard({
  citation,
  highlighted = false,
  onPress,
}: AttachmentSourceCardProps) {
  const theme = useTheme();
  const body = (
    <>
      <Text style={[styles.sourceId, { color: theme.citation, fontFamily: theme.fonts.bodyBold }]}>
        [{citation.source_id}]
      </Text>
      <FileIcon size={14} color={theme.subtext} />
      <Text
        style={[styles.attachmentName, { color: theme.text, fontFamily: theme.fonts.bodySemibold }]}
        numberOfLines={1}
      >
        {safeText(citation.display_name, 'Attached file')}
      </Text>
    </>
  );

  const cardStyle = [
    styles.card,
    styles.attachmentCard,
    { backgroundColor: theme.card, borderColor: theme.border, borderRadius: theme.radius.md },
    highlighted && { borderColor: theme.citation, backgroundColor: theme.citationSoft },
  ];

  if (!onPress) {
    return <View style={cardStyle}>{body}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      style={cardStyle}
      accessibilityRole="button"
      accessibilityLabel={`Open attached file ${safeText(citation.display_name, 'attachment')}, source ${citation.source_id}`}
    >
      {body}
    </Pressable>
  );
}

/** Rendered for a [S<n>] marker whose id has no matching backend citation — never invents a source. */
export function UnavailableSourceChip({ sourceId }: { sourceId: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.unavailableChip,
        { backgroundColor: theme.dangerSoft, borderRadius: theme.radius.sm },
      ]}
    >
      <Text style={[styles.unavailableText, { color: theme.danger, fontFamily: theme.fonts.body }]}>
        [{sourceId}] — source unavailable
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  sourceId: {},
  attachmentCard: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attachmentName: { fontSize: 14, flexShrink: 1 },
  sampleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sampleBadgeText: { fontSize: 10 },
  projectBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  projectBadgeText: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 },
  title: { fontSize: 15, marginBottom: 2 },
  meta: { fontSize: 12 },
  excerpt: { fontSize: 13, marginTop: 6, marginBottom: 4, lineHeight: 19 },
  toggleButton: { alignSelf: 'flex-start', marginBottom: 6, paddingVertical: 2 },
  toggleText: { fontSize: 12 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  linkButton: { alignSelf: 'flex-start' },
  linkText: { fontSize: 13 },
  noLink: { fontSize: 12, fontStyle: 'italic' },
  unavailableChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  unavailableText: { fontSize: 12 },
});
