import { query, withTransaction } from '../db/client.js';

// Org-scoped tables in FK-safe delete order (leaf -> root). Every table here has
// an `organization_id` column; children that ON DELETE CASCADE from these (e.g.
// call_scores/call_item_scores off calls, scorecard_items off scorecards,
// breach_events off breaches, journey_calls off journeys, knowledge_base_files
// off knowledge_base_sections, sftp_poll_logs/sftp_processed_files off
// sftp_sources, alert_deliveries off alert_rules, live_session_emitted_breaches
// off live_sessions, and refresh_tokens / two_factor_* off users) are removed
// automatically and so are not listed.
//
// The order respects the *intentional* RESTRICT foreign keys between org-scoped
// tables — calls -> scorecards, calls -> customers, calls -> users,
// journeys -> scorecards, breaches -> scorecard_items, live_sessions -> api_keys,
// webhook_deliveries -> api_keys, and the many "* -> users" edges. Those RESTRICTs
// are business rules (deleting a scorecard must not silently delete calls), so we
// order the teardown around them rather than converting them to CASCADE.
//
// `organizations` is deleted last, separately, by id.
const ORG_SCOPED_DELETE_ORDER = [
  'webhook_deliveries',       // -> api_keys (RESTRICT)
  'live_sessions',            // -> api_keys, scorecards (RESTRICT)
  'notifications',            // -> alert_rules (SET NULL)
  'score_corrections',        // -> scorecard_items (CASCADE) — before scorecards
  'breaches',                 // -> scorecard_items (RESTRICT) — before scorecards
  'call_share_links',         // -> calls (CASCADE) — before calls (also org-scoped)
  'calls',                    // -> scorecards, customers, users (RESTRICT)
  'journeys',                 // -> scorecards (RESTRICT), customers (CASCADE)
  'scorecards',               // -> users (RESTRICT); cascades scorecard_items
  'customers',                // after calls, journeys
  'knowledge_base_sections',  // cascades knowledge_base_files
  'sftp_sources',             // cascades sftp_poll_logs, sftp_processed_files
  'alert_rules',              // -> users (RESTRICT); after notifications
  'dialer_connections',
  'zoho_connections',
  'insight_digests',          // -> users (RESTRICT)
  'support_thread_reads',
  'support_messages',         // -> users (RESTRICT)
  'usage_events',             // org FK is SET NULL; delete explicitly for a full teardown
  'api_keys',                 // -> users (RESTRICT); after live_sessions, webhook_deliveries
  'audit_log',                // -> users (RESTRICT); before users
  'users',                    // -> organizations (RESTRICT); last org-scoped table
] as const;

export interface TenantDeletionResult {
  // Rows deleted per table (tables emptied by cascade report 0).
  counts: Record<string, number>;
  total: number;
}

// Who is deleting the tenant, for the retained platform-level audit record. The
// deleted tenant's own audit_log is purged with it, so this record is written
// with organization_id NULL and survives.
export interface TenantDeletionActor {
  userId: string | null;
  orgName: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Permanently delete an organization and all of its data, atomically.
 *
 * Runs in a single transaction: any failure (including the completeness guard
 * below) rolls the whole thing back, so a tenant is never left half-deleted.
 * Irreversible — the caller is responsible for authorisation and confirmation.
 */
export async function deleteOrganizationCascade(
  orgId: string,
  actor?: TenantDeletionActor
): Promise<TenantDeletionResult> {
  // Which target tables actually exist — older databases may predate some of
  // them, and attempting to DELETE a missing table inside a transaction would
  // abort the whole transaction (not just skip the statement).
  const existingRows = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  const existing = new Set(existingRows.map((r) => r.table_name));

  return withTransaction(async (tx) => {
    // audit_log is append-only (migration 044/046). Signal the sanctioned purge
    // so this transaction — and only this transaction — may delete the tenant's
    // audit rows. SET LOCAL is scoped to the transaction and resets on commit.
    await tx.query(`SET LOCAL app.allow_audit_purge = 'on'`);

    const counts: Record<string, number> = {};
    let total = 0;

    for (const table of ORG_SCOPED_DELETE_ORDER) {
      if (!existing.has(table)) continue;
      // Table names come only from the fixed const list above — never user input.
      // audit_log -> users is RESTRICT, so also purge any audit row that
      // references a user being deleted even if it isn't org-scoped (defensive:
      // in normal operation such a row shouldn't exist), or deleting `users`
      // below would fail.
      const where =
        table === 'audit_log'
          ? `organization_id = $1 OR user_id IN (SELECT id FROM users WHERE organization_id = $1)`
          : `organization_id = $1`;
      const rows = await tx.query(`DELETE FROM ${table} WHERE ${where} RETURNING 1`, [orgId]);
      counts[table] = rows.length;
      total += rows.length;
    }

    const orgRows = await tx.query(`DELETE FROM organizations WHERE id = $1 RETURNING 1`, [orgId]);
    counts.organizations = orgRows.length;
    total += orgRows.length;

    // Completeness guard. If any table still has an `organization_id` column AND
    // rows for this org, a later migration added an org-scoped table this
    // teardown doesn't cover. Throwing here rolls the transaction back so we
    // never silently orphan tenant data or leave a partially deleted org — the
    // fix is to add that table to ORG_SCOPED_DELETE_ORDER.
    const orgScoped = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'organization_id'`
    );
    const leftovers: string[] = [];
    for (const { table_name } of orgScoped) {
      if (!/^[a-z_]+$/.test(table_name)) continue; // defence-in-depth on the identifier
      const remaining = await tx.query(
        `SELECT 1 FROM ${table_name} WHERE organization_id = $1 LIMIT 1`,
        [orgId]
      );
      if (remaining.length > 0) leftovers.push(table_name);
    }
    if (leftovers.length > 0) {
      throw new Error(
        `Tenant deletion incomplete: rows for organization ${orgId} remain in [${leftovers.join(', ')}]. ` +
          `A newer org-scoped table is missing from the teardown order. Transaction rolled back.`
      );
    }

    // Retained platform-level audit record, written atomically with the delete.
    // organization_id is NULL so it isn't caught by the org-scoped purge above
    // and persists after the tenant is gone; the tenant name lives in summary +
    // metadata since the organizations row no longer exists to join against.
    if (actor) {
      await tx.query(
        `INSERT INTO audit_log
           (organization_id, user_id, action_type, entity_type, entity_id,
            summary, metadata, ip_address, user_agent)
         VALUES (NULL, $1, 'tenant.delete', 'organization', $2, $3, $4, $5, $6)`,
        [
          actor.userId,
          orgId,
          `Deleted tenant "${actor.orgName}" — ${total} rows removed`,
          JSON.stringify({ org_name: actor.orgName, org_id: orgId, counts }),
          actor.ip ?? null,
          actor.userAgent ?? null,
        ]
      );
    }

    return { counts, total };
  });
}
