import type { EducationAssistantClient, WritingProjectFileNode } from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { blobToDataUrl } from '@/lib/referenceImages';
import { useTheme, type Theme } from '@/lib/Preferences';

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
 * Milestone 5.3 Part 21 — a small, deliberately minimal asset
 * preview/details pane for a binary project file (PNG/JPEG/PDF): shows
 * a real inline preview for images (reusing lib/referenceImages.ts's
 * exact web-data-URL/native-cache-file pattern — Part 21 explicitly
 * scopes this to "basic," not image annotation), and for a PDF asset
 * shows its metadata plus a "Download" action rather than a full second
 * PDF-page renderer (CompiledPdfPreview already owns that machinery for
 * the COMPILED manuscript specifically; duplicating it here for an
 * uploaded source figure would be overbuilding a feature this
 * milestone's own spec marks optional).
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
          const uri = await resolvePreviewUri(fetchedBlob, node.mime_type ?? 'image/png', node.name);
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
        await Sharing.shareAsync(file.uri, { mimeType: node.mime_type ?? 'application/octet-stream' });
      }
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Could not download this asset.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.name} numberOfLines={1}>
        {node.name}
      </Text>
      <Text style={styles.meta}>
        {node.mime_type ?? 'binary'} · {(node.size_bytes / 1024).toFixed(1)} KB · {node.path}
      </Text>

      {status === 'loading' && <ActivityIndicator color={theme.accent} style={styles.spinner} />}
      {status === 'error' && error && <Notice tone="danger" body={error} />}
      {status === 'success' && isImage && previewUri && (
        <Image source={{ uri: previewUri }} style={styles.image} resizeMode="contain" />
      )}
      {status === 'success' && !isImage && (
        <View style={styles.pdfPlaceholder}>
          <Text style={styles.pdfPlaceholderText}>PDF asset — no inline preview.</Text>
        </View>
      )}

      {downloadError && <Notice tone="danger" body={downloadError} />}
      <Button
        label={downloading ? 'Downloading…' : 'Download'}
        variant="secondary"
        size="sm"
        loading={downloading}
        disabled={status !== 'success'}
        onPress={() => void handleDownload()}
      />
    </View>
  );
}

function buildStyles(theme: Theme) {
  return StyleSheet.create({
    container: { flex: 1, padding: 20, gap: 10 },
    name: { fontSize: 14, fontFamily: theme.fonts.bodySemibold, color: theme.text },
    meta: { fontSize: 11.5, fontFamily: theme.fonts.mono, color: theme.faint },
    spinner: { marginTop: 24 },
    image: { width: '100%', height: 280, borderRadius: theme.radius.md, backgroundColor: theme.cardPressed },
    pdfPlaceholder: {
      height: 160,
      borderRadius: theme.radius.md,
      backgroundColor: theme.cardPressed,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pdfPlaceholderText: { fontSize: 12.5, fontFamily: theme.fonts.body, color: theme.faint },
  });
}
