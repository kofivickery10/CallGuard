import { query } from '../db/client.js';

// ============================================================
// The single definition of "stuck work".
//
// This used to live in two places that disagreed: the superadmin health check
// counted any call sitting in a pre-terminal status, while the repair sweep
// only ever re-enqueued calls at 'uploaded'. The result was a health panel
// reporting a permanent, unfixable backlog — 26 "stuck" calls of which 25 were
// resting exactly where they should be, and 1 was genuinely stranded but in a
// status the sweep never looked at.
//
// Both callers now use the functions below, so what the panel reports is
// precisely what the sweep will act on: the count drops to zero after a repair,
// or it is a real fault.
//
// The states that are NOT stuck, and why:
//
//  * 'captured' — metadata-only, no audio fetched. Under sales_only ingestion
//    (routes/ingestion.ts) audio is pulled on demand when the customer
//    converts, so a captured call may rest here forever by design. It is only
//    stuck when a live journey is waiting on its audio. Hydrating the rest
//    would spend money on, and store audio for, calls we deliberately never
//    fetched.
//
//  * 'transcribed' in a deferring org — under scoring_scope='sales_only' with a
//    usable Zoho sale trigger, per-call scoring is deliberately deferred and
//    the sale is scored as a journey instead (jobs/processors/transcribe.ts).
//    'transcribed' is that call's terminal resting state. Note the trigger
//    half of the test: an org with no usable trigger does NOT defer, so for
//    them a transcribed call really is waiting on a lost score job.
//
//  * anything linked to a journey — journey-linked calls are never scored on
//    their own. If work is outstanding it belongs to the journey, and is
//    reported there, so counting the call too would double-report it.
// ============================================================

/**
 * Grace period for states that mean "the row was committed but its job was
 * never queued" (a Redis blip between the DB write and queue.add). Nothing is
 * in flight, so re-enqueuing immediately after the grace period is free of
 * double-processing risk.
 */
export const STUCK_QUEUED_AFTER_MINUTES = 20;

/**
 * Grace period for states that mean "a job started and never came back"
 * ('transcribing', 'scoring', a journey mid-score). Longer, because a
 * re-enqueue here spends money twice if the original job is merely slow rather
 * than dead — neither processor short-circuits when the work is already done.
 * Comfortably beyond the worst realistic Deepgram + cleanup or scoring run.
 */
export const STUCK_INFLIGHT_AFTER_MINUTES = 60;

export type StuckCallAction = 'hydrate' | 'transcribe' | 'score';

export interface StuckCall {
  id: string;
  status: string;
  organization_id: string;
  updated_at: string;
  action: StuckCallAction;
}

export interface StuckJourney {
  id: string;
  status: string;
  updated_at: string;
  /**
   * 'hydrate' — linked calls still need audio; their hydrate job was lost.
   * 'score'   — every linked call is terminal, so the score-journey enqueue was
   *             lost.
   * 'wait'    — a linked call is legitimately mid-flight; its own completion
   *             will drive scoring. Not stuck, not reported, not touched.
   */
  action: 'hydrate' | 'score' | 'wait';
  captured_call_ids: string[];
}

// An org whose calls rest at 'transcribed' rather than being scored per-call.
// Mirrors getScoringSettings + hasUsableSaleTrigger (services/tenant-settings.ts)
// in SQL so one query can classify every call.
const DEFERRING_ORGS = `
  SELECT o.id FROM organizations o
   WHERE o.scoring_scope = 'sales_only'
     AND EXISTS (
       SELECT 1 FROM zoho_connections z
        WHERE z.organization_id = o.id
          AND z.status = 'active'
          AND (z.inbound_secret_encrypted IS NOT NULL OR z.sale_trigger_enabled = true)
     )
`;

// Journey membership is recorded both on calls.journey_id (set at hydration)
// and in journey_calls (set when the journey is assembled). Either counts.
const LINKED_TO_ANY_JOURNEY = `
  (c.journey_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM journey_calls jc WHERE jc.call_id = c.id))
`;

const NEEDED_BY_LIVE_JOURNEY = `
  EXISTS (
    SELECT 1 FROM journey_calls jc
      JOIN journeys j ON j.id = jc.journey_id
     WHERE jc.call_id = c.id AND j.status IN ('pending', 'scoring')
  )
`;

/**
 * Calls that are genuinely stranded, each tagged with the job that would
 * unstick it. See the header for what is deliberately excluded.
 */
