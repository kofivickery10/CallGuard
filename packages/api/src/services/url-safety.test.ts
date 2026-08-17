import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import dns from 'dns/promises';
import { AppError } from '../middleware/errors.js';

// dns.lookup is the only I/O this module does — mock it so these tests never
// touch the network, and so we can assert exactly how many resolutions
// happen (the whole point of the fix under test).
vi.mock('dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import { assertSafeRemoteUrl } from './url-safety.js';

const lookupMock = dns.lookup as unknown as Mock;

beforeEach(() => {
  lookupMock.mockReset();
});

describe('assertSafeRemoteUrl', () => {
  it('rejects non-https URLs', async () => {
    await expect(assertSafeRemoteUrl('http://example.com/audio.mp3')).rejects.toThrow(AppError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects an unparseable URL', async () => {
    await expect(assertSafeRemoteUrl('not a url')).rejects.toThrow(AppError);
  });

  it('rejects when the host does not resolve', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(assertSafeRemoteUrl('https://nowhere.example.com/x.mp3')).rejects.toThrow(AppError);
  });

  it('rejects a hostname that resolves to a private/internal address', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertSafeRemoteUrl('https://internal.example.com/x.mp3')).rejects.toThrow(AppError);
  });

  it('rejects cloud metadata link-local addresses', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertSafeRemoteUrl('https://metadata.example.com/x.mp3')).rejects.toThrow(AppError);
  });

  it('rejects if ANY resolved address is private, even when another is public', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertSafeRemoteUrl('https://mixed.example.com/x.mp3')).rejects.toThrow(AppError);
  });

  it('accepts a hostname that resolves only to public addresses', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const result = await assertSafeRemoteUrl('https://example.com/audio.mp3');
    expect(result.url.hostname).toBe('example.com');
    expect(typeof result.lookup).toBe('function');
  });

  // The actual bug: assertSafeRemoteUrl used to return the hostname, and the
  // caller then fetched that hostname directly — a second, independent DNS
  // resolution. An attacker controlling the DNS answer can return a public
  // address to the check and a private one to that second resolution,
  // walking straight past validation (DNS rebinding). The fix pins the
  // connection to the exact address that was checked.
  it('pins the connection to the exact address that was validated, and does not re-resolve', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    // If the pinned `lookup` triggered a second resolution (the rebinding
    // bug), this is the answer it would get instead — an internal address.
    lookupMock.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);

    const { lookup } = await assertSafeRemoteUrl('https://example.com/audio.mp3');
    expect(lookupMock).toHaveBeenCalledTimes(1);

    const connected = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      lookup('example.com', {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family });
      });
    });

    expect(connected).toEqual({ address: '93.184.216.34', family: 4 });
    // Using the pinned lookup must not have triggered a fresh resolution —
    // that's the entire point of pinning.
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('returns the pinned address regardless of the hostname argument the HTTP client passes in', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const { lookup } = await assertSafeRemoteUrl('https://example.com/audio.mp3');

    const connected = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      // A real http(s).request always passes the request's own hostname
      // here, but the pinned lookup must ignore whatever it's given —
      // proving it can't be tricked into resolving something else.
      lookup('something-else-entirely.invalid', {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address: address as string, family });
      });
    });

    expect(connected.address).toBe('93.184.216.34');
  });

  // Redirect hops: assertSafeRemoteUrl does not follow redirects itself: a
  // caller that chooses to follow one must call it again for the redirect
  // target, getting an independent resolution + validation, not the first
  // call's pinned address. This is what stops a redirect hop from being the
  // rebinding vector.
  it('validates a redirect target independently of the original URL, catching one that resolves privately', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]); // original URL — public
    lookupMock.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]); // redirect target — private

    const original = await assertSafeRemoteUrl('https://good.example.com/x.mp3');
    expect(original.url.hostname).toBe('good.example.com');

    await expect(assertSafeRemoteUrl('https://evil.example.com/x.mp3')).rejects.toThrow(AppError);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });
});
