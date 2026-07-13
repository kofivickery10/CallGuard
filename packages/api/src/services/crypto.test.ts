import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, encryptBuffer, decryptBuffer } from './crypto.js';

describe('crypto (AES-256-GCM)', () => {
  it('round-trips a string', () => {
    const plain = 'sk_live_super_secret_token_🔐';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });

  it('produces a fresh IV each time (no deterministic ciphertext)', () => {
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same input');
    expect(decrypt(b)).toBe('same input');
  });

  it('round-trips a binary buffer', () => {
    const buf = Buffer.from([0, 1, 2, 253, 254, 255, 128, 64]);
    expect(decryptBuffer(encryptBuffer(buf)).equals(buf)).toBe(true);
  });

  it('rejects a tampered ciphertext (auth tag verification)', () => {
    const enc = encrypt('important');
    const parts = enc.split(':');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[2]!, 'base64');
    ct[0] ^= 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${ct.toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a malformed value', () => {
    expect(() => decrypt('not-a-valid-format')).toThrow();
  });
});
