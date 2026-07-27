import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  BackendError,
  ConflictError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitError,
  ValidationError,
  errorFromResponse,
  extractRequestId,
} from '../src/client/errors';

describe('errorFromResponse status-code mapping', () => {
  it.each([
    [401, AuthenticationError],
    [403, AuthorizationError],
    [404, NotFoundError],
    [409, ConflictError],
    [429, RateLimitError],
    [502, ProviderUnavailableError],
    [500, BackendError],
    [418, BackendError],
  ])('status %s maps to %s', (status, ctor) => {
    const error = errorFromResponse({ status, detail: 'oops', requestId: null });
    expect(error).toBeInstanceOf(ctor);
    expect(error.name).toBe(ctor.name);
    expect(error.statusCode).toBe(status);
  });

  it('maps 422 to ValidationError and preserves the raw body as details', () => {
    const rawBody = { detail: [{ loc: ['body', 'query'], msg: 'required', type: 'missing' }] };
    const error = errorFromResponse({
      status: 422,
      detail: 'Validation failed',
      requestId: null,
      rawBody,
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toBe(rawBody);
  });

  it('falls back to a generic message when detail is null', () => {
    const error = errorFromResponse({ status: 500, detail: null, requestId: null });
    expect(error.message).toBe('Backend returned HTTP 500');
  });

  it('truncates an overlong detail message defensively', () => {
    const longDetail = 'x'.repeat(1000);
    const error = errorFromResponse({ status: 500, detail: longDetail, requestId: null });
    expect(error.message.length).toBeLessThan(600);
    expect(error.message.endsWith('…')).toBe(true);
  });

  it('carries the request id through onto the error', () => {
    const error = errorFromResponse({ status: 404, detail: 'not found', requestId: 'req-123' });
    expect(error.requestId).toBe('req-123');
  });
});

describe('extractRequestId', () => {
  it('reads x-request-id first', () => {
    const headers = new Headers({ 'x-request-id': 'abc', 'x-correlation-id': 'def' });
    expect(extractRequestId(headers)).toBe('abc');
  });

  it('falls back to x-correlation-id', () => {
    const headers = new Headers({ 'x-correlation-id': 'def' });
    expect(extractRequestId(headers)).toBe('def');
  });

  it('returns null when neither header is present', () => {
    expect(extractRequestId(new Headers())).toBeNull();
    expect(extractRequestId(null)).toBeNull();
  });
});
