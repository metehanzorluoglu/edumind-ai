import { attachmentChipFromPending, type PendingAttachment } from '@/lib/chatAttachments';
import { ScrollView, StyleSheet, View } from 'react-native';
import { AttachmentChip } from './AttachmentChip';

export interface AttachmentPreviewRowProps {
  attachments: PendingAttachment[];
  onRemove: (localId: string) => void;
}

/**
 * The pre-send attachment preview strip: thumbnail, filename, filesize,
 * remove. A PDF's page range is never chosen here — the backend analyzes
 * the whole document automatically (capped at its configured page limit;
 * see rag-backend's VISION_MAX_PDF_PAGES), so this row has nothing
 * PDF-specific to show before send.
 */
export function AttachmentPreviewRow({ attachments, onRemove }: AttachmentPreviewRowProps) {
  if (attachments.length === 0) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.row}>
      {attachments.map((attachment) => (
        <View key={attachment.localId} style={styles.item}>
          <AttachmentChip
            info={attachmentChipFromPending(attachment)}
            thumbnailUri={attachment.previewUri}
            onRemove={() => onRemove(attachment.localId)}
            error={attachment.error}
          />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8 },
  item: { marginRight: 8 },
});
