import type { ConversationMessageAttachment } from 'education-assistant-client';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AttachmentLightbox } from '@/components/AttachmentLightbox';
import { AuthenticatedAttachmentImage } from '@/components/AuthenticatedAttachmentImage';
import { SaveImageToProjectPicker } from '@/components/SaveImageToProjectPicker';
import {
  attachmentChipFromPersisted,
  createPendingAttachmentFromRemote,
  type PendingAttachment,
} from '@/lib/chatAttachments';
import { useClient } from '@/lib/ClientProvider';
import { useFeatureFlags } from '@/lib/FeatureFlags';
import { downloadAttachment } from '@/lib/downloadAttachment';
import { isReferenceMimeType } from '@/lib/referenceImages';
import type { ImageGenerationFormInitialValues } from '@/components/ImageGenerationModal';

export interface GeneratedImageGalleryProps {
  conversationId: string;
  messageId: string;
  /** Already filtered to `source === "generated"` by the caller (see ConversationTurnCard). */
  images: ConversationMessageAttachment[];
  /** The batch's reference images (source="reference") — not rendered as tiles,
   * but folded into the Regenerate payload so the modal can prefill them. */
  referenceImages?: ConversationMessageAttachment[];
  onUseAsAttachment: (pending: PendingAttachment) => void;
  onRegenerate: (initialValues: ImageGenerationFormInitialValues) => void;
}

/**
 * Renders one image-generation batch (all attachments of the same
 * standalone assistant message — see chat/[id].tsx's pairMessages) as a
 * small grid, each tile with Download / Regenerate / Use as attachment /
 * Save to project. Reuses AuthenticatedAttachmentImage/AttachmentLightbox
 * unchanged — a generated image is fetched/displayed through the exact
 * same authenticated content-serving endpoint as any uploaded attachment
 * (see rag-backend's GET .../attachments/{id}); only the actions below are
 * new.
 */
export function GeneratedImageGallery({
  conversationId,
  messageId,
  images,
  referenceImages = [],
  onUseAsAttachment,
  onRegenerate,
}: GeneratedImageGalleryProps) {
  const { client } = useClient();
  const { imageGenerator: imageGeneratorEnabled } = useFeatureFlags();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const [pickerForId, setPickerForId] = useState<string | null>(null);
  // Optimistic override, keyed by attachment id — the persisted
  // `image.saved_project_id` only reflects reality as of the last
  // GET /conversations/{id}; this reflects the *last successful*
  // PATCH /attachments/{id}/project from this screen without waiting for
  // a reload().
  const [savedProjectOverride, setSavedProjectOverride] = useState<Record<string, string | null>>(
    {}
  );

  const chips = images.map((image) =>
    attachmentChipFromPersisted(image, { conversationId, messageId })
  );

  function savedProjectFor(image: ConversationMessageAttachment): string | null {
    return image.id in savedProjectOverride
      ? savedProjectOverride[image.id]!
      : (image.saved_project_id ?? null);
  }

  async function handleDownload(image: ConversationMessageAttachment): Promise<void> {
    setBusyId(image.id);
    setErrorById((prev) => ({ ...prev, [image.id]: null }));
    try {
      await downloadAttachment(client, { conversationId, messageId }, image);
    } catch (err) {
      setErrorById((prev) => ({
        ...prev,
        [image.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleUseAsAttachment(image: ConversationMessageAttachment): Promise<void> {
    setBusyId(image.id);
    setErrorById((prev) => ({ ...prev, [image.id]: null }));
    try {
      const pending = await createPendingAttachmentFromRemote(
        client,
        { conversationId, messageId },
        image
      );
      onUseAsAttachment(pending);
    } catch (err) {
      setErrorById((prev) => ({
        ...prev,
        [image.id]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveToProject(
    image: ConversationMessageAttachment,
    projectId: string | null
  ): Promise<void> {
    await client.saveAttachmentToProject(image.id, projectId);
    setSavedProjectOverride((prev) => ({ ...prev, [image.id]: projectId }));
  }

  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {images.map((image, index) => (
          <View key={image.id} style={styles.tile}>
            <Pressable
              onPress={() => setLightboxIndex(index)}
              accessibilityRole="button"
              accessibilityLabel="View full size"
            >
              <AuthenticatedAttachmentImage
                conversationId={conversationId}
                messageId={messageId}
                attachmentId={image.id}
                style={styles.thumbnail}
                resizeMode="cover"
              />
            </Pressable>

            <View style={styles.actionsRow}>
              <Pressable
                style={styles.actionButton}
                onPress={() => handleDownload(image)}
                disabled={busyId === image.id}
                accessibilityRole="button"
                accessibilityLabel="Download image"
              >
                <Text style={styles.actionText}>⬇ Download</Text>
              </Pressable>
              {imageGeneratorEnabled && (
                <Pressable
                  style={styles.actionButton}
                  onPress={() =>
                    onRegenerate({
                      prompt: image.generation_prompt ?? '',
                      negativePrompt: image.generation_negative_prompt ?? null,
                      width: image.generation_width ?? 512,
                      height: image.generation_height ?? 512,
                      // Reopen the modal with this batch's references as remote
                      // pointers; the modal re-fetches + re-encodes them so they
                      // can be previewed and resent. The server only ever stores
                      // image mimes for references, but filter defensively.
                      referenceImages: referenceImages
                        .filter((a) => isReferenceMimeType(a.mime))
                        .map((a) => ({
                          name: a.filename,
                          mimeType: a.mime as never,
                          remote: { conversationId, messageId, attachmentId: a.id },
                        })),
                    })
                  }
                  disabled={busyId === image.id}
                  accessibilityRole="button"
                  accessibilityLabel="Regenerate image"
                >
                  <Text style={styles.actionText}>↻ Regenerate</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.actionButton}
                onPress={() => handleUseAsAttachment(image)}
                disabled={busyId === image.id}
                accessibilityRole="button"
                accessibilityLabel="Use as attachment"
              >
                <Text style={styles.actionText}>📎 Use as attachment</Text>
              </Pressable>
              <Pressable
                style={styles.actionButton}
                onPress={() => setPickerForId(image.id)}
                disabled={busyId === image.id}
                accessibilityRole="button"
                accessibilityLabel="Save to project"
              >
                <Text style={styles.actionText}>
                  {savedProjectFor(image) ? '★ Saved to project' : '☆ Save to project'}
                </Text>
              </Pressable>
            </View>

            {busyId === image.id && <ActivityIndicator size="small" style={styles.busyIndicator} />}
            {errorById[image.id] && <Text style={styles.errorText}>{errorById[image.id]}</Text>}

            <SaveImageToProjectPicker
              visible={pickerForId === image.id}
              currentProjectId={savedProjectFor(image)}
              onClose={() => setPickerForId(null)}
              onSaved={(projectId) => handleSaveToProject(image, projectId)}
            />
          </View>
        ))}
      </View>

      <AttachmentLightbox
        visible={lightboxIndex !== null}
        attachments={chips}
        initialIndex={lightboxIndex ?? 0}
        onClose={() => setLightboxIndex(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: 220 },
  thumbnail: {
    width: 220,
    height: 220,
    borderRadius: 10,
    backgroundColor: '#E2E8F0',
  },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  actionButton: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  actionText: { fontSize: 11, color: '#334155' },
  busyIndicator: { marginTop: 6 },
  errorText: { fontSize: 11, color: '#B91C1C', marginTop: 4 },
});
