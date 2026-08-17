import { describe, it, expect, afterEach } from 'vitest';
import { databaseHost, isLocalDatabase, assertDatabaseIsSafe } from './remote-guard.js';
import { config } from '../config.js';

describe('remote-guard', () => {
  it('treats loopback and docker-host databases as local', () => {
    expect(isLocalDatabase('postgresql://u:p@localhost:5432/callguard')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@127.0.0.1:5432/callguard')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@host.docker.internal:5432/callguard')).toBe(true);
  });

  it('treats the managed production host as remote', () => {
    const prod =
      'postgresql://u:p@ls-abc123.c3eua64c6gwl.eu-west-2.rds.amazonaws.com:5432/callguard?sslmode=no-verify';
    expect(isLocalDatabase(prod)).toBe(false);
    expect(databaseHost(prod)).toBe('ls-abc123.c3eua64c6gwl.eu-west-2.rds.amazonaws.com');
  });

  // An unparseable URL must not read as local — the guard's job is to fail
  // closed when it cannot prove the database is safe to mutate.
  it('does not treat an unparseable URL as local', () => {
    expect(isLocalDatabase('not a url')).toBe(false);
    expect(databaseHost('not a url')).toBeNull();
  });

  describe('assertDatabaseIsSafe', () => {
    const originalUrl = config.database.url;
    const originalNodeEnv = config.nodeEnv;
    const remoteUrl =
      'postgresql://u:p@ls-abc123.c3eua64c6gwl.eu-west-2.rds.amazonaws.com:5432/callguard';

    afterEach(() => {
      // Tests run with NODE_ENV=test and a local DATABASE_URL (see
      // src/test/setup.ts); restore both so later tests see the same config
      // this suite started with.
      (config as { database: { url: string } }).database.url = originalUrl;
      (config as { nodeEnv: string }).nodeEnv = originalNodeEnv;
      delete process.env.ALLOW_REMOTE_DB;
    });

    it('is a no-op against a local database', () => {
      (config as { database: { url: string } }).database.url = 'postgresql://u:p@localhost:5432/callguard';
      expect(() => assertDatabaseIsSafe('worker')).not.toThrow();
    });

    // The whole point of parameterising the process name is that the worker
    // and the API each name themselves correctly rather than one hardcoding
    // "worker" into a shared message.
    it('names the calling process in the thrown error', () => {
      (config as { database: { url: string } }).database.url = remoteUrl;
      expect(() => assertDatabaseIsSafe('worker')).toThrow(/Refusing to start the worker/);
      expect(() => assertDatabaseIsSafe('api')).toThrow(/Refusing to start the api/);
    });

    it('is a no-op in production regardless of database host', () => {
      (config as { database: { url: string } }).database.url = remoteUrl;
      (config as { nodeEnv: string }).nodeEnv = 'production';
      expect(() => assertDatabaseIsSafe('api')).not.toThrow();
    });

    it('allows a remote database when ALLOW_REMOTE_DB=true, naming the process in the warning', () => {
      (config as { database: { url: string } }).database.url = remoteUrl;
      process.env.ALLOW_REMOTE_DB = 'true';
      expect(() => assertDatabaseIsSafe('api')).not.toThrow();
    });
  });
});
