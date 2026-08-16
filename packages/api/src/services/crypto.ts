import crypto from 'crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// The key id every blob encrypted before key-versioning existed is treated
// as having used. It equals config.encryptionKeyId's default ("1"), so on an
// unrotated deployment "the implicit key" and "the current key" are the same
// key and old blobs just work. Once an operator actually rotates (see
// config.ts), the retiring key must be kept reachable under this same id via
// ENCRYPTION_LEGACY_KEYS so pre-versioning blobs keep decrypting forever.
const LEGACY_IMPLICIT_KEY_ID = '1';

function getCurrentKeyId(): string {
  const id = config.encryptionKeyId;
  // Both blob formats below use `:` (string format) or a length-prefixed
  // ASCII field (buffer format) to delimit the key id from the rest of the
  // blob. A `:` in the id would corrupt the string-format delimiting, so it's
  // rejected outright rather than allowed to produce a blob that can't be
  // parsed back.
  if (!id || id.includes(':')) {
    throw new Error('ENCRYPTION_KEY_ID must be a non-empty string without ":"');
  }
  return id;
}

function getCurrentKey(): Buffer {
  const key = Buffer.from(config.encryptionKey, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  }
  return key;
}

// Parses "id:hexkey,id:hexkey" into a lookup of previously-current keys, kept
// around purely so blobs encrypted under a now-retired key can still be
// decrypted. There is no rotation tool in this file — an operator populates
// this env var by hand when they rotate ENCRYPTION_KEY (see config.ts).
function parseLegacyKeys(): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  const raw = config.encryptionLegacyKeys;
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      throw new Error(`Invalid ENCRYPTION_LEGACY_KEYS entry (expected "id:hexkey"): ${trimmed}`);
    }
    const id = trimmed.slice(0, sep);
    const key = Buffer.from(trimmed.slice(sep + 1), 'hex');
    if (key.length !== 32) {
      throw new Error(`Legacy encryption key "${id}" must be 32 bytes (64 hex chars)`);
    }
    map.set(id, key);
  }
  return map;
}

// Resolves any key id found in a blob's prefix — the current key if it
// matches, otherwise a legacy key. Throws if the id names a key nobody has
// configured, rather than silently falling back to the current key (which
// would produce an authentication failure anyway, just with a more confusing
// error).
function getKeyById(keyId: string): Buffer {
  if (keyId === config.encryptionKeyId) return getCurrentKey();
  const legacy = parseLegacyKeys().get(keyId);
  if (!legacy) {
    throw new Error(`No encryption key configured for key id "${keyId}"`);
  }
  return legacy;
}

// --- String format ---
//
// Pre-versioning ("v1", implicit — never written as literal text) format:
//   base64(iv):base64(authTag):base64(ciphertext)
// exactly three ':'-separated fields, always produced under the implicit key.
//
// Versioned ("v2") format, written by this code:
//   v2:keyId:base64(iv):base64(authTag):base64(ciphertext)
// exactly five ':'-separated fields, the first literally "v2".
//
// Why the two can never be confused: base64's alphabet (A-Z a-z 0-9 + / =)
// contains no ':', so each base64 segment is guaranteed to arrive intact
// after a split on ':' — an old blob therefore *always* splits into exactly
// three parts, never four or five. keyId is validated above to also never
// contain ':' (and "v2" as a literal keyId still wouldn't matter, since the
// part count is what's checked first). So "3 parts" and "5 parts starting
// with the literal 'v2'" are disjoint, mutually exclusive shapes — there is
// no byte sequence that could satisfy both, and no probabilistic argument is
// needed here.
const STRING_VERSION_2 = 'v2';

