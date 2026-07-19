import { Job } from 'bullmq';
import { query } from '../../db/client.js';
import { snapshotBillingMonth } from '../../services/billing.js';

// Freezes the previous complete calendar month's billing for every active org.
// Registered as a daily repeatable (jobs/retention-scheduler.ts); the first run
// after a month ends writes that month's rows and the UNIQUE(org, month)
// constraint makes every later run a no-op.
export async function processBillingSnapshot(_job: Job) {
  const rows = await query<{ month_start: string }>(
    `SELECT to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM-DD') AS month_start`
  );
  const monthStart = rows[0]!.month_start;
  const written = await snapshotBillingMonth(monthStart);
  console.log(`[Billing] Snapshot for ${monthStart}: froze ${written} tenant billing row(s)`);
}
