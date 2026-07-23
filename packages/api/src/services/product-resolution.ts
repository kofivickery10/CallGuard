import { config } from '../config.js';
import { query, withTransaction } from '../db/client.js';
import { fetchProductPicklist } from './zoho.js';
import { CLAUDE_MODELS } from '@callguard/shared';
import type { Product } from '@callguard/shared';

// A product matched to the org's catalogue, ready to attach to a journey.
export interface ResolvedProduct {
  product_id: string;
  product_name: string;
}

/** Active catalogue products for an org, in display order. */
export async function getActiveProducts(organizationId: string): Promise<Product[]> {
  return query<Product>(
    `SELECT * FROM products
       WHERE organization_id = $1 AND is_active = true
       ORDER BY sort_order, name`,
    [organizationId]
  );
}

export interface ProductSyncResult {
  // False when the org hasn't configured a picklist source — caller no-ops.
  configured: boolean;
  added: number;
  updated: number;
  deactivated: number;
  // Total active products after the sync.
  active: number;
}

/**
 * Mirror the Zoho product picklist into the catalogue: add new values,
 * refresh names, re-activate any that reappeared, and deactivate ones that
 * vanished from the picklist. Only Zoho-managed products (zoho_synced_at set)
 * are ever deactivated — products added by hand are left untouched, so manual
 * and synced products coexist. Idempotent. Throws ZohoScopeError (from
 * fetchProductPicklist) when the connection needs reconnecting for scope.
 */
export async function syncProductsFromZoho(organizationId: string): Promise<ProductSyncResult> {
  const picklist = await fetchProductPicklist(organizationId);
  if (!picklist.configured) {
    return { configured: false, added: 0, updated: 0, deactivated: 0, active: 0 };
  }

  return withTransaction(async (tx) => {
    // One timestamp for the whole run: products touched now get runAt; stale
    // Zoho-managed ones keep an older stamp and are deactivated below.
    const runAt = (await tx.queryOne<{ now: string }>('SELECT now() AS now'))!.now;

    let added = 0;
    let updated = 0;
    for (let i = 0; i < picklist.values.length; i++) {
      const { value, label } = picklist.values[i]!;
      const existing = await tx.queryOne<{ id: string }>(
        `SELECT id FROM products
           WHERE organization_id = $1 AND external_key IS NOT NULL
             AND lower(external_key) = lower($2)`,
        [organizationId, value]
      );
      if (existing) {
        await tx.query(
          `UPDATE products SET name = $2, external_key = $3, is_active = true,
             sort_order = $4, zoho_synced_at = $5, updated_at = now()
           WHERE id = $1`,
          [existing.id, label, value, i, runAt]
        );
        updated++;
      } else {
        // A distinct value whose label collides with an existing product name
        // (e.g. a manual one) would violate the (org, name) unique — fall back
        // to appending the value so the sync never fails on one clash.
        try {
          await tx.query(
            `INSERT INTO products (organization_id, name, external_key, sort_order, is_active, zoho_synced_at)
             VALUES ($1, $2, $3, $4, true, $5)`,
            [organizationId, label, value, i, runAt]
          );
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            await tx.query(
              `INSERT INTO products (organization_id, name, external_key, sort_order, is_active, zoho_synced_at)
               VALUES ($1, $2, $3, $4, true, $5)`,
              [organizationId, `${label} (${value})`, value, i, runAt]
            );
          } else {
            throw err;
          }
        }
        added++;
      }
    }

    // Deactivate Zoho-managed products no longer in the picklist (kept, not
    // deleted — journey_products / scorecard scoping may reference them).
    const deactivated = await tx.query<{ id: string }>(
      `UPDATE products SET is_active = false, updated_at = now()
         WHERE organization_id = $1
           AND zoho_synced_at IS NOT NULL AND zoho_synced_at <> $2
           AND is_active = true
       RETURNING id`,
      [organizationId, runAt]
    );

    const activeRow = await tx.queryOne<{ n: string }>(
      'SELECT count(*)::text AS n FROM products WHERE organization_id = $1 AND is_active = true',
      [organizationId]
    );

    return {
      configured: true,
      added,
      updated,
      deactivated: deactivated.length,
      active: Number(activeRow?.n ?? 0),
    };
  });
}

/**
 * Map raw CRM product values (e.g. from Zoho "Policies Sold") onto catalogue
 * products by `external_key`, case-insensitively. Returns the matched products
 * (deduped) and any values that didn't match a catalogue entry — the caller
 * logs unmatched values so a tenant can spot a product they haven't added yet.
 */
export async function mapCrmValuesToProducts(
  organizationId: string,
  values: string[]
): Promise<{ products: ResolvedProduct[]; unmatched: string[] }> {
  const cleaned = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { products: [], unmatched: [] };

  const rows = await query<{ id: string; name: string; external_key: string | null }>(
    `SELECT id, name, external_key FROM products
       WHERE organization_id = $1
         AND is_active = true
         AND external_key IS NOT NULL
         AND lower(external_key) = ANY($2::text[])`,
    [organizationId, cleaned.map((v) => v.toLowerCase())]
  );

  const byKey = new Map(rows.map((r) => [r.external_key!.toLowerCase(), r]));
  const products: ResolvedProduct[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  for (const value of cleaned) {
    const match = byKey.get(value.toLowerCase());
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      products.push({ product_id: match.id, product_name: match.name });
    } else if (!match) {
      unmatched.push(value);
    }
  }
  return { products, unmatched };
}

/**
 * AI fallback: infer which catalogue products a sale covered from the
 * transcript, when the CRM couldn't tell us (the related record never landed).
 * Returns catalogue products only — the model picks from the org's own list, so
 * it can't invent a product. Empty when the org has no products, no API key, or
 * the model is unsure; scoring then falls back to evaluating every item (the
 * conservative default — see productAppliesToItem).
 */
export async function detectProductsFromTranscript(
  organizationId: string,
  transcript: string
): Promise<ResolvedProduct[]> {
  const catalogue = await getActiveProducts(organizationId);
  if (catalogue.length === 0 || !config.anthropic.apiKey) return [];

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const list = catalogue.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
  const prompt = `A UK firm sells the products listed below. From the call transcript, identify which of these products the customer actually bought or agreed to during the sale. Only include a product if the transcript clearly shows it was sold — do not guess. If none are clearly sold, return an empty list.

## Products
${list}

## Call transcript(s)
<transcript>
${transcript}
</transcript>`;

  const response = await client.messages.create({
    model: CLAUDE_MODELS.HAIKU,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
    tools: [
      {
        name: 'report_products',
        description: 'Report which of the listed products were sold on this call',
        input_schema: {
          type: 'object' as const,
          properties: {
            product_names: {
              type: 'array',
              description: 'Exact product names from the list that were sold',
              items: { type: 'string' },
            },
          },
          required: ['product_names'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'report_products' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return [];
  const names = (toolUse.input as { product_names?: unknown }).product_names;
  if (!Array.isArray(names)) return [];

  const byName = new Map(catalogue.map((p) => [p.name.toLowerCase().trim(), p]));
  const products: ResolvedProduct[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const match = byName.get(raw.toLowerCase().trim());
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      products.push({ product_id: match.id, product_name: match.name });
    }
  }
  return products;
}
