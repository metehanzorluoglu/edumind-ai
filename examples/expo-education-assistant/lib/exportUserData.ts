import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Saves a JSON payload (the Settings screen's "Export my data" output) to
 * the user's device, using the exact same platform split as
 * downloadAttachment.ts:
 *
 * Web: a real browser download via a temporary `<a download>` element.
 * Native: write the bytes into the app's cache and hand the file to the OS
 * share sheet (Save to Files / Save to Downloads / etc.). Throws if the
 * device has no share sheet — callers surface that as a normal error.
 *
 * The payload is assembled by the caller from data the signed-in user is
 * already entitled to see (their own profile, conversations, documents) —
 * nothing here adds access to anyone else's data, and no auth material is
 * ever included in the export.
 */
export async function saveJsonExport(filename: string, payload: unknown): Promise<void> {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });

  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
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
  const file = new ExpoFile(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json' });
}
