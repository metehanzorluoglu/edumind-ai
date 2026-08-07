import { AuthenticatedAttachmentImage } from '@/components/AuthenticatedAttachmentImage';
import { CloseIcon } from '@/components/icons';
import type { AttachmentChipInfo } from '@/lib/chatAttachments';
import { formatFileSize } from '@/lib/documentUpload';
import { useTheme } from '@/lib/Preferences';
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
  const theme = useTheme();
  const thumbnail = thumbnailUri ? (
    <Image
      source={{ uri: thumbnailUri }}
      style={[styles.thumbnail, { borderRadius: theme.radius.sm }]}
      resizeMode="cover"
    />
  ) : info.remote && info.mimeType?.startsWith('image/') ? (
    <AuthenticatedAttachmentImage
      conversationId={info.remote.conversationId}
      messageId={info.remote.messageId}
      attachmentId={info.key}
      style={[styles.thumbnail, { borderRadius: theme.radius.sm }]}
    />
  ) : (
    <View
      style={[
        styles.thumbnail,
        styles.thumbnailPlaceholder,
        { backgroundColor: theme.accentSoft, borderRadius: theme.radius.sm },
      ]}
    >
      <Text
        style={[
          styles.thumbnailPlaceholderText,
          { color: theme.accent, fontFamily: theme.fonts.bodyBold },
        ]}
      >
        {fileKindLabel(info.mimeType)}
      </Text>
    </View>
  );

  return (
    <View
      style={[
        styles.chip,
        { borderColor: theme.border, backgroundColor: theme.card, borderRadius: theme.radius.md },
        error && { borderColor: theme.danger, backgroundColor: theme.dangerSoft },
      ]}
    >
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
        <Text
          style={[styles.filename, { color: theme.text, fontFamily: theme.fonts.bodySemibold }]}
          numberOfLines={1}
        >
          {info.filename}
        </Text>
        <Text
          style={[styles.meta, { color: theme.subtext, fontFamily: theme.fonts.body }]}
          numberOfLines={1}
        >
          {info.sizeBytes !== null ? formatFileSize(info.sizeBytes) : 'Unknown size'}
          {info.pageCount !== null
            ? ` · ${info.pageCount} page${info.pageCount === 1 ? '' : 's'}`
            : ''}
          {info.pageRangeStart !== null && info.pageRangeEnd !== null
            ? ` · pages ${info.pageRangeStart}-${info.pageRangeEnd}`
            : ''}
        </Text>
        {error && (
          <Text
            style={[styles.errorText, { color: theme.danger, fontFamily: theme.fonts.body }]}
            numberOfLines={2}
          >
            {error}
          </Text>
        )}
      </View>
      {onRemove && (
        <Pressable
          onPress={onRemove}
          style={[styles.removeButton, { backgroundColor: theme.cardPressed }]}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${info.filename}`}
        >
          <CloseIcon size={12} color={theme.subtext} strokeWidth={2} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 6,
    gap: 8,
    maxWidth: 220,
  },
  thumbnail: { width: 36, height: 36 },
  thumbnailPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: { fontSize: 9 },
  info: { flex: 1, minWidth: 0 },
  filename: { fontSize: 12 },
  meta: { fontSize: 10, marginTop: 1 },
  errorText: { fontSize: 10, marginTop: 2 },
  removeButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
