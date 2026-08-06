import { AuthenticatedAttachmentImage } from '@/components/AuthenticatedAttachmentImage';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';
import { formatFileSize } from '@/lib/documentUpload';
import { pdfPageLimitNotice } from '@/lib/visionLimits';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

export interface AttachmentChipProps {
  info: AttachmentChipInfo;
  /** A local `blob:`/`file://` preview URI for a not-yet-sent image attachment — takes precedence over `info.remote` (a not-yet-sent attachment never has one anyway). Omitted for a PDF (no thumbnail rendering — see PendingAttachment's docs). */
  thumbnailUri?: string | null;
  /** Present only in the pre-send composer preview — a persisted (already-sent) attachment can never be removed here. */
  onRemove?: () => void;
  /** A local validation failure (unsupported type / oversized) — only ever set for a not-yet-sent attachment. */
  error?: string | null;
  /** Opens the full-size lightbox (milestone V4) — only ever passed for an already-persisted attachment; a not-yet-sent one has no server-rendered preview to show full-size yet. */
  onPress?: () => void;
}

function fileKindLabel(mimeType: string | null): string {
  if (!mimeType) return 'File';
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return mimeType.replace('image/', '').toUpperCase();
  return mimeType;
}

/** One attachment's summary — filename, filesize, kind, page count/range when known, and (composer only) a thumbnail and Remove button. Shared by AttachmentPreviewRow (pre-send) and ConversationTurnCard (already-persisted history) so the two never render this information differently. */
export function AttachmentChip({
  info,
  thumbnailUri,
  onRemove,
  error,
  onPress,
}: AttachmentChipProps) {
  const pageLimitNotice = pdfPageLimitNotice(info.pageCount);
  const thumbnail = thumbnailUri ? (
    <Image source={{ uri: thumbnailUri }} style={styles.thumbnail} resizeMode="cover" />
  ) : info.remote && info.mimeType?.startsWith('image/') ? (
    <AuthenticatedAttachmentImage
      conversationId={info.remote.conversationId}
      messageId={info.remote.messageId}
      attachmentId={info.key}
      style={styles.thumbnail}
    />
  ) : (
    <View style={[styles.thumbnail, styles.thumbnailPlaceholder]}>
      <Text style={styles.thumbnailPlaceholderText}>{fileKindLabel(info.mimeType)}</Text>
    </View>
  );

  return (
    <View style={[styles.chip, error && styles.chipError]}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`View ${info.filename}`}
        >
          {thumbnail}
        </Pressable>
      ) : (
        thumbnail
      )}
      <View style={styles.info}>
        <Text style={styles.filename} numberOfLines={1}>
          {info.filename}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {info.sizeBytes !== null ? formatFileSize(info.sizeBytes) : 'Unknown size'}
          {info.pageCount !== null
            ? ` · ${info.pageCount} page${info.pageCount === 1 ? '' : 's'}`
            : ''}
          {info.pageRangeStart !== null && info.pageRangeEnd !== null
            ? ` · pages ${info.pageRangeStart}-${info.pageRangeEnd}`
            : ''}
        </Text>
        {pageLimitNotice && (
          <Text style={styles.pageLimitNotice} numberOfLines={2}>
            {pageLimitNotice}
          </Text>
        )}
        {error && (
          <Text style={styles.errorText} numberOfLines={2}>
            {error}
          </Text>
        )}
      </View>
      {onRemove && (
        <Pressable
          onPress={onRemove}
          style={styles.removeButton}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${info.filename}`}
        >
          <Text style={styles.removeButtonText}>✕</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    padding: 6,
    backgroundColor: '#FFFFFF',
    gap: 8,
    maxWidth: 220,
  },
  chipError: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  thumbnail: { width: 36, height: 36, borderRadius: 6 },
  thumbnailPlaceholder: {
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: { fontSize: 9, fontWeight: '700', color: '#2F5FE0' },
  info: { flex: 1, minWidth: 0 },
  filename: { fontSize: 12, fontWeight: '600', color: '#14161F' },
  meta: { fontSize: 10, color: '#64748B', marginTop: 1 },
  errorText: { fontSize: 10, color: '#B91C1C', marginTop: 2 },
  pageLimitNotice: { fontSize: 10, color: '#A3620C', marginTop: 2 },
  removeButton: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
  },
  removeButtonText: { fontSize: 11, color: '#475569', fontWeight: '700' },
});
