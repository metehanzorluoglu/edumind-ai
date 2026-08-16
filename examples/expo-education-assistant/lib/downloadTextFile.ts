import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Milestone 4.2 (Citation & BibTeX Foundation) Section 19/39 — "Download
 * BibTeX" for a single reference (and, by the same code path, multi-
 * reference `.bib` export). Same web/native split as
 * lib/downloadAttachment.ts (that module downloads server-fetched bytes;
 * this one downloads a plain string this app already has in memory —
 * distinct enough to warrant its own small function rather than forcing
 * a Blob-fetch shape onto data that never came from a network response).
 *
 * Web: a temporary `<a download>` element — the standard way to save an
 * in-memory string as a file, since a browser gives no other API for it.
 * The object URL is revoked immediately after the click (Section 39: "if
 * client-side Blob downloads are used: revoke object URLs — do not leak
 * Blob URLs").
 *
 * Native (iOS/Android): writes to the app's own cache (expo-file-system,
 * same as downloadAttachment.ts) and hands it to the OS share sheet
 * (expo-sharing) — there is no "downloads folder" a managed Expo app can
 * write into directly. Throws if no share sheet is available; callers
 * should surface that as a normal error.
 */
export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain'
): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      URL.revokeObjectURL(url);
    }
    return;
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Sharing/saving files is not available on this device.');
  }
  const file = new ExpoFile(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(content);
  await Sharing.shareAsync(file.uri, { mimeType });
}

/**
 * Milestone 4.2 Section 19 — a safe, deterministic `.bib` filename from a
 * citation key (e.g. "Forrester2004Laser" -> "forrester-2004-laser.bib"):
 * lowercased, hyphenated at letter/digit boundaries and before internal
 * capitals, with anything outside [a-z0-9-] stripped. The citation key
 * itself is already a safe, ASCII-only identifier (see the backend's
 * app/core/citation_key.py) — this only reshapes it into a
 * conventional-looking filename, never introduces new characters that
 * weren't already safe.
 */
export function safeBibtexFilename(citationKey: string, fallback = 'reference'): string {
  const base = citationKey || fallback;
  const hyphenated = base
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .replace(/(\d)([a-zA-Z])/g, '$1-$2')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${hyphenated || fallback}.bib`;
}
