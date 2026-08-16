import {
  BackendError,
  NetworkError,
  RequestCancelledError,
  TimeoutError,
  errorFromResponse,
  extractRequestId,
} from './errors';

export interface RequestContext {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  timeoutMs: number;
}

export interface JsonRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Passed straight through to fetch()'s own `credentials` option. Left
   * unset (browser default) for every ordinary Bearer-token-authenticated
   * call; only the auth endpoints that read/write the backend's HttpOnly
   * refresh cookie (see EducationAssistantClient's session methods) pass
   * 'include', since that's the only case this SDK ever needs a cookie to
   * cross an origin boundary.
   */
  credentials?: RequestCredentials;
  /**
   * Overrides the client's own constructed `context.timeoutMs` for this
   * one call — Milestone 5.1: compileWritingProject() is the first
   * ordinary (non-streaming) JSON call whose legitimate duration
   * (isolated LaTeX compilation, up to the compiler service's own
   * job_timeout_seconds) can genuinely exceed this SDK's normal
   * DEFAULT_TIMEOUT_MS. Every other existing call site omits this and
   * keeps using context.timeoutMs unchanged.
   */
  timeoutMs?: number;
}

export interface JsonRequestResult<T> {
  data: T;
  requestId: string | null;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(`${baseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Combines a caller-provided AbortSignal (for user cancellation) with an
 * internal timeout into a single signal, without relying on AbortSignal.any
 * / AbortSignal.timeout — both are recent additions not reliably present
 * across every JS engine this SDK may run under (older Hermes releases in
 * particular), so this is built from the broadly-supported primitives only
 * (AbortController + addEventListener + setTimeout).
 *
 * The timeout deadline and the user-cancellation forwarding are exposed as
 * separately-clearable, because callers that read a long-lived response
 * body (see stream.ts) need the deadline to stop applying once the
 * connection is established, while user cancellation must keep working for
 * the entire lifetime of the request.
 */
export function combineSignals(
  userSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal;
  /** Stops the timeout from firing later; user-cancellation forwarding stays active. */
  clearDeadline: () => void;
  /** Full cleanup: clears the deadline (if still pending) and stops forwarding user aborts. */
  dispose: () => void;
  didTimeOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const clearDeadline = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const onUserAbort = (): void => controller.abort();
  // A signal that is already aborted by the time we get here (the caller's
  // synchronous abort() can easily win a race against our own `await
  // getAccessToken()` before this function even runs) would never fire a
  // future 'abort' event for addEventListener to catch — so that case must
  // be checked explicitly rather than relied on to arrive as an event.
  if (userSignal?.aborted) {
    onUserAbort();
  } else {
    userSignal?.addEventListener('abort', onUserAbort);
  }

  return {
    signal: controller.signal,
    clearDeadline,
    dispose: () => {
      clearDeadline();
      userSignal?.removeEventListener('abort', onUserAbort);
    },
    didTimeOut: () => timedOut,
  };
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function parseErrorBody(bodyText: string): { detail: string | null; rawBody: unknown } {
  if (!bodyText) return { detail: null, rawBody: null };
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      return {
        detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
        rawBody: parsed,
      };
    }
    return { detail: JSON.stringify(parsed), rawBody: parsed };
  } catch {
    // Not JSON — never surface the raw body text (could be an HTML error
    // page or, in the worst case, a leaked traceback); use a generic message.
    return { detail: null, rawBody: null };
  }
}

/**
 * Performs one JSON request/response round trip. Never logs the
 * Authorization header or token value under any circumstance, including in
 * thrown errors (see errors.ts's safeMessage, which only ever surfaces the
 * backend's `detail` string, truncated).
 */
export async function requestJson<T>(
  context: RequestContext,
  options: JsonRequestOptions
): Promise<JsonRequestResult<T>> {
  const url = buildUrl(context.baseUrl, options.path, options.query);
  const token = await context.getAccessToken();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const effectiveTimeoutMs = options.timeoutMs ?? context.timeoutMs;
  const { signal, dispose, didTimeOut } = combineSignals(options.signal, effectiveTimeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal,
      credentials: options.credentials,
      // Every endpoint this SDK calls is dynamic state (auth status,
      // conversations, projects, …) — a GET must never be answered from
      // the browser's HTTP cache with a stale body (e.g. GET
      // /auth/providers reporting dev_login_enabled as it was on a
      // previous load, not as the backend reports it right now).
      cache: 'no-store',
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      if (didTimeOut()) {
        throw new TimeoutError(
          `Request to ${options.path} timed out after ${effectiveTimeoutMs}ms`
        );
      }
      throw new RequestCancelledError(`Request to ${options.path} was cancelled`);
    }
    throw new NetworkError(`Network request to ${options.path} failed`, { cause });
  } finally {
    dispose();
  }

  return parseJsonResponse<T>(response);
}

async function parseJsonResponse<T>(response: Response): Promise<JsonRequestResult<T>> {
  const requestId = extractRequestId(response.headers);

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    const { detail, rawBody } = parseErrorBody(bodyText);
    throw errorFromResponse({ status: response.status, detail, requestId, rawBody });
  }

  const text = await safeReadText(response);
  if (!text) {
    return { data: undefined as T, requestId };
  }

  try {
    return { data: JSON.parse(text) as T, requestId };
  } catch (cause) {
    throw new BackendError('Backend returned malformed JSON', { requestId, cause });
  }
}

export interface MultipartRequestOptions {
  method: 'POST';
  path: string;
  formData: FormData;
  signal?: AbortSignal;
}

/**
 * Multipart form submission (document upload). Deliberately never sets
 * Content-Type itself: fetch/FormData compute the correct
 * `multipart/form-data; boundary=...` value, and overriding it manually
 * breaks the boundary and corrupts the request body.
 */
export async function requestMultipart<T>(
  context: RequestContext,
  options: MultipartRequestOptions
): Promise<JsonRequestResult<T>> {
  const url = buildUrl(context.baseUrl, options.path);
  const token = await context.getAccessToken();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const { signal, dispose, didTimeOut } = combineSignals(options.signal, context.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.formData,
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) {
      if (didTimeOut()) {
        throw new TimeoutError(`Request to ${options.path} timed out after ${context.timeoutMs}ms`);
      }
      throw new RequestCancelledError(`Request to ${options.path} was cancelled`);
    }
    throw new NetworkError(`Network request to ${options.path} failed`, { cause });
  } finally {
    dispose();
  }

  return parseJsonResponse<T>(response);
}
