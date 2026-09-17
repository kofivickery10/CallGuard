import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { healthReport } from './health.js';
import { SOURCES } from './sources/index.js';
import { makeDefineTool } from './tool.js';

const INSTRUCTIONS = `Read-only CallGuard business metrics: database totals, API usage and cost,
search, traffic and prospect lookups. Nothing here can write, and customer data
comes back as totals only, never call content. Call \`health\` first to see which
sources are configured.`;

export function createServer({ env = process.env, envFileFound = false, sources = SOURCES } = {}) {
  const server = new McpServer({ name: 'callguard-ops', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const defineTool = makeDefineTool(server, env);

  defineTool(
    'health',
    {
      title: 'Ops tools health check',
      description:
        'Lists every data source, whether its tools are built, and which environment variables it is missing. Checks configuration only; calls no external service.',
      openWorld: false,
    },
    () => healthReport(sources, env, { envFileFound }),
  );

  for (const source of sources) {
    if (source.register) source.register(defineTool, env);
  }
  return server;
}
