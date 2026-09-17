# callguard-ops: business tools for Claude Code

A small MCP server that lets Claude Code sessions in this repo pull real business
numbers (usage, cost, search, traffic, prospect checks) instead of estimating
them. It runs **locally only**, started by Claude Code over stdio from the
repo-root `.mcp.json`. It is not hosted, so scheduled cloud agents cannot reach it.

## Rules every tool follows

1. **Read-only.** No tool writes, updates or deletes anything, anywhere. Tools
   are registered through `defineTool` (`src/tool.js`), which marks them
   read-only. Never call `server.registerTool` directly.
2. **Customer data returns totals only.** Counts, sums and rates, never
   transcripts, findings text, names or call content. Protection calls contain
   health data, and the client DPAs do not cover pulling it into Claude sessions.
3. **Secrets stay in `tools/ops-mcp/.env`**, which is gitignored and never
   committed. Key files (the Google service account) sit outside the repo.
   `defineTool` redacts configured secrets and URL passwords from all output
   and errors.
4. **Least privilege per source.** Use a read-only database role, a usage-only
   Deepgram key and a Restricted Search Console user, and never the app's own
   credentials. That's why this server has its own `.env`, separate from the
   repo root's.

## Setup

```bash
npm run ops-mcp:install                          # from the repo root
cp tools/ops-mcp/.env.example tools/ops-mcp/.env # then fill in what you have
```

Restart Claude Code in the repo and approve the `callguard-ops` project server
when prompted. Then ask it to run the `health` tool. `cg` worktrees copy only the
root `.env`, so copy `tools/ops-mcp/.env` into a worktree yourself.
`claude --worktree` does copy it (see `.worktreeinclude`).

## Tools

| Tool | Source | Returns |
| --- | --- | --- |
| `health` | none | Every source, whether its tools are built, and which variables it is missing (names only, never values). Flags key files that are missing or inside the repo. Calls no external service. |

Planned sources, in build order (CG-55). Each has a file in `src/sources/` that
declares its variables and gets its tools when built:

| Source | File | Variables |
| --- | --- | --- |
| CallGuard database metrics | `database.js` | `OPS_DATABASE_URL` |
| Anthropic usage and cost | `anthropic.js` | `ANTHROPIC_ADMIN_API_KEY` |
| Deepgram usage | `deepgram.js` | `DEEPGRAM_USAGE_API_KEY`, `DEEPGRAM_PROJECT_ID` |
| Google Search Console | `search-console.js` | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GSC_SITE_URL` |
| Google Analytics 4 | `analytics.js` | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GA4_PROPERTY_ID` |
| Companies House | `companies-house.js` | `COMPANIES_HOUSE_API_KEY` |
| FCA Register | `fca-register.js` | `FCA_API_EMAIL`, `FCA_API_KEY` |

## Adding a source's tools

In its `src/sources/<name>.js`, set `register` to a function that receives
`(defineTool, env)`:

```js
register(defineTool, env) {
  defineTool(
    'search_performance',
    { title: '…', description: '…', inputSchema: { startDate: z.string() } },
    async ({ startDate }) => ({ rows: [] }), // return a value; throw on failure
  );
},
```

Add any new variables to the source's `env` list and to `.env.example` (a test
checks this). Mark secrets `secret: true` so they are redacted, and paths
`file: true` so `health` checks them. Add a row to the Tools table above.

Plain JavaScript (ES modules) with no build step, so it starts quickly and has
nothing to compile. It is a standalone package outside the npm workspaces, like
`integrations/aws-connect-bridge`, so its dependencies never touch the app's
lockfile. Tests use `node:test`: `npm run ops-mcp:test`.
