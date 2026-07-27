import type { EducationAssistantClient } from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { formatFileSize } from './documentUpload';

/**
 * Reference-image support for the Image Generator (see ImageGenerationModal).
 * A reference image is an *input* the user attaches alongside the text prompt
 * ("put this Finch robot in the scene" / "turn this person into a wedding
 * portrait, preserving identity"). References are inlined into the generate
 * request as base64 data URLs (the body stays plain JSON — same contract as
 * the rest of GenerateImagesRequest), persisted server-side as
 * `source="reference"` attachments on the generated message, and refetched on
 * Regenerate so the modal can prefill them.
 *
 * There is no pre-existing base64 path in this app (chat attachments upload
 * multipart and never read base64), so the read helpers below are new. Web
 * reads the picker's File via FileReader; native reads the picked file via
 * expo-file-system's modern File API (`File.base64()` — the legacy
 * readAsStringAsync re-exported at the package root is a throw-stub in SDK 54,
 * so it must not be used). The web path is the live-verified target.
 */

export const MAX_REFERENCE_IMAGES = 4;
export const REFERENCE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Mirrors the backend's per-reference decoded-byte cap (schemas/images.py). */
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

export type ReferenceImageMimeType = (typeof REFERENCE_IMAGE_MIME_TYPES)[number];

/**
 * One reference image as held by the modal. A freshly picked image has a local
 * `previewUri` (for the thumbnail) plus a `dataUrl` once its bytes have been
 * encoded; a Regenerate-prefilled image starts as a `remote` pointer that the
 * modal resolves (fetch → previewUri + dataUrl) before it can be sent.
 */
export interface ReferenceImageRef {
  id: string;
  name: string;
  mimeType: ReferenceImageMimeType;
  /** Local `blob:`/`file://` URI for the thumbnail — null while a remote ref is still being fetched. */
  previewUri: string | null;
  /** `data:<mime>;base64,…` ready to send — null while encoding/fetching. */
  dataUrl: string | null;
  /** Present only for a Regenerate-prefilled reference, until the modal resolves it. */
  remote?: { conversationId: string; messageId: string; attachmentId: string };
  loading: boolean;
  error: string | null;
}

/** A picked image asset, structurally — what the modal hands the read helper. */
export interface ReferencePickerAsset {
  uri: string;
  mimeType?: string | null;
  /** The picker's File on web (expo-image-picker exposes it there); absent on native. */
  file?: File | Blob | null;
}

export function isReferenceMimeType(
  value: string | null | undefined
): value is ReferenceImageMimeType {
  return !!value && (REFERENCE_IMAGE_MIME_TYPES as readonly string[]).includes(value.toLowerCase());
}

/** Readable rejection reason, or null when the candidate passes the checks this
 * app can run before sending (mirrors validateCandidateAttachment's style). */
export function validateReferenceCandidate(
  name: string,
  sizeBytes: number | null,
  mimeType: string | null
): string | null {
  if (!isReferenceMimeType(mimeType)) {
    return `"${name}" isn't a supported reference image type. Use PNG, JPEG, or WEBP.`;
  }
  if (sizeBytes !== null) {
    if (sizeBytes === 0) {
      return `"${name}" is empty (0 bytes) and can't be used as a reference.`;
    }
    if (sizeBytes > MAX_REFERENCE_IMAGE_BYTES) {
      return `"${name}" is ${formatFileSize(sizeBytes)}, over the ${formatFileSize(MAX_REFERENCE_IMAGE_BYTES)} reference limit.`;
    }
  }
  return null;
}

/** Rebuild a data URL's header so its embedded mime exactly matches `mime` —
 * the backend rejects a reference whose data-URL header disagrees with its
 * `mime` field, so we never forward a picker-reported type that diverges. */
function withMime(dataUrl: string, mime: string): string {
  const marker = ';base64,';
  const at = dataUrl.indexOf(marker);
  if (at === -1) return dataUrl;
  return `data:${mime}${marker}${dataUrl.slice(at + marker.length)}`;
}

/** Web Blob/File → `data:<mime>;base64,…`. */
export function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Could not read the image bytes.'));
        return;
      }
      resolve(withMime(result, mime));
    };
    reader.onerror = () => reject(new Error('Could not read the image bytes.'));
    reader.readAsDataURL(blob);
  });
}

/** Read a picked asset into a `data:<mime>;base64,…` string, embedding the
 * caller-validated `mime` so the data-URL header can never disagree with it. */
export async function readPickerAssetAsDataUrl(
  asset: ReferencePickerAsset,
  mime: ReferenceImageMimeType
): Promise<string> {
  if (Platform.OS === 'web') {
    const blob: Blob =
      asset.file instanceof Blob ? asset.file : await (await fetch(asset.uri)).blob();
    return blobToDataUrl(blob, mime);
  }
  const base64 = await new ExpoFile(asset.uri).base64();
  return `data:${mime};base64,${base64}`;
}

/** Resolve a Regenerate-prefilled reference (a persisted attachment pointer)
 * into a thumbnail `previewUri` + a sendable `dataUrl`, reusing the same
 * authenticated content endpoint AuthenticatedAttachmentImage uses. On web the
 * fetched Blob becomes both an object-URL preview and a data URL; on native the
 * bytes are written to a cache file (so the thumbnail has a real URI) and read
 * back as base64 via the modern File API. */
export async function resolveRemoteReference(
  client: EducationAssistantClient,
  remote: { conversationId: string; messageId: string; attachmentId: string },
  mime: ReferenceImageMimeType,
  name: string
): Promise<{ previewUri: string; dataUrl: string }> {
  const blob = await client.fetchAttachmentBlob(
    remote.conversationId,
    remote.messageId,
    remote.attachmentId
  );
  if (Platform.OS === 'web') {
    const previewUri = URL.createObjectURL(blob);
    const dataUrl = await blobToDataUrl(blob, mime);
    return { previewUri, dataUrl };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, `reference-${remote.attachmentId}-${name}`);
  file.create({ overwrite: true });
  file.write(bytes);
  const base64 = await file.base64();
  return { previewUri: file.uri, dataUrl: `data:${mime};base64,${base64}` };
}
