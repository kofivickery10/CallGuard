import dns from 'dns/promises';
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

/**
 * Validate a caller-supplied URL is safe to fetch server-side: https only,
 * and resolves to a public (non-private/loopback/link-local) address. Throws
 * an AppError(400) if not. Does not follow redirects — call this again on
 * each hop if you choose to follow one.
 */
export async function assertSafeRemoteUrl(rawUrl: string): Promise<URL> {
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
  let addresses: string[];
  try {
    const results = await dns.lookup(hostname, { all: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new AppError(400, `Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new AppError(400, 'URL resolves to a disallowed address');
  }

  return url;
}
