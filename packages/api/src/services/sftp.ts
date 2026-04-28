import { decrypt } from './crypto.js';

interface SFTPConfigRow {
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'privatekey';
  password_encrypted: string | null;
  private_key_encrypted: string | null;
}

interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  readyTimeout?: number;
}

function buildConnectOptions(config: SFTPConfigRow): ConnectOptions {
  const opts: ConnectOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 15_000,
  };
  if (config.auth_method === 'password' && config.password_encrypted) {
    opts.password = decrypt(config.password_encrypted);
  } else if (config.auth_method === 'privatekey' && config.private_key_encrypted) {
    opts.privateKey = decrypt(config.private_key_encrypted);
  } else {
    throw new Error('SFTP config missing credentials for selected auth method');
  }
  return opts;
}

export async function testConnection(config: SFTPConfigRow, remotePath: string): Promise<{
  ok: boolean;
  message: string;
  fileCount?: number;
}> {
  const { default: Client } = await import('ssh2-sftp-client');
  const client = new Client();
  try {
    await client.connect(buildConnectOptions(config));
    const list = await client.list(remotePath);
    return { ok: true, message: 'Connection successful', fileCount: list.length };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  modifyTime: number;
}

export async function listFiles(
  config: SFTPConfigRow,
  remotePath: string,
  filePattern: string | null
): Promise<RemoteFile[]> {
  const { default: Client } = await import('ssh2-sftp-client');
  const client = new Client();
  try {
    await client.connect(buildConnectOptions(config));
    const entries = await client.list(remotePath);
    const files = entries.filter((e) => e.type === '-');

    const matcher = filePattern ? globToRegex(filePattern) : null;
    return files
      .filter((f) => !matcher || matcher.test(f.name))
      .map((f) => ({
        name: f.name,
        path: `${remotePath.replace(/\/$/, '')}/${f.name}`,
        size: f.size,
        modifyTime: f.modifyTime,
      }));
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

export async function downloadFile(config: SFTPConfigRow, remotePath: string): Promise<Buffer> {
  const { default: Client } = await import('ssh2-sftp-client');
  const client = new Client();
  try {
    await client.connect(buildConnectOptions(config));
    const buffer = await client.get(remotePath);
    if (Buffer.isBuffer(buffer)) return buffer;
    throw new Error('Unexpected non-buffer result from SFTP download');
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}
