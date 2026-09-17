import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/env.js';
import { checkSource, healthReport } from '../src/health.js';
import { SOURCES } from '../src/sources/index.js';

const keySource = {
  id: 'fake',
  title: 'Fake',
  env: [
    { name: 'FAKE_KEY_FILE', file: true },
    { name: 'FAKE_SITE' },
    { name: 'FAKE_OPTIONAL', optional: true },
  ],
  register: () => {},
};

test('names missing variables without their values', () => {
  const r = checkSource(keySource, { FAKE_SITE: 'site' });
  assert.equal(r.status, 'needs configuration');
  assert.deepEqual(r.missing, ['FAKE_KEY_FILE']);
});

test('a readable key file outside the repo is ready', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ops-mcp-')), 'key.json');
  writeFileSync(file, '{}');
  const r = checkSource(keySource, { FAKE_KEY_FILE: file, FAKE_SITE: 'site' });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.problems, []);
});

test('flags a key file inside the repo, even one that exists', () => {
  const r = checkSource(keySource, { FAKE_KEY_FILE: path.join(REPO_ROOT, 'package.json'), FAKE_SITE: 'site' });
  assert.equal(r.configured, false);
  assert.match(r.problems[0], /inside the repo/);
});

test('flags a key file that does not exist', () => {
  const r = checkSource(keySource, { FAKE_KEY_FILE: '/nonexistent/key.json', FAKE_SITE: 'site' });
  assert.match(r.problems[0], /does not exist/);
});

test('an unbuilt source says so even when configured', () => {
  const r = checkSource({ ...keySource, env: [], register: null }, {});
  assert.equal(r.status, 'not built yet');
  assert.equal(r.configured, true);
});

test('every variable is documented in .env.example', async () => {
  const { readFileSync } = await import('node:fs');
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  for (const v of SOURCES.flatMap((s) => s.env)) {
    assert.match(example, new RegExp(`^${v.name}=`, 'm'), `${v.name} missing from .env.example`);
  }
});

test('report covers every source', () => {
  const report = healthReport(SOURCES, {}, { envFileFound: false });
  assert.equal(report.sources.length, SOURCES.length);
  assert.match(report.envFile, /not found/);
});
