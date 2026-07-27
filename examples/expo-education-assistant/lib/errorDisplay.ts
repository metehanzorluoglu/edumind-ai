import type { EducationAssistantError } from 'education-assistant-client';

/**
 * Formats an API error for display/logging with its real HTTP context —
 * method, full URL, and (for an HTTP-status error) the actual status code
 * and the backend's own detail message — e.g.:
 *
 *   GET http://127.0.0.1:8000/projects
 *   HTTP 401
 *   Invalid or expired access token
 *
 * A 401/404/500 must never be shown or logged as a generic "network
 * failure" — only a genuine fetch()-level exception (no HTTP response at
 * all, `error.statusCode === null`) is described as a network error.
 * Never includes an Authorization header or token value: those never
 * reach this function's inputs in the first place (EducationAssistantError
 * itself never carries them — see the SDK's errors.ts docs).
 */
export function describeApiError(
  method: string,
  baseUrl: string,
  path: string,
  error: EducationAssistantError
): string {
  const requestLine = `${method} ${baseUrl}${path}`;
  if (error.statusCode !== null) {
    return `${requestLine}\nHTTP ${error.statusCode}\n${error.message}`;
  }
  return `${requestLine}\nNetwork error: ${error.message}`;
}
