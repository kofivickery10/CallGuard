import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redact } from '../src/tool.js';

test('redacts configured secret values', () => {
  const env = { FCA_API_KEY: 'abcdef123456', FCA_API_EMAIL: 'ops@example.com' };
  assert.equal(redact('key abcdef123456 used', env), 'key [REDACTED] used');
});

test('leaves non-secret values alone', () => {
  const env = { FCA_API_EMAIL: 'ops@example.com' };
  assert.equal(redact('sent by ops@example.com', env), 'sent by ops@example.com');
});

test('strips credentials from URLs even when not configured', () => {
  assert.equal(
    redact('connect postgres://reader:s3cret@db.host:5432/cg failed', {}),
    'connect postgres://[REDACTED]@db.host:5432/cg failed',
  );
});
