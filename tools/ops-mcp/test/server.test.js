import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createServer } from '../src/server.js';
import { SOURCES } from '../src/sources/index.js';

async function connect(options) {
  const server = createServer(options);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (result) => result.content[0].text;

test('health lists every source', async () => {
  const client = await connect({ env: {} });
  const result = await client.callTool({ name: 'health', arguments: {} });
  const report = JSON.parse(text(result));
  assert.deepEqual(report.sources.map((s) => s.id), SOURCES.map((s) => s.id));
});

test('every registered tool is marked read-only', async () => {
  const client = await connect({ env: {} });
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is not read-only`);
});

// FCA_API_KEY is a declared secret, so a source echoing it must be scrubbed.
const env = { FCA_API_KEY: 'live-key-9f8e7d' };
const leaky = {
  id: 'leaky',
  title: 'Leaky',
  env: [],
  register(defineTool) {
    defineTool('echo', { description: 'echo', inputSchema: { fail: z.boolean() } }, ({ fail }) => {
      if (fail) throw new Error('401 for key live-key-9f8e7d');
      return { key: 'live-key-9f8e7d' };
    });
  },
};

test('secrets are redacted from results and errors', async () => {
  const client = await connect({ env, sources: [leaky] });
  const ok = await client.callTool({ name: 'echo', arguments: { fail: false } });
  assert.doesNotMatch(text(ok), /live-key/);
  const bad = await client.callTool({ name: 'echo', arguments: { fail: true } });
  assert.equal(bad.isError, true);
  assert.equal(text(bad), 'echo failed: 401 for key [REDACTED]');
});
