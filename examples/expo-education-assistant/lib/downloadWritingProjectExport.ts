import type { EducationAssistantClient } from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Milestone 5 (Academic Writing & LaTeX Foundation) Part 23/24 — "Export
 * LaTeX Project": downloads the portable ZIP (main.tex + references.bib)
 * produced by GET /writing-projects/{id}/export. Same web/native split as
 * lib/downloadAttachment.ts (this is server-fetched bytes, not an
 * in-memory string — see downloadTextFile.ts for that case).
 */
export async function downloadWritingProjectExport(
  client: EducationAssistantClient,
  projectId: string,
  filename: string
): Promise<void> {
  const blob = await client.fetchWritingProjectExportBlob(projectId);

  if (Platform.OS === 'web') {
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
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/zip' });
}

/** A safe, deterministic ZIP filename from a project title (e.g. "My
 * Paper!" -> "my-paper.zip") — same hyphenation convention as
 * safeBibtexFilename (downloadTextFile.ts). */
export function safeWritingProjectExportFilename(title: string, fallback = 'writing-project'): string {
  const hyphenated = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${hyphenated || fallback}.zip`;
}
