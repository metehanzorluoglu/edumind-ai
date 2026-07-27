const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * True for localhost and RFC 1918 private-LAN ranges (10.0.0.0/8,
 * 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16), and mDNS
 * `.local` hostnames — the addresses a phone on the same Wi-Fi as a dev
 * machine would actually use. See docs/PHYSICAL_DEVICE_NETWORKING.md.
 */
export function isLocalOrPrivateAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(normalized)) return true;
  if (normalized.endsWith('.local')) return true;

  const octets = normalized.split('.');
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    const a = Number(octets[0]);
    const b = Number(octets[1]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }

  return false;
}

export interface NormalizedBaseUrl {
  /** Normalized absolute URL string with no trailing slash. */
  url: string;
  isLocalOrPrivate: boolean;
  /** Non-null when the URL uses HTTP outside a recognized local/private address. */
  warning: string | null;
}

/**
 * Validates and normalizes a backend base URL.
 *
 * @throws {Error} if the string isn't a valid absolute URL, or uses a
 *   scheme other than http/https.
 */
export function normalizeBaseUrl(rawUrl: string): NormalizedBaseUrl {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid base URL: "${rawUrl}". Expected an absolute http(s):// URL.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}" in base URL "${rawUrl}" — only http:// and ` +
        `https:// are supported.`
    );
  }

  const isLocalOrPrivate = isLocalOrPrivateAddress(parsed.hostname);
  const warning =
    parsed.protocol === 'http:' && !isLocalOrPrivate
      ? `Base URL "${rawUrl}" uses plain HTTP but "${parsed.hostname}" is not a recognized ` +
        `localhost/private-LAN address. This sends the API token over an unencrypted ` +
        `connection. Use HTTPS for any non-local/remote deployment.`
      : null;

  const url = parsed.toString().replace(/\/+$/, '');

  return { url, isLocalOrPrivate, warning };
}
