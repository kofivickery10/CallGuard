/**
 * Re-attribute historical calls that were ingested with an agent name but no
 * linked adviser.
 *
 * Calls store the dialler's display name at ingest and resolve it to a user
 * once, at that moment. Every call ingested before the matching rules improved
 * therefore keeps whatever verdict the old rules reached — on the first tenant
 * this was measured against, 744 calls with a name and no adviser, because
 * CloudTalk's webhook sends "Tayler" and the user is "Tayler Scarborough".
 *
 * That is not cosmetic: an unlinked call is invisible to per-adviser reporting,
 * to the adviser's own view of their calls, and to per-agent learning context.
 *
 * Runs the CURRENT resolveAgent over the distinct unlinked names, so it picks up
 * the first-name and surname+prefix passes, and any external_agent_id mappings
 * written by sync-dialer-agents.ts. Resolution is per distinct name rather than
 * per call — a few hundred calls share a handful of names.
 *
 * Only ever fills in a NULL agent_id. An existing attribution is never changed:
 * silently moving a scored call (and its breaches) from one adviser to another
 * is not something a script should do unasked.
 *
 * Usage:
 *   ORG=<org-uuid> npx tsx src/scripts/relink-call-agents.ts
 *   ORG=<org-uuid> DRY_RUN=1 npx tsx src/scripts/relink-call-agents.ts
 *   # look further back when resolving the remainder from the dialler (default 90d):
 *   ORG=<org-uuid> DAYS=180 npx tsx src/scripts/relink-call-agents.ts
 *
 * Run sync-dialer-agents.ts FIRST — the exact second pass below depends on
 * advisers having their dialler agent id mapped.
 */

import { query } from '../db/client.js';
import { reresolveAgentForName } from '../services/ingestion.js';
import { getDialerConnection } from '../services/tenant-settings.js';
import { fetchCallsInWindow } from '../services/cloudtalk.js';

const orgId = process.env.ORG;
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!orgId) {
  console.error('ORG (organization uuid) is required');
  process.exit(1);
}

