import crypto from 'crypto';

const KEY_PREFIX = 'cg_live_';
const KEY_RANDOM_LENGTH = 32;

export interface GeneratedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const randomPart = crypto.randomBytes(24).toString('base64url').slice(0, KEY_RANDOM_LENGTH);
  const plaintext = `${KEY_PREFIX}${randomPart}`;
  const hash = hashApiKey(plaintext);
  const prefix = plaintext.slice(0, 12);
  return { plaintext, hash, prefix };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}
