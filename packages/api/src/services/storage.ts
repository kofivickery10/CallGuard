import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { encryptBuffer, decryptBuffer } from './crypto.js';

const uploadsDir = path.resolve(config.uploadsDir);

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

// Storage keys embed caller-controlled filenames (multipart originalname, a
// dialler-supplied recording filename, etc.). path.join happily collapses
// "../" segments, so an unsanitised key can escape uploadsDir entirely — this
// is the single choke point all four functions below go through, so no
// caller can write/read/delete outside the uploads directory regardless of
// what key it constructs upstream.
function resolveSafePath(key: string): string {
  const filePath = path.resolve(uploadsDir, key);
  if (filePath !== uploadsDir && !filePath.startsWith(uploadsDir + path.sep)) {
    throw new Error(`Refusing to access a path outside the uploads directory: ${key}`);
  }
  return filePath;
}

/**
 * Encrypts the body with AES-256-GCM before writing to disk.
 * All new file writes go through this function.
 */
export async function uploadFile(
  key: string,
  body: Buffer,
  _contentType: string
): Promise<void> {
  const filePath = resolveSafePath(key);
  await ensureDir(path.dirname(filePath));
  const encrypted = encryptBuffer(body);
  await fs.writeFile(filePath, encrypted);
}

/**
 * Read a stored file. If encrypted=true, decrypts before returning the buffer.
 * Pass encrypted=false for legacy files written before encryption was enabled.
 */
export async function readFile(key: string, encrypted: boolean): Promise<Buffer> {
  const filePath = resolveSafePath(key);
  const raw = await fs.readFile(filePath);
  if (!encrypted) return raw;
  return decryptBuffer(raw);
}

/**
 * Delete a file from disk. Safe to call on missing files.
 */
export async function deleteFile(key: string): Promise<void> {
  const filePath = resolveSafePath(key);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Returns the absolute path of a stored file. Only use for existence checks
 * or deletion - reading an encrypted file this way will give ciphertext.
 */
export async function getFilePath(key: string): Promise<string> {
  const filePath = resolveSafePath(key);
  await fs.access(filePath);
  return filePath;
}
