import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { syncProductsFromZoho } from '../../services/product-resolution.js';
import { ZohoScopeError } from '../../services/zoho.js';

/**
 * Daily catalogue sync: mirror each configured tenant's Zoho product picklist
 * into their products catalogue. Runs for every org with an active Zoho
 * connection that has the picklist source configured (policies_module +
 * policy_product_field). Best-effort per org — one org's failure (e.g. a
 * connection that needs reconnecting for scope) is logged and skipped, never
 * aborting the sweep for the rest.
 */
export async function processSyncProducts(_job: Job): Promise<void> {
  const orgs = await query<{ organization_id: string }>(
    `SELECT organization_id FROM zoho_connections
       WHERE status = 'active'
         AND policies_module IS NOT NULL
         AND policy_product_field IS NOT NULL`
  );
  if (orgs.length === 0) {
    console.log('[SyncProducts] No orgs configured for product sync — nothing to do');
    return;
  }

  for (const { organization_id } of orgs) {
    try {
      const r = await syncProductsFromZoho(organization_id);
      if (r.configured) {
        console.log(
          `[SyncProducts] org ${organization_id}: +${r.added} added, ${r.updated} updated, ` +
            `${r.deactivated} deactivated (${r.active} active)`
        );
      }
    } catch (err) {
      const reason = err instanceof ZohoScopeError ? 'needs reconnect for scope' : (err as Error).message;
      console.warn(`[SyncProducts] org ${organization_id} skipped: ${reason}`);
    }
  }
}