async function run() {
  const names = await query<{ agent_name: string; calls: number }>(
    `SELECT agent_name, count(*)::int AS calls
       FROM calls
      WHERE organization_id = $1
        AND agent_id IS NULL
        AND agent_name IS NOT NULL
        AND trim(agent_name) <> ''
      GROUP BY agent_name
      ORDER BY count(*) DESC`,
    [orgId as string]
  );

  if (names.length === 0) {
    console.log('[Relink] No unlinked calls with an agent name — nothing to do');
    process.exit(0);
  }

  const totalCalls = names.reduce((sum, r) => sum + r.calls, 0);
  console.log(
    `[Relink] org=${orgId}: ${totalCalls} unlinked call(s) across ${names.length} distinct name(s)` +
      `${dryRun ? ' (DRY RUN)' : ''}`
  );

  let relinked = 0;
  let stillUnlinked = 0;
  for (const row of names) {
    const { agentId, agentName } = await reresolveAgentForName(orgId as string, row.agent_name);
    if (!agentId) {
      console.log(`[Relink] "${row.agent_name}" (${row.calls} calls) — still no match`);
      stillUnlinked += row.calls;
      continue;
    }

    console.log(`[Relink] "${row.agent_name}" (${row.calls} calls) -> "${agentName}"`);
    if (!dryRun) {
      // Re-assert agent_id IS NULL in the UPDATE: another process could have
      // attributed one of these between the SELECT above and here.
      const updated = await query<{ id: string }>(
        `UPDATE calls SET agent_id = $1, agent_name = $2, updated_at = now()
          WHERE organization_id = $3 AND agent_name = $4 AND agent_id IS NULL
          RETURNING id`,
        [agentId, agentName, orgId as string, row.agent_name]
      );
      relinked += updated.length;
    } else {
      relinked += row.calls;
    }
  }

  // Second pass: resolve what's left from the dialler itself, exactly.
  //
  // A bare display name with no surname ("Vish" for "Vishall Bhalla") cannot be
  // matched safely by string rules — widening the prefix test enough to catch it
  // would also let "Dan" claim "Daniel", and mis-attributing a compliance breach
  // is worse than leaving a call unattributed.
  //
  // It doesn't have to be guessed. Calls now carry dialer_call_id (migration
  // 075), and the dialler's call history reports the agent id per call, which
  // sync-dialer-agents.ts has already mapped to an adviser. So look the call up
  // and read the answer rather than inferring it. Exact, and it needs no
  // assumption about how names are spelled.
  if (stillUnlinked > 0) {
    const conn = await getDialerConnection(orgId as string, 'cloudtalk');
    if (!conn) {
      console.log('[Relink] No CloudTalk connection — cannot resolve the remainder from the dialler');
    } else {
      const remaining = await query<{ id: string; dialer_call_id: string }>(
        `SELECT id, dialer_call_id FROM calls
          WHERE organization_id = $1 AND agent_id IS NULL AND dialer_call_id IS NOT NULL`,
        [orgId as string]
      );
      if (remaining.length === 0) {
        console.log('[Relink] Nothing left that carries a dialler call id');
      } else {
        // Check the mapping exists BEFORE the history sweep — that sweep pages
        // tens of thousands of CDRs and takes a minute, and without any mapped
        // adviser there is nothing it could resolve to.
        const usersByExt = new Map(
          (
            await query<{ id: string; name: string; external_agent_id: string }>(
              'SELECT id, name, external_agent_id FROM users WHERE organization_id = $1 AND external_agent_id IS NOT NULL',
              [orgId as string]
            )
          ).map((u) => [u.external_agent_id, u])
        );
        if (usersByExt.size === 0) {
          console.log(
            '[Relink] No advisers have a dialler agent id yet — run sync-dialer-agents.ts first, ' +
              'then re-run this to resolve the remainder exactly'
          );
          console.log(
            `[Relink] done: ${relinked} call(s) attributed${dryRun ? ' (not written)' : ''}, ` +
              `${stillUnlinked} left unlinked`
          );
          process.exit(0);
        }

        const spanDays = Number(process.env.DAYS ?? 90);
        console.log(
          `[Relink] ${remaining.length} call(s) still unlinked but carry a dialler call id — ` +
            `reading their agent from the last ${spanDays}d of call history…`
        );
        const history = await fetchCallsInWindow(conn, spanDays);
        const agentByCallId = new Map(history.map((e) => [e.id, e.agentExternalId]));

        const perAdviser = new Map<string, number>();
        let exact = 0;
        let noHistory = 0;
        for (const call of remaining) {
          const ext = agentByCallId.get(call.dialer_call_id);
          const user = ext ? usersByExt.get(ext) : undefined;
          if (!user) {
            noHistory++;
            continue;
          }
          if (!dryRun) {
            await query(
              `UPDATE calls SET agent_id = $1, agent_name = $2, updated_at = now()
                WHERE id = $3 AND agent_id IS NULL`,
              [user.id, user.name, call.id]
            );
          }
          perAdviser.set(user.name, (perAdviser.get(user.name) ?? 0) + 1);
          exact++;
        }
        for (const [name, n] of [...perAdviser.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`[Relink] ${n} call(s) -> "${name}" by dialler agent id (exact)`);
        }
        relinked += exact;
        stillUnlinked -= exact;
        if (noHistory > 0) {
          console.log(
            `[Relink] ${noHistory} call(s) not resolvable — outside the ${spanDays}d history window, ` +
              `or their dialler agent has no CallGuard user (raise DAYS to look further back)`
          );
        }
      }
    }
  }

  console.log(
    `[Relink] done: ${relinked} call(s) attributed${dryRun ? ' (not written)' : ''}, ` +
      `${stillUnlinked} left unlinked`
  );
  process.exit(0);
}

run().catch((err) => {
  console.error('[Relink] failed:', err);
  process.exit(1);
});
