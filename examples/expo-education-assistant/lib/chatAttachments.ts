import type {
  ConversationMessageAttachment,
  EducationAssistantClient,
  UploadableFile,
} from 'education-assistant-client';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { formatFileSize } from './documentUpload';

/**
 * Mirrors the backend's supported chat-attachment mime types (milestone V2 —
 * see rag-backend's app/services/attachment_storage.py). HEIC is
 * deliberately excluded here even though the backend can optionally accept
 * it (CHAT_ATTACHMENT_ALLOW_HEIC): it is off by default server-side, and a
 * rejected upload there already surfaces a clear error — this list only
 * needs to catch the common "picked something totally unsupported" case
 * before ever making a request.
 */
export const ACCEPTED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

const ACCEPTED_ATTACHMENT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];

/**
 * Frontend-only guard, same reasoning as documentUpload.ts's
 * MAX_UPLOAD_FILE_SIZE_BYTES: mirrors the backend's default
 * CHAT_ATTACHMENT_MAX_BYTES (rag-backend/.env.example) purely to reject an
 * obviously-doomed attachment before spending a multipart upload on it —
 * the backend's real configured limit (which an operator may have changed)
 * is always the authoritative check.
 */
export const MAX_ATTACHMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Mirrors the backend's default CHAT_ATTACHMENT_MAX_FILES_PER_MESSAGE. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

