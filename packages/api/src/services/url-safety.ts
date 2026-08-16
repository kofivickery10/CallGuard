import dns from 'dns/promises';
import type { LookupAddress } from 'dns';
import type { LookupFunction } from 'net';
import { AppError } from '../middleware/errors.js';

// SSRF guard for server-side fetches of caller-supplied URLs (API ingest
// audio_url, bulk-import rows, CloudTalk recording_url). Without this, an API
// key holder can point the server at an internal address — cloud metadata
// endpoints, other services on the private network — and read the response
// back through the ingest error/audio pipeline.

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: string, bits: number) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) || // carrier-grade NAT
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) || // link-local incl. cloud metadata (169.254.169.254)
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('224.0.0.0', 4) || // multicast
    inRange('240.0.0.0', 4) // reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  return false;
}

function isPrivateAddress(ip: string): boolean {
  return ip.includes(':') ? isPrivateIPv6(ip) : isPrivateIPv4(ip);
}

export interface SafeRemoteUrl {
  /**
   * The original https:// URL. The hostname on this URL must still be used
   * as the TLS SNI/servername and the HTTP Host header of the request that
   * follows — swap it for the pinned IP below and certificate validation
   * (and any name-based virtual hosting on the remote end) breaks.
   */
  url: URL;
  /**
   * A `dns.lookup`-compatible callback pinned to the single address that was
   * just resolved and validated as public. Pass this as the `lookup` option
   * of `http(s).request` (it's accepted directly by both) instead of letting
   * the request resolve the hostname itself.
   *
   * This exists to close a DNS-rebinding hole: resolving the hostname here,
   * checking the result, and then handing the *hostname* to a second,
   * independent resolution (e.g. a plain `fetch(url)`) lets an attacker who
   * controls the DNS answer return a public address to this check and a
   * private one to the real request — walking straight past the validation
   * above. Pinning forces exactly one resolution, this one, to be the
   * address that ever gets connected to. If a future refactor "simplifies"
   * the caller back to `fetch(url)` (or any client that resolves the
   * hostname on its own instead of taking this `lookup`), it reopens this
   * hole — don't do that.
   */
  lookup: LookupFunction;
}

/**
 * Validate a caller-supplied URL is safe to fetch server-side: https only,
 * and resolves to a public (non-private/loopback/link-local) address. Throws
 * an AppError(400) if not.
 *
 * Returns a DNS-pinned `lookup` alongside the URL (see `SafeRemoteUrl`) — the
 * caller must use it for the connection rather than re-resolving the
 * hostname, or this check can be defeated by DNS rebinding. Does not follow
 * redirects itself; if a caller ever does follow one, it must call this
 * again for the redirect target and use the fresh `lookup` it returns, not
 * the one from this call.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<SafeRemoteUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, 'Invalid URL');
  }

  if (url.protocol !== 'https:') {
    throw new AppError(400, 'Only https:// URLs are allowed');
  }

  const hostname = url.hostname;
  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new AppError(400, `Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new AppError(400, 'URL resolves to a disallowed address');
  }

  // Pin to the first validated address. Every one of them was already
  // confirmed public above, so which one is picked doesn't affect safety —
  // this just needs to be *an* address that was actually checked, not a
  // fresh, unchecked resolution.
  const pinned = addresses[0]!;
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, pinned.address, pinned.family);
  };

  return { url, lookup };
}
