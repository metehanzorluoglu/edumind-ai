import { useEffect, useState } from 'react';
import { Image, Platform, type ImageStyle, type StyleProp } from 'react-native';
import { useClient } from '@/lib/ClientProvider';

export type AttachmentImageLoadStatus = 'loading' | 'loaded' | 'error';

export interface AuthenticatedAttachmentImageProps {
  conversationId: string;
  messageId: string;
  attachmentId: string;
  /** Renders this page of a PDF attachment instead of its raw bytes (milestone V4 — see EducationAssistantClient.buildAttachmentUrl's `page` param). Omit entirely for a plain image attachment. */
  page?: number;
  style?: StyleProp<ImageStyle>;
  resizeMode?: 'cover' | 'contain';
  /** Optional load-status reporting for overlays (AttachmentLightbox shows
   * a spinner / "couldn't load" + retry — without this prop the component
   * keeps its original silent-placeholder behavior). Pass a STABLE callback
   * (e.g. a useState setter): it's an effect dependency. */
  onStatusChange?: (status: AttachmentImageLoadStatus) => void;
}

/**
 * Renders an already-persisted image attachment's real thumbnail
 * (milestone V3 — the "images survive a refresh" requirement needs this,
 * not just metadata: GET .../attachments/{id} requires a Bearer token,
 * which neither a plain web `<img src>` nor `<Image source={{uri}}>`
 * alone can attach).
 *
 * Web: a browser `<img>` tag cannot send custom headers at all, so this
 * fetches the bytes with the token attached
 * (EducationAssistantClient.fetchAttachmentBlob) and points the image at
 * an object URL built from the resulting Blob, revoked on unmount/prop
 * change to avoid leaking memory.
 *
 * Native (iOS/Android): React Native's `<Image>` fetches the URI itself
 * and — unlike a web `<img>` — supports a `headers` field on its
 * `source`, so this just resolves the URL + Authorization header
 * (EducationAssistantClient.getAttachmentImageSource) and lets `<Image>`
 * do the actual network fetch; no pre-fetched Blob is involved on this
 * platform.
 *
 * Renders nothing (a transparent placeholder) while loading or if the
 * fetch fails — the caller (AttachmentChip) already shows a filename/size
 * chip alongside this, so a missing thumbnail never leaves the user with
 * no information about the attachment at all.
 */
export function AuthenticatedAttachmentImage({
  conversationId,
  messageId,
  attachmentId,
  page,
  style,
  resizeMode = 'cover',
  onStatusChange,
}: AuthenticatedAttachmentImageProps) {
  const { client } = useClient();
  const [webObjectUrl, setWebObjectUrl] = useState<string | null>(null);
  const [nativeSource, setNativeSource] = useState<{
    uri: string;
    headers: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    onStatusChange?.('loading');

    if (Platform.OS === 'web') {
      client
        .fetchAttachmentBlob(conversationId, messageId, attachmentId, { page })
        .then((blob) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setWebObjectUrl(objectUrl);
          onStatusChange?.('loaded');
        })
        .catch(() => {
          // Silently falls back to no thumbnail — see this component's
          // own docs on why (AttachmentChip already shows filename/size).
          // Callers that passed onStatusChange (the lightbox) get the
          // failure so they can show it instead of a blank area.
          if (!cancelled) onStatusChange?.('error');
        });
    } else {
      client
        .getAttachmentImageSource(conversationId, messageId, attachmentId, page)
        .then((source) => {
          if (cancelled) return;
          setNativeSource(source);
          onStatusChange?.('loaded');
        })
        .catch(() => {
          if (!cancelled) onStatusChange?.('error');
        });
    }

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, conversationId, messageId, attachmentId, page, onStatusChange]);

  // Decode failure after a successful fetch is rare (corrupt bytes), but
  // must not leave an overlay stuck on its loading spinner.
  function handleImageError(): void {
    onStatusChange?.('error');
  }

  if (Platform.OS === 'web') {
    if (!webObjectUrl) return null;
    return (
      <Image
        source={{ uri: webObjectUrl }}
        style={style}
        resizeMode={resizeMode}
        onError={handleImageError}
      />
    );
  }

  if (!nativeSource) return null;
  return (
    <Image
      source={{ uri: nativeSource.uri, headers: nativeSource.headers }}
      style={style}
      resizeMode={resizeMode}
      onError={handleImageError}
    />
  );
}
