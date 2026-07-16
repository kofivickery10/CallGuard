import { Job } from 'bullmq';
import { queryOne } from '../../db/client.js';
import { assembleJourney } from '../../services/journey.js';

export interface AssembleJourneyJobData {
  organizationId: string;
  phone: string; // already E.164-normalised by the sale-trigger route
  recordId: string | null; // Zoho Customers Sold record id, for QA write-back
  clientName: string | null; // client name from the sale trigger (QA record)
}

/**
 * Delayed journey assembly, enqueued by the Zoho sale-trigger route after a
 * grace delay (see routes/integrations.ts). Runs the phone→customer lookup
 * here rather than in the webhook so that a sale which fired before any of the
 * customer's calls were captured isn't lost — by the time this runs, the grace
 * delay has given CloudTalk's capture webhooks time to land. assembleJourney is
 * idempotent, so a re-fired trigger simply reuses the in-flight journey.
 */
export async function processAssembleJourney(job: Job<AssembleJourneyJobData>) {
  const { organizationId, phone, recordId, clientName } = job.data;

  const customer = await queryOne<{ id: string }>(
    'SELECT id FROM customers WHERE organization_id = $1 AND phone_normalized = $2',
    [organizationId, phone]
  );
  if (!customer) {
    console.log(`[AssembleJourney] No captured calls for ${phone} (org ${organizationId}) — nothing to score`);
    return;
  }

  const journeyId = await assembleJourney({
    organizationId,
    customerId: customer.id,
    triggerSource: 'zoho_sale',
    zohoRecordId: recordId,
    clientName,
  });

  if (!journeyId) {
    console.log(`[AssembleJourney] No calls in the journey window for ${phone} (org ${organizationId})`);
    return;
  }
  console.log(`[AssembleJourney] ${phone} → journey ${journeyId}`);
}
