#!/usr/bin/env node
/**
 * Entry point Claude Code starts over stdio (see the repo-root .mcp.json).
 * stdout carries the MCP protocol, so anything human-readable goes to stderr.
 */
import { loadEnv } from './env.js';

const envFileFound = loadEnv();

let createServer, StdioServerTransport;
try {
  ({ createServer } = await import('./server.js'));
  ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error('callguard-ops: dependencies are not installed. From the repo root run: npm run ops-mcp:install');
    process.exit(1);
  }
  throw err;
}

await createServer({ envFileFound }).connect(new StdioServerTransport());
console.error(`callguard-ops: running (${envFileFound ? '.env loaded' : 'no .env, see .env.example'})`);
