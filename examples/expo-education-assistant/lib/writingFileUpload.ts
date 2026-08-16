import type { UploadableFile } from 'education-assistant-client';
import * as DocumentPicker from 'expo-document-picker';
import { Platform } from 'react-native';

/**
 * Milestone 5.3 (LaTeX Project Workspace & File Management) Part 10/11 —
 * converts a picked DocumentPicker asset into the shape the SDK's
 * uploadWritingProjectFile() needs. A small, self-contained adaptation of
 * the exact same web-vs-native split
 * app/(tabs)/documents/index.tsx's buildUploadableFileFromPickerAsset
 * already uses (see that function's own docstring for the full "why" —
 * web needs a real Blob/File, native needs the `{ uri, name, type }`
 * shape React Native's FormData polyfill understands) — duplicated here
 * rather than imported so this milestone never has to modify the
 * Documents screen to share it.
 */
export async function buildUploadableFileFromPickerAsset(
  asset: DocumentPicker.DocumentPickerAsset
): Promise<UploadableFile> {
  if (Platform.OS === 'web') {
    if (asset.file instanceof File) {
      return asset.file;
    }
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    return new File([blob], asset.name, { type: asset.mimeType || blob.type });
  }
  return { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' };
}

/** Part 10 — every extension this milestone allows a project file
 * upload to have (mirrors the backend's own TEXT_FILE_EXTENSIONS |
 * BINARY_FILE_EXTENSIONS in app/db/models_writing.py). Passed to
 * DocumentPicker so the native/web file picker itself only offers
 * matching files where the platform supports filtering — the backend
 * still independently re-validates every byte regardless (Part 11).
 */
export const WRITING_PROJECT_UPLOAD_MIME_TYPES = [
  'text/x-tex',
  'text/plain',
  'application/x-tex',
  'image/png',
  'image/jpeg',
  'application/pdf',
  '*/*',
];
