import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { ingestionQueue } from '../queue.js';
import { assembleJourney } from '../../services/journey.js';
import { fetchSaleProducts } from '../../services/zoho.js';
import { mapCrmValuesToProducts, type ResolvedProduct } from '../../services/product-resolution.js';
import { isNoScoreCrmStage } from '@callguard/shared';
import type { BranchConfig } from '@callguard/shared';

export interface AssembleJourneyJobData {
  organizationId: string;
  phone: string; // already E.164-normalised by the sale-trigger route
  recordId: string | null; // Zoho Customers Sold record id, for QA write-back
  clientName: string | null; // client name from the sale trigger (QA record)
  // Product-aware scoring: epoch-ms deadline for waiting on the CRM "Policies
  // Sold" related record to land (it can be created up to ~an hour after the
  // sale record fires the trigger). Set by the route only when the org has
  // product resolution configured. Undefined = don't poll for products.
  productDeadlineAt?: number;
  productPollAttempt?: number;
  // Scalar snapshot of the sale-trigger payload (routes/integrations.ts) —
  // persisted on the journey so capture-form resolution rules (crm_field)
  // can be evaluated when capture starts at scoring time.
  triggerContext?: Record<string, string>;
}

// Backoff schedule (minutes) for re-checking the CRM for the products sold. The
// related "Policies Sold" record is usually there within minutes but can lag up
// to ~an hour, so we re-check on a widening interval rather than one long fixed
// delay — a sale whose policies are already present scores promptly, and only a
// laggy one waits. Capped by productDeadlineAt.
const POLL_BACKOFF_MINUTES = [2, 10, 30, 60];

function nextPollDelayMs(attempt: number, deadlineAt: number | undefined): number | null {
  if (!deadlineAt) return null;
  const now = Date.now();
  if (now >= deadlineAt) return null;
  const minutes = POLL_BACKOFF_MINUTES[Math.min(attempt, POLL_BACKOFF_MINUTES.length - 1)]!;
  return Math.min(minutes * 60_000, deadlineAt - now);
}

/**
 * Delayed journey assembly, enqueued by the Zoho sale-trigger route after a
 * grace delay (see routes/integrations.ts). Runs the phone→customer lookup
 * here rather than in the webhook so that a sale which fired before any of the
 * customer's calls were captured isn't lost — by the time this runs, the grace
 * delay has given CloudTalk's capture webhooks time to land. assembleJourney is
 * idempotent, so a re-fired trigger simply reuses the in-flight journey.
 *
 * Product-aware scoring: before assembling, resolve which products the sale
 * covered from the CRM. The "Policies Sold" related record can be created after
 * the sale trigger fires, so if it isn't there yet this job re-enqueues itself
 * on a backoff until it lands or productDeadlineAt is reached — deferring the
 * whole journey (and its score) rather than scoring against unknown products.
 * If the deadline passes with nothing, we assemble anyway and score-journey
 * infers the products from the transcript (the AI fallback).
 */