export async function findStuckCalls(): Promise<StuckCall[]> {
  return query<StuckCall>(
    `SELECT c.id, c.status, c.organization_id, c.updated_at,
            CASE c.status
              WHEN 'captured'   THEN 'hydrate'
              WHEN 'uploaded'   THEN 'transcribe'
              WHEN 'transcribing' THEN 'transcribe'
              ELSE 'score'
            END AS action
       FROM calls c
      WHERE
        (c.status = 'captured'
          AND c.updated_at < now() - interval '1 minute' * $1
          AND ${NEEDED_BY_LIVE_JOURNEY})
        OR (c.status = 'uploaded'
          AND c.updated_at < now() - interval '1 minute' * $1)
        OR (c.status = 'transcribing'
          AND c.updated_at < now() - interval '1 minute' * $2)
        OR (c.status = 'transcribed'
          AND c.updated_at < now() - interval '1 minute' * $1
          AND NOT ${LINKED_TO_ANY_JOURNEY}
          AND c.organization_id NOT IN (${DEFERRING_ORGS}))
        -- 'scoring' means per-call scoring already started, so finishing it is
        -- right regardless of the org's current scope.
        OR (c.status = 'scoring'
          AND c.updated_at < now() - interval '1 minute' * $2
          AND NOT ${LINKED_TO_ANY_JOURNEY})
      ORDER BY c.updated_at ASC`,
    [STUCK_QUEUED_AFTER_MINUTES, STUCK_INFLIGHT_AFTER_MINUTES]
  );
}

/**
 * What a past-its-grace journey is actually waiting on, from the states of its
 * linked calls. A 'pending' journey may perfectly well be waiting for its
 * captured calls to hydrate and transcribe — deciding that from the journey row
 * alone would re-enqueue work that is already in flight.
 */
export function classifyJourneyAction(linkedStatuses: string[]): StuckJourney['action'] {
  if (linkedStatuses.includes('captured')) return 'hydrate';
  if (linkedStatuses.some((s) => s === 'uploaded' || s === 'transcribing')) return 'wait';
  // Every linked call is terminal, so the journey is genuinely ready and its
  // score-journey enqueue was lost.
  return 'score';
}

/**
 * Journeys past their grace period, classified by what they are actually
 * waiting on. Callers should ignore action='wait' — those are mid-flight, not
 * stuck.
 */
export async function findStuckJourneys(): Promise<StuckJourney[]> {
  const candidates = await query<{ id: string; status: string; updated_at: string }>(
    `SELECT id, status, updated_at FROM journeys
      WHERE (status = 'pending' AND updated_at < now() - interval '1 minute' * $1)
         OR (status = 'scoring' AND updated_at < now() - interval '1 minute' * $2)
      ORDER BY updated_at ASC`,
    [STUCK_QUEUED_AFTER_MINUTES, STUCK_INFLIGHT_AFTER_MINUTES]
  );

  const out: StuckJourney[] = [];
  for (const journey of candidates) {
    const linked = await query<{ id: string; status: string }>(
      `SELECT c.id, c.status FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1`,
      [journey.id]
    );
    out.push({
      ...journey,
      action: classifyJourneyAction(linked.map((c) => c.status)),
      captured_call_ids: linked.filter((c) => c.status === 'captured').map((c) => c.id),
    });
  }
  return out;
}

export interface StuckSummary {
  calls: number;
  journeys: number;
  /** Per-status counts, for a panel that can say *what* is stuck, not just how many. */
  by_status: Record<string, number>;
  oldest_at: string | null;
}

/**
 * Rolls the two result sets into what the panel shows. Journeys the sweep would
 * skip are excluded from every figure — reporting work nobody will act on is the
 * defect this whole module exists to fix.
 */
export function buildStuckSummary(
  calls: Pick<StuckCall, 'status' | 'updated_at'>[],
  journeys: Pick<StuckJourney, 'status' | 'updated_at' | 'action'>[]
): StuckSummary {
  const actionable = journeys.filter((j) => j.action !== 'wait');

  const by_status: Record<string, number> = {};
  for (const c of calls) by_status[c.status] = (by_status[c.status] ?? 0) + 1;
  for (const j of actionable) {
    const key = `journey:${j.status}`;
    by_status[key] = (by_status[key] ?? 0) + 1;
  }

  const timestamps = [...calls, ...actionable]
    .map((r) => new Date(r.updated_at).getTime())
    .filter((t) => Number.isFinite(t));

  return {
    calls: calls.length,
    journeys: actionable.length,
    by_status,
    oldest_at: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
  };
}

/**
 * Health-panel view of the same two queries the repair sweep runs, so the
 * reported number and the repairable number can never drift apart.
 */
export async function summariseStuckWork(): Promise<StuckSummary> {
  const [calls, journeys] = await Promise.all([findStuckCalls(), findStuckJourneys()]);
  return buildStuckSummary(calls, journeys);
}
