import { describe, expect, it } from 'vitest';
import { isLocalOrPrivateAddress, normalizeBaseUrl } from '../src/utils/url';

describe('normalizeBaseUrl', () => {
  it('strips a trailing slash', () => {
    expect(normalizeBaseUrl('http://localhost:8000/').url).toBe('http://localhost:8000');
  });

  it('throws on an unsupported scheme', () => {
    expect(() => normalizeBaseUrl('ftp://example.com')).toThrow(/scheme/i);
  });

  it('throws on an invalid URL string', () => {
    expect(() => normalizeBaseUrl('not a url')).toThrow(/invalid/i);
  });

  it('warns for plain HTTP on a public host', () => {
    const result = normalizeBaseUrl('http://api.example.com');
    expect(result.isLocalOrPrivate).toBe(false);
    expect(result.warning).toMatch(/unencrypted/i);
  });

  it('does not warn for plain HTTP on a private-LAN host', () => {
    const result = normalizeBaseUrl('http://192.168.1.20:8000');
    expect(result.isLocalOrPrivate).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('does not warn for HTTPS regardless of host', () => {
    const result = normalizeBaseUrl('https://api.example.com');
    expect(result.warning).toBeNull();
  });
});

describe('isLocalOrPrivateAddress', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['192.168.1.20', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.1.1', true],
    ['myhost.local', true],
    ['api.example.com', false],
    ['8.8.8.8', false],
  ])('%s -> %s', (hostname, expected) => {
    expect(isLocalOrPrivateAddress(hostname)).toBe(expected);
  });
});
