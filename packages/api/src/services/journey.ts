import { query, queryOne, withTransaction } from '../db/client.js';
import { getDialerConnection } from './tenant-settings.js';
import { scoringQueue } from '../jobs/queue.js';
import type { JourneyTriggerSource, Scorecard, Call } from '@callguard/shared';

const DEFAULT_HISTORY_WINDOW_DAYS = 30;

interface AssembleJourneyParams {
  organizationId: string;
  customerId: string;
  scorecardId?: string | null;
  triggerSource: JourneyTriggerSource;
}

/**
 * Resolve which scorecard a journey scores against: the caller's explicit
 * choice, else the org's oldest active scorecard. Mirrors the fallback in
 * jobs/processors/score.ts (kept separate — journeys and per-call scoring
 * are different enough call sites that sharing one function would need to
 * thread call-vs-journey context through it for one small duplicated block).
 */
async function resolveScorecard(organizationId: string, scorecardId?: string | null): Promise<Scorecard | null> {
  if (scorecardId) {
    return queryOne<Scorecard>(
      'SELECT * FROM scorecards WHERE id = $1 AND organization_id = $2',
      [scorecardId, organizationId]
    );
  }
  const active = await query<Scorecard>(
    'SELECT * FROM scorecards WHERE organization_id = $1 AND is_active = true ORDER BY created_at ASC',
    [organizationId]
  );
  return active[0] ?? null;
}

/**
 * Gather a customer's calls into a journey and enqueue it for scoring (spec
 * §9). Returns the journey id, or null if there was nothing to score (no
 * calls with a transcript in the window, or no scorecard configured).
 *
 * Calls are included regardless of their own per-call scoring status —
 * under scoring_scope='sales_only' a call may never have been individually
 * scored (see jobs/processors/transcribe.ts), but it still has a transcript
 * and belongs in the journey.
 */
export async function assembleJourney(params: AssembleJourneyParams): Promise<string | null> {
  const { organizationId, customerId, scorecardId, triggerSource } = params;

  const scorecard = await resolveScorecard(organizationId, scorecardId);
  if (!scorecard) {
    console.warn(`[Journey] No active scorecard for org ${organizationId} — skipping journey for customer ${customerId}`);
    return null;
  }

  // Dedup #1: a journey for this customer is already pending/scoring. A retried
  // or re-fired trigger must not spawn a second scoring run — return the
  // in-flight one. (Also enforced at the DB level by the partial unique index
  // in migration 045, caught below, in case two triggers race this check.)
  const inFlight = await queryOne<{ id: string }>(
    `SELECT id FROM journeys
       WHERE organization_id = $1 AND customer_id = $2 AND status IN ('pending', 'scoring')
       ORDER BY created_at DESC LIMIT 1`,
    [organizationId, customerId]
  );
  if (inFlight) {
    console.log(`[Journey] Reusing in-flight journey ${inFlight.id} for customer ${customerId} (trigger=${triggerSource})`);
    return inFlight.id;
  }

  // Window: the CloudTalk connection's configured history window if the
  // customer's calls came in via that dialer, else the historical default.
  const dialerConn = await getDialerConnection(organizationId, 'cloudtalk');
  const windowDays = dialerConn?.history_window_days ?? DEFAULT_HISTORY_WINDOW_DAYS;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const calls = await query<Call>(
    `SELECT * FROM calls
       WHERE organization_id = $1
         AND customer_id = $2
         AND transcript_text IS NOT NULL
         AND COALESCE(call_date::timestamptz, created_at) >= $3
       ORDER BY COALESCE(call_date::timestamptz, created_at) ASC`,
    [organizationId, customerId, windowStart.toISOString()]
  );

  if (calls.length === 0) {
    console.warn(`[Journey] No transcribed calls in the last ${windowDays}d for customer ${customerId} — skipping`);
    return null;
  }
  const callIds = calls.map((c) => c.id).sort();

  // Dedup #2: the most recent scored journey already covers this exact set of
  // calls. A Zoho re-save with no new calls since is idempotent — return the
  // existing journey rather than re-scoring (double spend, double breaches,
  // double CRM push). A genuinely new call since the last sale falls through
  // to a fresh journey, which is the correct behaviour.
  const lastScored = await queryOne<{ id: string }>(
    `SELECT id FROM journeys
       WHERE organization_id = $1 AND customer_id = $2 AND status = 'scored'
       ORDER BY created_at DESC LIMIT 1`,
    [organizationId, customerId]
  );
  if (lastScored) {
    const prev = await query<{ call_id: string }>(
      'SELECT call_id FROM journey_calls WHERE journey_id = $1',
      [lastScored.id]
    );
    const prevIds = prev.map((r) => r.call_id).sort();
    if (prevIds.length === callIds.length && prevIds.every((id, i) => id === callIds[i])) {
      console.log(`[Journey] Journey ${lastScored.id} already scored this exact call set for customer ${customerId} — idempotent skip`);
      return lastScored.id;
    }
  }

  // Create the journey, its call links and the calls' back-references in one
  // transaction so a crash mid-assembly can't leave a partial/unscored journey
  // (M3). Enqueue only after commit.
  let journeyId: string;
  try {
    journeyId = await withTransaction(async (tx) => {
      const journeyRow = await tx.queryOne<{ id: string }>(
        `INSERT INTO journeys
           (organization_id, customer_id, scorecard_id, scorecard_version, window_start, window_end, trigger_source, status)
         VALUES ($1, $2, $3, $4, $5, now(), $6, 'pending')
         RETURNING id`,
        [organizationId, customerId, scorecard.id, scorecard.version, windowStart.toISOString(), triggerSource]
      );
      const id = journeyRow!.id;

      // The most recent call in the window is the wrap-up/close (spec §9's
      // interim fallback) — everything earlier is context.
      for (let i = 0; i < calls.length; i++) {
        const role = i === calls.length - 1 ? 'wrap_up' : 'context';
        await tx.query(
          'INSERT INTO journey_calls (journey_id, call_id, role) VALUES ($1, $2, $3)',
          [id, calls[i]!.id, role]
        );
      }
      await tx.query('UPDATE calls SET journey_id = $1 WHERE id = ANY($2::uuid[])', [
        id,
        calls.map((c) => c.id),
      ]);
      return id;
    });
  } catch (err) {
    // Lost the race on the in-flight unique index (migration 045) — another
    // trigger created the journey between our check and our insert. Return
    // theirs.
    if ((err as { code?: string }).code === '23505') {
      const winner = await queryOne<{ id: string }>(
        `SELECT id FROM journeys
           WHERE organization_id = $1 AND customer_id = $2 AND status IN ('pending', 'scoring')
           ORDER BY created_at DESC LIMIT 1`,
        [organizationId, customerId]
      );
      if (winner) {
        console.log(`[Journey] Raced on in-flight journey for customer ${customerId}, reusing ${winner.id}`);
        return winner.id;
      }
    }
    throw err;
  }

  await scoringQueue.add('score-journey', { journeyId }, { jobId: `score-journey-${journeyId}` });

  console.log(`[Journey] Assembled journey ${journeyId} for customer ${customerId}: ${calls.length} call(s), trigger=${triggerSource}`);
  return journeyId;
}
