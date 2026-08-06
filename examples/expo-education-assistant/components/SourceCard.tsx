import type { MappedSource } from 'education-assistant-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Clipboard, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatAuthorsCompact, parseJournalCitation, safeText } from '@/lib/format';
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
  const { citation, chunk } = source;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
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

  const isSample = isSampleSource(chunk.source_filename);

  return (
    <View style={[styles.card, highlighted && styles.cardHighlighted]}>
      <View style={styles.headerRow}>
        <Text style={styles.sourceId}>[{source.sourceId}]</Text>
        {isSample && (
          <View style={styles.sampleBadge}>
            <Text style={styles.sampleBadgeText}>Sample content — not real evidence</Text>
          </View>
        )}
      </View>
      <Text style={styles.title}>{safeText(citation.title, 'Untitled source')}</Text>
      <Text style={styles.meta}>
        {formatAuthorsCompact(citation.authors)}
        {citation.publication_year ? ` · ${citation.publication_year}` : ''}
      </Text>
      {citation.source_venue ? (
        <Text style={styles.meta}>{parsedVenue?.journalTitle ?? citation.source_venue}</Text>
      ) : null}
      {pageLabel ? <Text style={styles.meta}>{pageLabel}</Text> : null}
      {citation.doi ? <Text style={styles.meta}>DOI: {citation.doi}</Text> : null}

      <Text
        style={styles.excerpt}
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
          <Text style={styles.toggleText}>{expanded ? 'Show less' : 'Show more'}</Text>
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
            <Text style={styles.linkText}>{link.label}</Text>
          </Pressable>
        ) : (
          <Text style={styles.noLink}>No link available</Text>
        )}
        <Pressable
          onPress={handleCopyExcerpt}
          style={styles.linkButton}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={styles.linkText}>{copied ? 'Copied!' : 'Copy excerpt'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Rendered for a [S<n>] marker whose id has no matching backend citation — never invents a source. */
export function UnavailableSourceChip({ sourceId }: { sourceId: string }) {
  return (
    <View style={styles.unavailableChip}>
      <Text style={styles.unavailableText}>[{sourceId}] — source unavailable</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#FFFFFF',
  },
  cardHighlighted: {
    // Ochre, not blue — matches the citation-marker convention (see
    // brand/BRAND_GUIDELINES.md §3): orange is reserved for citations and
    // source-grounding UI specifically, distinct from the blue used for
    // ordinary interactive elements.
    borderColor: '#B0641F',
    backgroundColor: '#FBF3EA',
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  sourceId: { fontWeight: '700', color: '#B0641F' },
  sampleBadge: {
    backgroundColor: '#FEF3C7',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sampleBadgeText: { fontSize: 10, fontWeight: '700', color: '#92400E' },
  title: { fontWeight: '600', fontSize: 15, marginBottom: 2 },
  meta: { fontSize: 12, color: '#475569' },
  excerpt: { fontSize: 13, color: '#334155', marginTop: 6, marginBottom: 4 },
  toggleButton: { alignSelf: 'flex-start', marginBottom: 6, paddingVertical: 2 },
  toggleText: { color: '#2F5FE0', fontSize: 12, fontWeight: '700' },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  linkButton: { alignSelf: 'flex-start' },
  linkText: { color: '#2F5FE0', fontSize: 13, fontWeight: '600' },
  noLink: { fontSize: 12, color: '#94A3B8', fontStyle: 'italic' },
  unavailableChip: {
    backgroundColor: '#FEF2F2',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  unavailableText: { color: '#B91C1C', fontSize: 12 },
});
