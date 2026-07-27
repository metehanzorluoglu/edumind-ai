import type { components } from './generated';

/**
 * POST /images/generate's request body — wire shape stays snake_case,
 * matching this SDK's PostConversationMessageRequest convention (see
 * types/conversations.ts). Unlike a chat attachment, an image-generation
 * request is plain JSON (no file upload involved), so this is a direct
 * alias of the generated schema rather than a hand-written type.
 */
export type GenerateImagesRequest = components['schemas']['GenerateImagesRequest'];

/**
 * One generated image, once persisted — the exact same shape as any other
 * persisted chat attachment (see types/conversations.ts's
 * ConversationMessageAttachment), distinguished only by `source ===
 * "generated"` and the `generation_*` fields it carries. Its bytes are
 * fetched the same way too (EducationAssistantClient.fetchAttachmentBlob/
 * getAttachmentImageSource against the message it was persisted onto).
 */
export type GeneratedImageAttachment = components['schemas']['MessageAttachmentResponse'];

export type SaveAttachmentToProjectRequest =
  components['schemas']['SaveAttachmentToProjectRequest'];

/**
 * POST /images/generate streams these as Server-Sent Events rather than
 * returning a single JSON body (see rag-backend's
 * app/api/routes_images.py's stream_generate_images) — generating even one
 * image commonly takes tens of seconds, and a batch of several is
 * generated strictly sequentially, so a plain buffered response would
 * give the caller no way to show real per-image progress or to cancel
 * partway through. Hand-written, not codegen'd: FastAPI/OpenAPI cannot
 * describe a text/event-stream response body, exactly the same
 * documented gap as types/chat.ts's ChatEvent (see that file's own
 * scripts/generate-api-types.ts reminder).
 */
export interface ImageGenerationProgressEvent {
  type: 'progress';
  /** 1-indexed, monotonically increasing — the number of images *completed* so far, never a faked fraction for a single image (see ImageGenerationModal.tsx). */
  completed: number;
  total: number;
}

export interface ImageGenerationDoneEvent {
  type: 'done';
  message_id: string;
  conversation_id: string;
  images: GeneratedImageAttachment[];
}

export interface ImageGenerationErrorEvent {
  type: 'error';
  message: string;
}

export type ImageGenerationEvent =
  | ImageGenerationProgressEvent
  | ImageGenerationDoneEvent
  | ImageGenerationErrorEvent;

/**
 * generateImages()'s buffered return shape — the `done` event's own
 * fields, minus its `type` discriminant. Hand-written for the same reason
 * as the events above: the backend endpoint no longer has a declared
 * `response_model` (it streams SSE — see stream_generate_images), so
 * nothing under this name exists in generated.ts's components.schemas
 * anymore.
 */
export interface GenerateImagesResponse {
  message_id: string;
  conversation_id: string;
  images: GeneratedImageAttachment[];
}
