/**
 * Seed an org's product catalogue (product-aware scoring).
 *
 * Idempotent and safe to re-run: products are upserted by (org, name), so a
 * re-run refreshes external_key / re-activates rather than duplicating. Nothing
 * else is touched. Resolves the org by name.
 *
 * Each product's `external_key` is the value the tenant's CRM carries for it
 * (the Zoho "Policies Sold" product field), used to map an inbound sale onto
 * the catalogue. Here external_key is set equal to the product name because the
 * names below ARE the Zoho picklist values — adjust PRODUCTS if the CRM stores
 * a different value (e.g. an abbreviation).
 *
 * Usage (from repo root):
 *   # Dry run — connects and reports what it WOULD do, writes nothing:
 *   npm run -w packages/api tsx -- src/scripts/seed-products.ts --dry-run
 *   # For real:
 *   npm run -w packages/api tsx -- src/scripts/seed-products.ts --commit
 *
 * (or: cd packages/api && npx tsx src/scripts/seed-products.ts --dry-run)
 */

import { pool, query, queryOne } from '../db/client.js';

const ORG_NAME = 'Trust Point Mortgage and Protection Services';

// name === external_key: these are the exact Zoho "Policies Sold" `Product`
// picklist values (must match the CRM value verbatim for mapping to hit).
// Order is the catalogue display order.
const PRODUCTS: string[] = [
  'Level Term Life Insurance',
  'Increasing Term Life Insurance',
  'Decreasing Term Life Insurance',
  'Whole of Life',
  'Guaranteed Over 50s',
  'Standalone CIC',
  'Life/CIC',
  'Income Protection',
  'Metlife - Everyday Protect',
  'Metlife - Childshield',
  'Metlife - Mortgage Safe',
  'Private Medical Insurance',
  'Buildings & Contents Insurance',
  'Friendly Shield',
  'Relevant Life',
  'Shareholders Protection',
  'Key Person Protection',
];

async function main() {
  const commit = process.argv.includes('--commit');
  const dryRun = !commit;
  console.log(`[seed-products] ${dryRun ? 'DRY RUN (no writes)' : 'COMMIT'} — org "${ORG_NAME}"`);

  const org = await queryOne<{ id: string }>(
    'SELECT id FROM organizations WHERE name = $1',
    [ORG_NAME]
  );
  if (!org) {
    throw new Error(`Organization "${ORG_NAME}" not found — check the exact name.`);
  }
  console.log(`[seed-products] org id ${org.id}`);

  const existing = await query<{ name: string; external_key: string | null; is_active: boolean }>(
    'SELECT name, external_key, is_active FROM products WHERE organization_id = $1',
    [org.id]
  );
  const byName = new Map(existing.map((p) => [p.name, p]));

  for (let i = 0; i < PRODUCTS.length; i++) {
    const name = PRODUCTS[i]!;
    const prior = byName.get(name);
    const action = !prior
      ? 'CREATE'
      : prior.external_key === name && prior.is_active
        ? 'unchanged'
        : 'UPDATE';
    console.log(`  [${action}] ${name}  (external_key="${name}", sort_order=${i})`);

    if (!dryRun && action !== 'unchanged') {
      await query(
        `INSERT INTO products (organization_id, name, external_key, sort_order, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (organization_id, name) DO UPDATE SET
           external_key = EXCLUDED.external_key,
           sort_order   = EXCLUDED.sort_order,
           is_active    = true,
           updated_at   = now()`,
        [org.id, name, name, i]
      );
    }
  }

  if (dryRun) {
    console.log('[seed-products] dry run complete — re-run with --commit to apply.');
  } else {
    console.log('[seed-products] done.');
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[seed-products] failed:', err);
  process.exit(1);
});
