/**
 * The only way a source registers a tool.
 *
 * Sources never touch McpServer.registerTool directly: they get `defineTool`,
 * which marks every tool read-only for the client and scrubs configured secrets
 * out of whatever the tool returns or throws. An upstream error that echoes a
 * connection string or an API key must not land in a Claude session.
 */
import { SOURCES } from './sources/index.js';

/** Secret values currently configured, longest first so overlaps redact fully. */
function secretValues(env) {
  return SOURCES.flatMap((s) => s.env)
    .filter((v) => v.secret && env[v.name])
    .map((v) => env[v.name])
    .filter((value) => value.length >= 6)
    .sort((a, b) => b.length - a.length);
}

/** Remove configured secrets and URL userinfo (user:password@) from text. */
export function redact(text, env = process.env) {
  let out = String(text);
  for (const value of secretValues(env)) out = out.split(value).join('[REDACTED]');
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
}

/**
 * Build the registration function handed to each source.
 *
 * A handler returns a plain value (object, array or string); it is serialised
 * to text. Throwing returns an MCP error result with the message redacted.
 */
export function makeDefineTool(server, env = process.env) {
  return function defineTool(name, { title, description, inputSchema, openWorld = true }, handler) {
    return server.registerTool(
      name,
      {
        title,
        description,
        inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld },
      },
      async (args) => {
        try {
          const value = await handler(args ?? {});
          const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return { content: [{ type: 'text', text: redact(text, env) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: 'text', text: redact(`${name} failed: ${message}`, env) }] };
        }
      },
    );
  };
}
