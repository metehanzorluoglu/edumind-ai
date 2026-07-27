/**
 * Typed error hierarchy for the SDK. Every error extends EducationAssistantError
 * so `catch (e) { if (e instanceof EducationAssistantError) ... }` works as a
 * single catch-all, while more specific subclasses let callers branch on
 * exactly what went wrong (auth vs. validation vs. network, etc.).
 *
 * requestId is captured from a response header where the backend provides
 * one (checked: `x-request-id`, `x-correlation-id`). As of this SDK version
 * the rag-backend does not send either header on any response, so requestId
 * will be `null` in practice today — the capability exists for when/if the
 * backend adds one, per "capture where available." Never fabricated.
 */

export interface EducationAssistantErrorOptions {
  requestId?: string | null;
  statusCode?: number | null;
  cause?: unknown;
}

export class EducationAssistantError extends Error {
  readonly requestId: string | null;
  readonly statusCode: number | null;

  constructor(message: string, options: EducationAssistantErrorOptions = {}) {
    super(message);
    // Deliberately never `this.name = ...` here: that would create an own
    // instance property that permanently shadows whatever a subclass's
    // defineErrorName call sets on its own prototype (own properties win
    // over inherited ones), so every subclass's error would incorrectly
    // report "EducationAssistantError" regardless of which one it actually
    // was. Every class in this hierarchy, base included, gets its `name`
    // exclusively via defineErrorName below.
    this.requestId = options.requestId ?? null;
    this.statusCode = options.statusCode ?? null;
    if (options.cause !== undefined) {
      // Node/RN both support the standard `cause` property on Error since
      // ES2022; setting it explicitly keeps this working even in engines
      // where the Error constructor's `cause` option isn't honored.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function defineErrorName(ctor: new (...args: never[]) => Error, name: string): void {
  Object.defineProperty(ctor.prototype, 'name', { value: name, configurable: true });
}

defineErrorName(EducationAssistantError, 'EducationAssistantError');

/** HTTP 401 — missing or invalid API key. */
export class AuthenticationError extends EducationAssistantError {}
defineErrorName(AuthenticationError, 'AuthenticationError');

/** HTTP 403 — authenticated but not permitted. */
export class AuthorizationError extends EducationAssistantError {}
defineErrorName(AuthorizationError, 'AuthorizationError');

/** HTTP 422 — request failed backend validation (e.g. Pydantic). */
export class ValidationError extends EducationAssistantError {
  readonly details: unknown;

  constructor(
    message: string,
    options: EducationAssistantErrorOptions & { details?: unknown } = {}
  ) {
    super(message, options);
    this.details = options.details ?? null;
  }
}
defineErrorName(ValidationError, 'ValidationError');

/** HTTP 429 — rate limited. */
export class RateLimitError extends EducationAssistantError {}
defineErrorName(RateLimitError, 'RateLimitError');

/** HTTP 409 — e.g. duplicate document upload. */
export class ConflictError extends EducationAssistantError {}
defineErrorName(ConflictError, 'ConflictError');

/** HTTP 404. */
export class NotFoundError extends EducationAssistantError {}
defineErrorName(NotFoundError, 'NotFoundError');

/** HTTP 502 — Ollama/embedding/LLM provider unreachable or failing. */
export class ProviderUnavailableError extends EducationAssistantError {}
defineErrorName(ProviderUnavailableError, 'ProviderUnavailableError');

/** HTTP 500 or any other backend error status not covered above. */
export class BackendError extends EducationAssistantError {}
defineErrorName(BackendError, 'BackendError');

/** fetch() itself threw — DNS failure, connection refused, offline, etc. */
export class NetworkError extends EducationAssistantError {}
defineErrorName(NetworkError, 'NetworkError');

/** Request exceeded the configured timeoutMs. */
export class TimeoutError extends EducationAssistantError {}
defineErrorName(TimeoutError, 'TimeoutError');

/** Request was cancelled via an AbortSignal/cancel() — not a failure. */
export class RequestCancelledError extends EducationAssistantError {}
defineErrorName(RequestCancelledError, 'RequestCancelledError');

/** The active JS runtime doesn't reliably support streaming fetch responses. */
export class StreamingUnsupportedError extends EducationAssistantError {}
defineErrorName(StreamingUnsupportedError, 'StreamingUnsupportedError');

/** An SSE event/data payload could not be parsed. */
export class MalformedStreamError extends EducationAssistantError {}
defineErrorName(MalformedStreamError, 'MalformedStreamError');

const REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id'];

export function extractRequestId(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Maps an HTTP status + parsed body to the matching typed error. Never
 * includes the raw response body or a stack trace in the message — only
 * the backend's `detail` string (already a safe, user-facing message by
 * backend convention; see app/api/error_handlers.py), truncated
 * defensively in case that convention is ever violated.
 */
export function errorFromResponse(params: {
  status: number;
  detail: string | null;
  requestId: string | null;
  rawBody?: unknown;
}): EducationAssistantError {
  const { status, requestId } = params;
  const message = safeMessage(params.detail, status);
  const options: EducationAssistantErrorOptions = { requestId, statusCode: status };

  switch (status) {
    case 401:
      return new AuthenticationError(message, options);
    case 403:
      return new AuthorizationError(message, options);
    case 404:
      return new NotFoundError(message, options);
    case 409:
      return new ConflictError(message, options);
    case 422:
      return new ValidationError(message, { ...options, details: params.rawBody ?? null });
    case 429:
      return new RateLimitError(message, options);
    case 502:
      return new ProviderUnavailableError(message, options);
    default:
      return new BackendError(message, options);
  }
}

const MAX_MESSAGE_LENGTH = 500;

function safeMessage(detail: string | null, status: number): string {
  if (!detail) return `Backend returned HTTP ${status}`;
  const truncated =
    detail.length > MAX_MESSAGE_LENGTH ? `${detail.slice(0, MAX_MESSAGE_LENGTH)}…` : detail;
  return truncated;
}
