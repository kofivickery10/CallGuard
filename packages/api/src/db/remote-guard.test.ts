import { describe, it, expect } from 'vitest';
import { databaseHost, isLocalDatabase } from './remote-guard.js';

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
});