export function encrypt(plaintext: string): string {
  const keyId = getCurrentKeyId();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getCurrentKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    STRING_VERSION_2,
    keyId,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(encrypted: string): string {
  const parts = encrypted.split(':');
  let keyId: string;
  let ivB64: string;
  let authTagB64: string;
  let ciphertextB64: string;

  if (parts.length === 5 && parts[0] === STRING_VERSION_2) {
    [, keyId, ivB64, authTagB64, ciphertextB64] = parts as [string, string, string, string, string];
  } else if (parts.length === 3) {
    keyId = LEGACY_IMPLICIT_KEY_ID;
    [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  } else {
    throw new Error('Invalid encrypted value format');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyById(keyId), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// --- Binary buffer format (file encryption) ---
//
// Pre-versioning format: [iv(12) | authTag(16) | ciphertext], no header at
// all — the blob starts directly with the (uniformly random) IV.
//
// Versioned format, written by this code:
//   [magic(8) | keyIdLen(1) | keyId(keyIdLen) | iv(12) | authTag(16) | ciphertext]
// where magic is the fixed 8-byte ASCII string "CGENCv02".
//
// Unlike the string format, there's no delimiter character to exploit here —
// a raw byte blob has no character that's structurally excluded from the old
// format, because the old format's leading bytes are literally
// crypto.randomBytes(12): every one of the 2^96 possible values is equally
// plausible ciphertext. So this can't be made *deterministically* unambiguous
// by content alone; instead:
//   1. The chance an old (pre-versioning) blob's first 8 bytes coincidentally
//      equal this exact ASCII magic is 1 in 2^64 — negligible enough that it
//      will not happen for any file this system will ever hold.
//   2. Even in that vanishingly unlikely event, the remaining bytes would be
//      misread as a bogus keyId/iv/authTag split of what is really "IV tail +
//      real authTag + real ciphertext". AES-GCM's authentication tag check
//      would then fail (it is not just unlikely to verify against the wrong
//      12 bytes as an IV — it verifies deterministically against exactly the
//      IV, key and ciphertext used to produce it), so decryptBuffer throws
//      rather than returning corrupted plaintext. A false-positive magic
//      match is therefore loud and safe, never silent and wrong — the
//      property that actually matters for data we can't afford to lose.
const BUFFER_MAGIC = Buffer.from('CGENCv02', 'ascii');

export function encryptBuffer(plaintext: Buffer): Buffer {
  const keyId = getCurrentKeyId();
  const keyIdBuf = Buffer.from(keyId, 'ascii');
  if (keyIdBuf.length > 255) {
    throw new Error('ENCRYPTION_KEY_ID is too long to encode (max 255 bytes)');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getCurrentKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    BUFFER_MAGIC,
    Buffer.from([keyIdBuf.length]),
    keyIdBuf,
    iv,
    authTag,
    ciphertext,
  ]);
}

export function decryptBuffer(encrypted: Buffer): Buffer {
  if (
    encrypted.length >= BUFFER_MAGIC.length &&
    encrypted.subarray(0, BUFFER_MAGIC.length).equals(BUFFER_MAGIC)
  ) {
    let offset = BUFFER_MAGIC.length;
    if (encrypted.length < offset + 1) {
      throw new Error('Encrypted buffer too small to contain a key id length');
    }
    const keyIdLen = encrypted[offset]!;
    offset += 1;

    if (encrypted.length < offset + keyIdLen + IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Encrypted buffer too small to contain key id, IV and auth tag');
    }
    const keyId = encrypted.subarray(offset, offset + keyIdLen).toString('ascii');
    offset += keyIdLen;
    const iv = encrypted.subarray(offset, offset + IV_LENGTH);
    offset += IV_LENGTH;
    const authTag = encrypted.subarray(offset, offset + AUTH_TAG_LENGTH);
    offset += AUTH_TAG_LENGTH;
    const ciphertext = encrypted.subarray(offset);

    const decipher = crypto.createDecipheriv(ALGORITHM, getKeyById(keyId), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  if (encrypted.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Encrypted buffer too small to contain IV and auth tag');
  }
  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyById(LEGACY_IMPLICIT_KEY_ID), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
