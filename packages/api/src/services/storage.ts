import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { encryptBuffer, decryptBuffer } from './crypto.js';

const uploadsDir = config.uploadsDir;

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
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
  const filePath = path.join(uploadsDir, key);
  await ensureDir(path.dirname(filePath));
  const encrypted = encryptBuffer(body);
  await fs.writeFile(filePath, encrypted);
}

/**
 * Read a stored file. If encrypted=true, decrypts before returning the buffer.
 * Pass encrypted=false for legacy files written before encryption was enabled.
 */
export async function readFile(key: string, encrypted: boolean): Promise<Buffer> {
  const filePath = path.join(uploadsDir, key);
  const raw = await fs.readFile(filePath);
  if (!encrypted) return raw;
  return decryptBuffer(raw);
}

/**
 * Delete a file from disk. Safe to call on missing files.
 */
export async function deleteFile(key: string): Promise<void> {
  const filePath = path.join(uploadsDir, key);
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
  const filePath = path.join(uploadsDir, key);
  await fs.access(filePath);
  return filePath;
}
