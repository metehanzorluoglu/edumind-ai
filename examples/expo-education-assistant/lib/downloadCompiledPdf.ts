import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * Milestone 5.1 Part 37 — "Download PDF": saves/shares an already-fetched
 * compiled-PDF Blob (see useWritingProject's fetchCompiledPdf). Same
 * web/native split as lib/downloadWritingProjectExport.ts — this module
 * takes the Blob directly (the caller already has it in memory for the
 * preview panel) rather than re-fetching, and always revokes its own
 * object URL on web (Part 37: "Revoke Blob URLs on web").
 */
export async function downloadCompiledPdf(pdfBlob: Blob, filename: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(pdfBlob);
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
  const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf' });
}

/** A safe, UTF-safe, deterministic PDF filename from a project title —
 * same hyphenation convention as safeWritingProjectExportFilename. */
export function safeCompiledPdfFilename(title: string, fallback = 'manuscript'): string {
  const hyphenated = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${hyphenated || fallback}.pdf`;
}
