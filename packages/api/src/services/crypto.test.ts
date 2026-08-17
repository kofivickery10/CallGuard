import crypto from 'crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { encrypt, decrypt, encryptBuffer, decryptBuffer } from './crypto.js';
import { config } from '../config.js';

// Builds a blob exactly the way the pre-versioning encrypt()/encryptBuffer()
// used to — no "v2" prefix, no key id, no magic header — so we can prove the
// current code still reads data written before key-versioning existed.
function legacyEncryptString(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function legacyEncryptBuffer(plaintext: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

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
    // Flip a byte in the ciphertext segment (the last field, under both the
    // legacy 3-field and the current 5-field "v2:keyId:iv:authTag:ct" shape).
    const ct = Buffer.from(parts[parts.length - 1]!, 'base64');
    ct[0] ^= 0xff;
    const tampered = [...parts.slice(0, -1), ct.toString('base64')].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a malformed value', () => {
    expect(() => decrypt('not-a-valid-format')).toThrow();
  });
});

describe('crypto — key-versioned format', () => {
  // config is loaded from env once at import time but isn't frozen, so tests
  // can simulate a key rotation by mutating it directly and restoring it
  // afterwards.
  const mutableConfig = config as unknown as {
    encryptionKey: string;
    encryptionKeyId: string;
    encryptionLegacyKeys: string;
  };
  const ORIGINAL_KEY = mutableConfig.encryptionKey; // set by test/setup.ts

  afterEach(() => {
    mutableConfig.encryptionKey = ORIGINAL_KEY;
    mutableConfig.encryptionKeyId = '1';
    mutableConfig.encryptionLegacyKeys = '';
  });

  it('decrypts a string blob produced by the pre-versioning format (no prefix) — the critical backward-compat case', () => {
    const legacy = legacyEncryptString('an old secret', ORIGINAL_KEY);
    expect(legacy.split(':').length).toBe(3); // sanity: genuinely the old 3-field shape
    expect(decrypt(legacy)).toBe('an old secret');
  });

  it('decrypts a buffer blob produced by the pre-versioning format (no magic header) — the critical backward-compat case', () => {
    const plain = Buffer.from([9, 8, 7, 0, 255, 1, 2, 3]);
    const legacy = legacyEncryptBuffer(plain, ORIGINAL_KEY);
    expect(legacy.subarray(0, 8).toString('ascii')).not.toBe('CGENCv02'); // sanity: genuinely has no magic header
    expect(decryptBuffer(legacy).equals(plain)).toBe(true);
  });

  it('round-trips a string under the new versioned format, prefixed with the key id', () => {
    const enc = encrypt('fresh secret');
    const parts = enc.split(':');
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe('1');
    expect(parts.length).toBe(5);
    expect(decrypt(enc)).toBe('fresh secret');
  });

  it('round-trips a buffer under the new versioned format, prefixed with the magic header', () => {
    const plain = Buffer.from('some file bytes', 'utf8');
    const enc = encryptBuffer(plain);
    expect(enc.subarray(0, 8).toString('ascii')).toBe('CGENCv02');
    expect(decryptBuffer(enc).equals(plain)).toBe(true);
  });

  it('decrypts a string blob encrypted under a key that has since been retired, once it is configured as a legacy key', () => {
    const enc = encrypt('rotate me'); // written under current key id "1"

    // Simulate rotation: new current key/id, old key demoted to legacy under
    // the id it was actually encrypted with.
    mutableConfig.encryptionKey = 'f'.repeat(64);
    mutableConfig.encryptionKeyId = '2';
    mutableConfig.encryptionLegacyKeys = `1:${ORIGINAL_KEY}`;

    expect(decrypt(enc)).toBe('rotate me');

    // New writes after rotation carry the new key id.
    const encAfter = encrypt('after rotation');
    expect(encAfter.split(':')[1]).toBe('2');
    expect(decrypt(encAfter)).toBe('after rotation');
  });

  it('decrypts a buffer blob encrypted under a key that has since been retired, once it is configured as a legacy key', () => {
    const plain = Buffer.from([1, 2, 3, 4, 5]);
    const enc = encryptBuffer(plain); // written under current key id "1"

    mutableConfig.encryptionKey = 'f'.repeat(64);
    mutableConfig.encryptionKeyId = '2';
    mutableConfig.encryptionLegacyKeys = `1:${ORIGINAL_KEY}`;

    expect(decryptBuffer(enc).equals(plain)).toBe(true);
  });

  it('rejects a tampered string blob under the new versioned format', () => {
    const enc = encrypt('important v2');
    const parts = enc.split(':');
    const ct = Buffer.from(parts[4]!, 'base64');
    ct[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], parts[3], ct.toString('base64')].join(':');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects a tampered buffer blob under the new versioned format', () => {
    const enc = encryptBuffer(Buffer.from('important bytes'));
    enc[enc.length - 1] ^= 0xff; // flip a byte inside the ciphertext tail
    expect(() => decryptBuffer(enc)).toThrow();
  });

  it('rejects a tampered buffer blob under the pre-versioning format', () => {
    const legacy = legacyEncryptBuffer(Buffer.from('legacy bytes'), ORIGINAL_KEY);
    legacy[legacy.length - 1] ^= 0xff;
    expect(() => decryptBuffer(legacy)).toThrow();
  });

  it('rejects a blob whose key id is not configured', () => {
    const enc = encrypt('whose key is this');
    const parts = enc.split(':');
    parts[1] = '99';
    expect(() => decrypt(parts.join(':'))).toThrow();
  });
});
