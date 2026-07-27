import type { EducationAssistantClient } from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Downloads one persisted attachment (in practice, always a generated
 * image — see GeneratedImageGallery.tsx) to the user's device.
 *
 * Web: triggers a real browser download via a temporary `<a download>`
 * element — the standard way to save a fetched Blob to disk, since a
 * browser gives no other API for "save this in-memory data as a file".
 *
 * Native (iOS/Android): there is no OS-level "downloads folder" a managed
 * Expo app can write into directly, so this writes the bytes to the app's
 * own cache (expo-file-system's File API, same as
 * chatAttachments.ts's createPendingAttachmentFromRemote) and then hands
 * that file to the OS share sheet (expo-sharing) — the standard Expo
 * pattern for "let the user save/export a file the app produced", since
 * the share sheet itself offers Save to Photos / Save to Files / etc.
 * Throws if the current device has no share sheet at all (e.g. some
 * Android emulators) — callers should surface that as a normal error, not
 * silently swallow it.
 */
export async function downloadAttachment(
  client: EducationAssistantClient,
  location: { conversationId: string; messageId: string },
  attachment: { id: string; filename: string; mime: string }
): Promise<void> {
  const blob = await client.fetchAttachmentBlob(
    location.conversationId,
    location.messageId,
    attachment.id
  );

  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Sharing/saving files is not available on this device.');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, attachment.filename);
  file.create({ overwrite: true });
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: attachment.mime });
}