function hasAcceptedAttachmentType(name: string, mimeType: string | null): boolean {
  if (mimeType) {
    return (ACCEPTED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
  }
  const lower = name.toLowerCase();
  return ACCEPTED_ATTACHMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isPdfAttachment(name: string, mimeType: string | null): boolean {
  if (mimeType) return mimeType.toLowerCase() === 'application/pdf';
  return name.toLowerCase().endsWith('.pdf');
}

/** Returns a readable rejection reason, or null if the candidate passes every check this app can run before actually sending. Mirrors documentUpload.ts's validateCandidateFile — kept as a separate function since the accepted types/size limit are a different (and independently configured) surface on the backend. */
export function validateCandidateAttachment(
  name: string,
  sizeBytes: number | null,
  mimeType: string | null
): string | null {
  if (!hasAcceptedAttachmentType(name, mimeType)) {
    return `"${name}" is not a supported attachment type. Supported: PNG, JPEG, WEBP, PDF.`;
  }
  if (sizeBytes !== null) {
    if (sizeBytes === 0) {
      return `"${name}" is empty (0 bytes) and can't be attached.`;
    }
    if (sizeBytes > MAX_ATTACHMENT_FILE_SIZE_BYTES) {
      return `"${name}" is ${formatFileSize(sizeBytes)}, which is over the ${formatFileSize(MAX_ATTACHMENT_FILE_SIZE_BYTES)} limit.`;
    }
  }
  return null;
}

/**
 * One file the user has attached but not yet sent — held entirely in local
 * component state until the composer's Ask/Send actually fires (see
 * PREVIEW requirements: thumbnail, filename, filesize, remove — all
 * handled locally here, no backend call happens until send).
 *
 * There is no page-range field: a PDF is always analyzed in full,
 * automatically — the user never chooses pages here. A short PDF is sent
 * to the vision model in one call; a longer one is analyzed in
 * sequential batches with live progress instead of being truncated (see
 * rag-backend's app/services/vision_batch_orchestrator.py and
 * DisplayMessage.progressDetail) — there is no page count the app
 * refuses to fully analyze. The user describes what they want in the
 * chat message itself (e.g. "summarize this PDF", "explain the chart on
 * page 3").
 */
export interface PendingAttachment {
  localId: string;
  file: UploadableFile;
  name: string;
  size: number | null;
  mimeType: string | null;
  isPdf: boolean;
  /** A local `blob:`/`data:`/`file://` URI usable directly as an <Image> source for an image attachment's thumbnail — null for a PDF (no thumbnail rendering here; see module docs on why this app doesn't parse PDF bytes itself) or when the source didn't provide one. Never sent to the backend. */
  previewUri: string | null;
  /** A local validation failure (unsupported type / oversized) — the attachment still appears in the preview list (so Remove is available) but sending is blocked while any attachment has one. */
  error: string | null;
}

let nextLocalAttachmentId = 0;
function generateLocalAttachmentId(): string {
  nextLocalAttachmentId += 1;
  return `pending-attachment-${nextLocalAttachmentId}`;
}

/**
 * Converts a picked/dropped/pasted file into a PendingAttachment. Mirrors
 * documents.tsx's buildUploadableFileFromPickerAsset (same web File-vs-RN-
 * uri-object split — see that function's docs for the full reasoning) but
 * takes plain fields rather than a picker-specific asset type, since this
 * is shared by expo-image-picker, expo-document-picker, web drag-and-drop,
 * and web paste, each of which reports a picked file slightly differently.
 */
export async function createPendingAttachment(params: {
  uri: string;
  name: string;
  size: number | null;
  mimeType: string | null;
  /** Present when the source already handed us a real web File (picker-on-web, drag-and-drop, or paste) — avoids a redundant fetch(uri)+blob() round trip. */
  webFile?: File | null;
}): Promise<PendingAttachment> {
  const mimeType = params.mimeType ?? params.webFile?.type ?? null;
  let file: UploadableFile;
  if (Platform.OS === 'web') {
    if (params.webFile instanceof File) {
      file = params.webFile;
    } else {
      const response = await fetch(params.uri);
      const blob = await response.blob();
      file = new File([blob], params.name, { type: mimeType || blob.type });
    }
  } else {
    file = { uri: params.uri, name: params.name, type: mimeType ?? 'application/octet-stream' };
  }

  return {
    localId: generateLocalAttachmentId(),
    file,
    name: params.name,
    size: params.size,
    mimeType,
    isPdf: isPdfAttachment(params.name, mimeType),
    previewUri: mimeType?.startsWith('image/') ? params.uri : null,
    error: validateCandidateAttachment(params.name, params.size, mimeType),
  };
}

/**
 * Converts this screen's local pending-attachment state into what
 * EducationAssistantClient.streamConversationMessage()/
 * postConversationMessage() actually accept. Never sets `pageRange` — the
 * UI has no page-selection controls (a PDF is always analyzed in full,
 * automatically; see PendingAttachment's docs) — but the field stays
 * supported on the wire (MessageAttachmentUpload.pageRange is optional)
 * for API backward compatibility with any other caller that still sets it.
 */
export function toAttachmentUploads(attachments: PendingAttachment[]): { file: UploadableFile }[] {
  return attachments.map((attachment) => ({ file: attachment.file }));
}

/** Unifies a not-yet-sent PendingAttachment and an already-persisted ConversationMessageAttachment into one shape ConversationTurnCard can render without a branch per origin — same reasoning as types/conversations.ts's DisplaySource. */
export interface AttachmentChipInfo {
  key: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** null until the backend has actually validated the file (PDFs only) — see PendingAttachment's docs on why this app can't know it any earlier. */
  pageCount: number | null;
  pageRangeStart: number | null;
  pageRangeEnd: number | null;
  /**
   * Present only for an already-persisted attachment (milestone V3) —
   * lets AttachmentChip fetch and render a real thumbnail via
   * AuthenticatedAttachmentImage (the backend never exposes a
   * filesystem path, only this content-serving endpoint, which requires
   * the caller's own auth token — see
   * EducationAssistantClient.fetchAttachmentBlob/
   * getAttachmentImageSource). Absent for a not-yet-sent
   * PendingAttachment, which already has a local `previewUri` instead.
   */
  remote: { conversationId: string; messageId: string } | null;
}

export function attachmentChipFromPending(attachment: PendingAttachment): AttachmentChipInfo {
  return {
    key: attachment.localId,
    filename: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    pageCount: null,
    pageRangeStart: null,
    pageRangeEnd: null,
    remote: null,
  };
}

/**
 * Turns an already-persisted attachment (in practice, always a generated
 * image — see GeneratedImageGallery.tsx's "Use as attachment") into a
 * PendingAttachment ready to be staged in the composer, so it can be sent
 * again as a fresh attachment on a later message. Fetches the real bytes
 * through the same authenticated endpoint AuthenticatedAttachmentImage uses
 * (EducationAssistantClient.fetchAttachmentBlob) — plain `fetch()`, works
 * identically on web and native, unlike getAttachmentImageSource (which
 * only suits an <Image> source). Native writes the fetched bytes to a real
 * cache file via expo-file-system's File API (mirrors
 * sampleDocument.ts's buildSampleUploadFile) since a PendingAttachment's
 * `file` field on native must be a real `{uri, name, type}` the later
 * multipart upload can stream from disk — a remote URL requiring an auth
 * header cannot be used directly there. Web keeps the fetched Blob/File
 * in memory instead, exactly like a freshly picked file.
 */
export async function createPendingAttachmentFromRemote(
  client: EducationAssistantClient,
  location: { conversationId: string; messageId: string },
  attachment: ConversationMessageAttachment
): Promise<PendingAttachment> {
  const blob = await client.fetchAttachmentBlob(
    location.conversationId,
    location.messageId,
    attachment.id
  );

  if (Platform.OS === 'web') {
    const file = new File([blob], attachment.filename, { type: attachment.mime });
    return createPendingAttachment({
      uri: URL.createObjectURL(blob),
      name: attachment.filename,
      size: attachment.size_bytes,
      mimeType: attachment.mime,
      webFile: file,
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const file = new ExpoFile(Paths.cache, `${attachment.id}-${attachment.filename}`);
  file.create({ overwrite: true });
  file.write(bytes);
  return createPendingAttachment({
    uri: file.uri,
    name: attachment.filename,
    size: attachment.size_bytes,
    mimeType: attachment.mime,
  });
}

export function attachmentChipFromPersisted(
  attachment: ConversationMessageAttachment,
  location: { conversationId: string; messageId: string }
): AttachmentChipInfo {
  return {
    key: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mime,
    sizeBytes: attachment.size_bytes,
    pageCount: attachment.page_count ?? null,
    pageRangeStart: attachment.page_range_start ?? null,
    pageRangeEnd: attachment.page_range_end ?? null,
    remote: location,
  };
}