export async function processAssembleJourney(job: Job<AssembleJourneyJobData>) {
  const { organizationId, phone, recordId, clientName, productDeadlineAt, productPollAttempt = 0, triggerContext } = job.data;

  const customer = await queryOne<{ id: string }>(
    'SELECT id FROM customers WHERE organization_id = $1 AND phone_normalized = $2',
    [organizationId, phone]
  );
  if (!customer) {
    console.log(`[AssembleJourney] No captured calls for ${phone} (org ${organizationId}) — nothing to score`);
    return;
  }

  // Backfill the customer's real name from the CRM. CloudTalk dials often carry
  // only a number (customer shows as "Unknown" until conversion); the sold-
  // customer record in Zoho is the authoritative name, so set it here.
  if (clientName) {
    await query('UPDATE customers SET name = $1 WHERE id = $2', [clientName, customer.id]);
  }

  // Resolve products from the CRM related list (primary source). Only attempted
  // when the route flagged the org as configured (productDeadlineAt set) and the
  // sale carried a record id to read the related list off.
  let products: ResolvedProduct[] = [];
  let productSource: 'crm' | null = null;
  // The policy stage (Zoho Deals' "Stage") off the same related-list read —
  // the authoritative signal for which scoring branch the sale belongs to
  // (on risk vs referred). Null when the org hasn't configured the field or
  // the records carry no value; score-journey then falls back to transcript
  // keywords and records branch_source='keyword'/'default' (migration 071).
  let crmStage: string | null = null;
  if (recordId && productDeadlineAt) {
    let landed = false;
    try {
      const sale = await fetchSaleProducts(organizationId, recordId);
      // Several policies on one sale can sit at different stages. Scoring is
      // per-sale and has one branch, so an inconsistent set is not something to
      // silently pick a winner from — leave the stage null and let the fallback
      // run, with the disagreement logged for the tenant to see.
      if (sale.stages.length === 1) {
        crmStage = sale.stages[0]!;
      } else if (sale.stages.length > 1) {
        console.warn(
          `[AssembleJourney] ${phone}: policies disagree on stage (${sale.stages.join(' | ')}) — ` +
            `leaving branch to the transcript fallback`
        );
      }
      if (!sale.configured) {
        // Org isn't set up for CRM product resolution after all — leave products
        // to the transcript fallback at score time.
        landed = true;
      } else if (sale.products.length > 0) {
        const { products: matched, unmatched } = await mapCrmValuesToProducts(organizationId, sale.products);
        if (unmatched.length > 0) {
          console.warn(
            `[AssembleJourney] ${phone}: CRM products with no catalogue match (add them under Products): ${unmatched.join(', ')}`
          );
        }
        // The CRM has delivered its products, so stop polling regardless of
        // whether any mapped. Only claim 'crm' resolution if at least one did —
        // otherwise leave productSource null so score-journey infers products
        // from the transcript. Pinning 'crm' with an empty set would both block
        // that fallback and (via productAppliesToItem's empty-set = applies-to-all
        // rule) score every product-scoped item against a sale whose products we
        // never resolved, producing false breaches.
        landed = true;
        if (matched.length > 0) {
          products = matched;
          productSource = 'crm';
        }
      }
      // configured + no products yet → not landed; fall through to the poll.
    } catch (err) {
      // Transient Zoho error — treat as "not landed yet" and let the poll retry
      // rather than failing (and dead-lettering) the whole journey.
      console.warn(`[AssembleJourney] ${phone}: product fetch failed, will re-check:`, (err as Error).message);
    }

    if (!landed) {
      const delayMs = nextPollDelayMs(productPollAttempt, productDeadlineAt);
      if (delayMs !== null) {
        await ingestionQueue.add(
          'assemble-journey',
          { ...job.data, productPollAttempt: productPollAttempt + 1 },
          { delay: delayMs, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } }
        );
        console.log(
          `[AssembleJourney] ${phone}: policies not in the CRM yet — re-checking in ` +
            `${Math.round(delayMs / 60_000)}m (attempt ${productPollAttempt + 1})`
        );
        return;
      }
      // Deadline reached with nothing — assemble now, score-journey will infer
      // the products from the transcript.
      console.log(`[AssembleJourney] ${phone}: product wait window elapsed — assembling, transcript fallback will apply`);
    }
  }

  // A sale the customer did not take up is not a sale. Bail before assembly so
  // no journey row is created, no audio is hydrated, nothing is transcribed and
  // nothing reaches the breach register or the CRM. Checked here rather than at
  // score time because everything expensive happens in between.
  if (crmStage) {
    const scorecard = await queryOne<{ id: string; branch_config: BranchConfig | null }>(
      `SELECT id, branch_config FROM scorecards
        WHERE organization_id = $1 AND is_active = true
        ORDER BY created_at ASC LIMIT 1`,
      [organizationId]
    );
    if (isNoScoreCrmStage(crmStage, scorecard?.branch_config)) {
      console.log(
        `[AssembleJourney] ${phone}: CRM stage "${crmStage}" is a no-score state — skipping this sale`
      );
      return;
    }
  }

  const journeyId = await assembleJourney({
    organizationId,
    customerId: customer.id,
    triggerSource: 'zoho_sale',
    zohoRecordId: recordId,
    clientName,
    products,
    productSource,
    crmStage,
    triggerContext: triggerContext ?? null,
  });

  if (!journeyId) {
    console.log(`[AssembleJourney] No calls in the journey window for ${phone} (org ${organizationId})`);
    return;
  }
  console.log(
    `[AssembleJourney] ${phone} → journey ${journeyId}` +
      (productSource === 'crm' ? ` (${products.length} product(s) from CRM)` : '') +
      (crmStage ? ` [CRM stage: ${crmStage}]` : ' [no CRM stage]')
  );
}
