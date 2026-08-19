import type { EducationAssistantClient, WritingProjectFileNode } from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { blobToDataUrl } from '@/lib/referenceImages';
import { useTheme, type Theme } from '@/lib/Preferences';
import { CompiledPdfPreview } from './CompiledPdfPreview';

async function resolvePreviewUri(blob: Blob, mime: string, cacheName: string): Promise<string> {
  if (Platform.OS === 'web') {
    return blobToDataUrl(blob, mime);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, cacheName);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

/**
 * Milestone 5.3 Part 21, extended by the 5.5.3 continuation's "Project
 * PDF asset support" — a project-file preview/details pane for a
 * binary project file (PNG/JPEG/PDF): a real inline preview for images
 * (reusing lib/referenceImages.ts's exact web-data-URL/native-cache-
 * file pattern), and for a PDF asset (a real project document — e.g.
 * "user-manual.pdf" or "sn-article.pdf" shipped inside an imported
 * template, never EduM8's own COMPILED output) a real view/zoom/fit-
 * width/scroll experience via CompiledPdfPreview — reused, not
 * reimplemented (per this milestone's own "do not create another PDF
 * renderer" requirement; CompiledPdfPreview's actual implementation is
 * already fully generic over any PDF Blob, it just also happens to be
 * where the compiled-manuscript preview lives). This component never
 * confuses the two: `stale` is always `false` here (that banner only
 * ever makes sense for a compile result), and this pane's own state is
 * entirely local to whichever project FILE is currently selected —
 * nothing here is shared with the actual Preview pane's own compiled-
 * PDF state. Never ingested into the RAG/Document Library pipeline —
 * writing-project files were never part of that to begin with (see
 * models_writing.py's own TEXT_FILE_EXTENSIONS docstring).
 */
export function WritingAssetPreview({
  client,
  projectId,
  node,
}: {
  client: EducationAssistantClient;
  projectId: string;
  node: WritingProjectFileNode;
}) {
  const theme = useTheme();
  const styles = useMemo(() => buildStyles(theme), [theme]);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const isImage = node.mime_type === 'image/png' || node.mime_type === 'image/jpeg';
  // Milestone 5.5.4 — BINARY_FILE_EXTENSIONS grew a third kind (`.eps`,
  // `application/postscript`) that is neither an image nor a real PDF.
  // The pre-M5.5.4 code here assumed "not an image" meant "must be a
  // PDF" (true when PNG/JPEG/PDF were the only three), which would have
  // fed raw EPS bytes into the PDF.js-based CompiledPdfPreview and
  // failed to render — real academic templates ship `.eps` figures
  // (the Springer Nature fixture's own `fig.eps`/`empty.eps`), so this
  // is a real, reachable case now, not a hypothetical.
  const isPdf = node.mime_type === 'application/pdf';

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setPreviewUri(null);
    client
      .fetchWritingProjectFileBinaryBlob(projectId, node.id)
      .then(async (fetchedBlob) => {
        if (cancelled) return;
        setBlob(fetchedBlob);
        if (isImage) {
          const uri = await resolvePreviewUri(
            fetchedBlob,
            node.mime_type ?? 'image/png',
            node.name
          );
          if (cancelled) return;
          setPreviewUri(uri);
        }
        setStatus('success');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load this asset.');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, projectId, node.id, node.mime_type, node.name, isImage]);

  async function handleDownload(): Promise<void> {
    if (!blob || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(blob);
        try {
          const link = document.createElement('a');
          link.href = url;
          link.download = node.name;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } finally {
          URL.revokeObjectURL(url);
        }
      } else {
        const Sharing = await import('expo-sharing');
        const isAvailable = await Sharing.isAvailableAsync();
        if (!isAvailable) throw new Error('Sharing/saving files is not available on this device.');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const file = new ExpoFile(Paths.cache, node.name);
        file.create({ overwrite: true });
        file.write(bytes);
        await Sharing.shareAsync(file.uri, {
          mimeType: node.mime_type ?? 'application/octet-stream',
        });
      }
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Could not download this asset.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {node.name}
        </Text>
        <Text style={styles.meta}>
          {node.mime_type ?? 'binary'} · {(node.size_bytes / 1024).toFixed(1)} KB · {node.path}
        </Text>
      </View>

      {status === 'loading' && <ActivityIndicator color={theme.accent} style={styles.spinner} />}
      {status === 'error' && error && <Notice tone="danger" body={error} />}
      {status === 'success' && isImage && previewUri && (
        <Image source={{ uri: previewUri }} style={styles.image} resizeMode="contain" />
      )}
      {status === 'success' && isPdf && (
        <View style={styles.pdfViewerArea}>
          <CompiledPdfPreview
            pdfBlob={blob}
            loading={false}
            error={null}
            stale={false}
            emptyMessage="No preview available."
          />
        </View>
      )}
      {/* Milestone 5.5.4 — a binary asset that's neither an image nor a
          PDF (currently: `.eps`). No fake preview — an honest "download
          to view" state, never a PDF viewer silently fed non-PDF bytes. */}
      {status === 'success' && !isImage && !isPdf && (
        <Notice
          tone="neutral"
          body="No inline preview is available for this file type. Use Download below to view it in another application."
        />
      )}

      {downloadError && <Notice tone="danger" body={downloadError} />}
      <Button
        label={downloading ? 'Downloading…' : 'Download'}
        variant="secondary"
        size="sm"
        loading={downloading}
        disabled={status !== 'success'}
        onPress={() => void handleDownload()}
        style={styles.downloadButton}
      />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, minHeight: 0, padding: 20, gap: 10 },
    header: { gap: 4 },
    name: { fontSize: 14, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    meta: { fontSize: 11.5, fontFamily: theme.fonts.mono, color: theme.faint },
    spinner: { marginTop: 24 },
    image: {
      width: '100%',
      height: 280,
      borderRadius: theme.radius.md,
      backgroundColor: theme.cardPressed,
    },
    pdfViewerArea: {
      flex: 1,
      minHeight: 0,
      borderRadius: theme.radius.md,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    downloadButton: { alignSelf: 'flex-start' },
  });
}
