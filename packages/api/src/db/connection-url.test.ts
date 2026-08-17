import { describe, it, expect } from 'vitest';
import { stripSslModeParam } from './connection-url.js';

describe('stripSslModeParam', () => {
  it('strips a lone sslmode param', () => {
    expect(stripSslModeParam('postgres://u:p@h:5432/db?sslmode=require')).toBe(
      'postgres://u:p@h:5432/db'
    );
  });

  it('strips sslmode when it is first, leaving the rest well-formed', () => {
    expect(
      stripSslModeParam('postgres://u:p@h:5432/db?sslmode=no-verify&application_name=callguard')
    ).toBe('postgres://u:p@h:5432/db?application_name=callguard');
  });

  it('strips sslmode when it is last, leaving the rest well-formed', () => {
    expect(
      stripSslModeParam('postgres://u:p@h:5432/db?application_name=callguard&sslmode=verify-full')
    ).toBe('postgres://u:p@h:5432/db?application_name=callguard');
  });

  it('strips sslmode from the middle, preserving the params on either side', () => {
    expect(stripSslModeParam('postgres://u:p@h:5432/db?a=1&sslmode=require&b=2')).toBe(
      'postgres://u:p@h:5432/db?a=1&b=2'
    );
  });

  it('leaves a URL with no query string untouched', () => {
    expect(stripSslModeParam('postgres://u:p@h:5432/db')).toBe('postgres://u:p@h:5432/db');
  });

  it('leaves a URL with other params but no sslmode untouched', () => {
    expect(stripSslModeParam('postgres://u:p@h:5432/db?application_name=callguard')).toBe(
      'postgres://u:p@h:5432/db?application_name=callguard'
    );
  });

  it('does not corrupt or re-encode a password containing URL-special characters', () => {
    // Percent-encoded already, as a real connection string would carry it:
    // the raw password here is  p@ss:w0rd/#&?
    const encodedPassword = 'p%40ss%3Aw0rd%2F%23%26%3F';
    const input = `postgres://user:${encodedPassword}@h:5432/db?sslmode=require`;
    const result = stripSslModeParam(input);
    expect(result).toBe(`postgres://user:${encodedPassword}@h:5432/db`);
    expect(new URL(result).password).toBe(encodedPassword);
  });

  it('returns the input unchanged when it is not a parseable URL', () => {
    expect(stripSslModeParam('not a url')).toBe('not a url');
  });

  it('is case-insensitive on the sslmode key, matching the previous regex behaviour', () => {
    expect(stripSslModeParam('postgres://u:p@h:5432/db?SSLMODE=require&x=1')).toBe(
      'postgres://u:p@h:5432/db?x=1'
    );
  });
});
