/**
 * Map the dialler's agents onto CallGuard advisers, once, so call attribution
 * stops depending on how names happen to be spelled.
 *
 * Attribution currently falls back to matching a dialler's display name against
 * users.name, and that fails constantly in ways nobody notices: CloudTalk's
 * webhook sends a short name ("Vish") where its own roster sends a full one
 * ("Vish Bhalla") and CallGuard has a third spelling ("Vishall Bhalla"); rosters
 * carry double spaces ("Harry  Fearnehough") and surname typos ("Fazal" for
 * "Fazel"). On the first tenant this was measured against, 744 calls had an
 * agent name and no linked adviser — roughly three quarters of their history —
 * so per-adviser reporting and per-agent learning context were both running on
 * a quarter of the data.
 *
 * users.external_agent_id already exists and already outranks name matching in
 * resolveAgent. It was simply never populated. This fills it in from the
 * dialler's own roster, after which attribution is exact and survives every one
 * of the spelling problems above — and an adviser changing their email.
 *
 * Matching is deliberately conservative, strongest signal first:
 *   1. email           — exact, case-insensitive
 *   2. full name       — exact, after collapsing whitespace
 *   3. surname + first-name prefix, only when unambiguous
 * Anything unmatched is reported for a human to map, never guessed.
 *
 * Usage:
 *   ORG=<org-uuid> npx tsx src/scripts/sync-dialer-agents.ts
 *   ORG=<org-uuid> DRY_RUN=1 npx tsx src/scripts/sync-dialer-agents.ts
 */

import { query, queryOne } from '../db/client.js';
import { getDialerConnection } from '../services/tenant-settings.js';
import { fetchAgents } from '../services/cloudtalk.js';

const orgId = process.env.ORG;
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!orgId) {
  console.error('ORG (organization uuid) is required');
  process.exit(1);
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

interface UserRow {
  id: string;
  name: string;
  email: string;
  external_agent_id: string | null;
}

async function run() {
  const conn = await getDialerConnection(orgId as string, 'cloudtalk');
  if (!conn) {
    console.error(`No CloudTalk connection for org ${orgId}`);
    process.exit(1);
  }

  const agents = await fetchAgents(conn);
  if (agents.length === 0) {
    console.error('CloudTalk returned no agents — check the connection credentials');
    process.exit(1);
  }
  const users = await query<UserRow>(
    'SELECT id, name, email, external_agent_id FROM users WHERE organization_id = $1',
    [orgId as string]
  );

  console.log(
    `[SyncAgents] org=${orgId}: ${agents.length} dialler agent(s), ${users.length} CallGuard user(s)` +
      `${dryRun ? ' (DRY RUN)' : ''}`
  );

  const byEmail = new Map(users.map((u) => [norm(u.email), u]));
  const byName = new Map(users.map((u) => [norm(u.name), u]));

  let linked = 0;
  let already = 0;
  const unmatched: string[] = [];
  // Guards against two dialler agents claiming one adviser (a duplicate roster
  // entry, or a shared mailbox) — external_agent_id has to be one-to-one or
  // attribution silently moves calls between people.
  const claimed = new Map<string, string>();

  for (const agent of agents) {
    let match = agent.email ? byEmail.get(norm(agent.email)) : undefined;
    let how = 'email';

    if (!match && agent.name) {
      match = byName.get(norm(agent.name));
      how = 'name';
    }

    // Surname + first-name prefix, unambiguous only. Same rule as resolveAgent.
    if (!match && agent.name) {
      const parts = norm(agent.name).split(' ').filter(Boolean);
      if (parts.length >= 2) {
        const first = parts[0]!;
        const last = parts[parts.length - 1]!;
        const cands = users.filter((u) => {
          const un = norm(u.name).split(' ').filter(Boolean);
          if (un.length < 2) return false;
          const uFirst = un[0]!;
          const uLast = un[un.length - 1]!;
          return uLast === last && (uFirst.startsWith(first) || first.startsWith(uFirst));
        });
        if (cands.length === 1) {
          match = cands[0];
          how = 'surname+prefix';
        } else if (cands.length > 1) {
          console.warn(`[SyncAgents] "${agent.name}" matches ${cands.length} advisers by surname — skipping`);
        }
      }
    }

    if (!match) {
      unmatched.push(`${agent.name ?? '(no name)'} <${agent.email ?? 'no email'}> id=${agent.id}`);
      continue;
    }

    const prior = claimed.get(match.id);
    if (prior && prior !== agent.id) {
      console.warn(
        `[SyncAgents] adviser "${match.name}" already claimed by dialler agent ${prior}; ` +
          `refusing to also map ${agent.id} — resolve this in CloudTalk`
      );
      continue;
    }
    claimed.set(match.id, agent.id);

    if (match.external_agent_id === agent.id) {
      already++;
      continue;
    }
    if (match.external_agent_id && match.external_agent_id !== agent.id) {
      console.warn(
        `[SyncAgents] adviser "${match.name}" is mapped to ${match.external_agent_id}, ` +
          `dialler says ${agent.id} — overwriting`
      );
    }

    console.log(`[SyncAgents] ${agent.name ?? agent.id} -> "${match.name}" via ${how} (agent id ${agent.id})`);
    if (!dryRun) {
      await query('UPDATE users SET external_agent_id = $1 WHERE id = $2', [agent.id, match.id]);
    }
    linked++;
  }

  console.log(
    `[SyncAgents] done: ${linked} mapped${dryRun ? ' (not written)' : ''}, ${already} already correct, ` +
      `${unmatched.length} unmatched`
  );
  if (unmatched.length > 0) {
    console.log('[SyncAgents] unmatched dialler agents (map these by hand, or add the user):');
    for (const u of unmatched) console.log(`             - ${u}`);
  }

  // Advisers with no dialler mapping still fall back to name matching, which is
  // the situation this script exists to get away from — worth naming them.
  const stillUnmapped = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM users WHERE organization_id = $1 AND external_agent_id IS NULL',
    [orgId as string]
  );
  if (stillUnmapped?.n) {
    console.log(
      `[SyncAgents] ${stillUnmapped.n} CallGuard user(s) still have no dialler id — ` +
        `their calls fall back to name matching`
    );
  }
  process.exit(0);
}

run().catch((err) => {
  console.error('[SyncAgents] failed:', err);
  process.exit(1);
});
