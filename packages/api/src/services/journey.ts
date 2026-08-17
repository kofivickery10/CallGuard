import { query, queryOne, withTransaction } from '../db/client.js';
import { getDialerConnection, getJourneyWindowDays } from './tenant-settings.js';
import { scoringQueue, ingestionQueue } from '../jobs/queue.js';
import type { ResolvedProduct } from './product-resolution.js';
import type { RawCoverageSignal } from './scoring.js';
import type { JourneyTriggerSource, Scorecard, Call, ProductSource, JourneyCoverage } from '@callguard/shared';

const DEFAULT_HISTORY_WINDOW_DAYS = 30;

interface AssembleJourneyParams {
  organizationId: string;
  customerId: string;
  scorecardId?: string | null;
  triggerSource: JourneyTriggerSource;
  // Carried from the Zoho sale trigger for the QA write-back (services/zoho.ts):
  // the sold-customer record id (QA record links to it) and the client name
  // (required QA field). Null for non-Zoho triggers (e.g. manual sale flag).
  zohoRecordId?: string | null;
  clientName?: string | null;
  // Products the sale covered, resolved from the CRM at assembly (spec:
  // product-aware scoring). Empty when unresolved — score-journey then infers
  // them from the transcript. Only written when the journey is freshly created.
  products?: ResolvedProduct[];
  // How `products` was determined ('crm'), or null when left for the transcript
  // fallback at score time.
  productSource?: ProductSource | null;
  // The sale's policy stage as the CRM reported it (Zoho Deals' "Stage"),
  // resolved at assembly. score-journey maps this to a scoring branch via
  // branch_config.crm_values — the authoritative signal for on-risk vs
  // referred, in place of matching phrases in the transcript. Null when
  // unavailable; the keyword fallback then applies (migration 071).
  crmStage?: string | null;
  // Scalar snapshot of the sale-trigger payload — persisted so capture-form
  // resolution rules (crm_field) can be evaluated at scoring time, when the
  // webhook payload is long gone. Null for non-CRM triggers.
  triggerContext?: Record<string, string> | null;
  // Mend the customer's existing sale rather than opening a second one.
  //
  // For the backfill (scripts/backfill-journeys.ts) the recovered calls belong
  // to a sale that has already been scored — they were missing only because
  // they predate the tenant's dialler webhook going live. Creating a fresh
  // journey would leave the tenant looking at two entries for one customer,
  // one scored on partial evidence, with no indication which to believe.
  //
  // NOT the default, and deliberately not applied to the Zoho sale trigger: a
  // customer who buys a second policy months later is a genuinely new sale, and
  // folding that into the first would merge two compliance records into one.
  extendExisting?: boolean;
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
  const { organizationId, customerId, scorecardId, triggerSource, zohoRecordId, clientName, products = [], productSource = null, crmStage = null, triggerContext = null, extendExisting = false } = params;

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

  // Window: how far back to gather the calls that make up this sale, in
  // precedence order —
  //   1. the org's own journey_window_days (migration 072), the only setting
  //      available to a tenant with no dialler connection (manual uploads,
  //      Teams appointment recordings, SFTP drops, a dialler we don't integrate
  //      with), and the one to use when a sector's cases simply run longer than
  //      a month: a mortgage case spans fact find → recommendation → completion
  //      over weeks, and too short a window drops precisely the calls carrying
  //      the suitability and disclosure checkpoints;
  //   2. the CloudTalk connection's configured history window, for tenants whose
  //      calls arrive that way;
  //   3. the historical 30-day default.
  const [orgWindow, dialerConn] = await Promise.all([
    getJourneyWindowDays(organizationId),
    getDialerConnection(organizationId, 'cloudtalk'),
  ]);
  const windowDays =
    orgWindow ?? dialerConn?.history_window_days ?? DEFAULT_HISTORY_WINDOW_DAYS;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Include 'captured' calls (metadata-only, no transcript yet) — under the
  // capture model they are hydrated + transcribed on demand below. Excludes
  // only calls that already failed permanently. score-journey later scores
  // whichever ended up with a transcript.
  //
  // Sale scoping: a call already claimed by a DIFFERENT sale's journey is
  // excluded, otherwise a second Zoho sale trigger for the same customer
  // inside the window would re-pull the first sale's calls, mix both sales'
  // evidence onto one record, and yank the calls out from under the (possibly
  // already-scored) first journey when the reassignment below runs. This must
  // stay narrow: re-running for the SAME sale (zohoRecordId unchanged) has to
  // keep finding its own calls, or the idempotency below breaks. So the
  // exclusion only fires when this trigger carries a sale id (zohoRecordId —
  // the Zoho "Customers Sold" record, the only sale/deal identifier a journey
  // is linked back to; see migration 054) and the call's journey belongs to a
  // *different* one. A call with no journey yet, or one on this same sale's
  // journey, is always eligible. Non-Zoho triggers (manual re-score,
  // sale_flagged upload, backfill) carry no sale id at all, so this predicate
  // is a no-op for them and they keep the pre-existing (customer + window)
  // behaviour, unchanged.
  //
  // One conversation can legitimately cover two products sold as two sales.
  // Under this scoping those calls stay with whichever sale claimed them
  // first — they are not split or duplicated across both journeys. There is
  // no existing mechanism in this file to flag that overlap for a human; it
  // is simply silent (the second sale scores on whatever calls remain, or
  // none — see the empty-set handling below).
  const calls = await query<Call>(
    `SELECT * FROM calls
       WHERE organization_id = $1
         AND customer_id = $2
         AND status <> 'failed'
         AND COALESCE(call_date::timestamptz, created_at) >= $3
         AND (
           $4::text IS NULL
           OR journey_id IS NULL
           OR journey_id IN (SELECT id FROM journeys WHERE organization_id = $1 AND zoho_record_id = $4)
         )
       ORDER BY COALESCE(call_date::timestamptz, created_at) ASC`,
    [organizationId, customerId, windowStart.toISOString(), zohoRecordId ?? null]
  );

  if (calls.length === 0) {
    // Once scoped to this sale, a customer whose only calls in the window
    // already belong to a different sale's journey legitimately has none of
    // their own (the shared-call case above). Do not stand up a journey — and
    // so never score a compliance verdict — on zero evidence; skip exactly as
    // the "no calls at all" case below does, just with a reason that says so,
    // for anyone triaging the worker log.
    if (zohoRecordId) {
      const claimedElsewhere = await queryOne<{ n: number }>(
        `SELECT count(*)::int AS n FROM calls
           WHERE organization_id = $1
             AND customer_id = $2
             AND status <> 'failed'
             AND COALESCE(call_date::timestamptz, created_at) >= $3
             AND journey_id IS NOT NULL`,
        [organizationId, customerId, windowStart.toISOString()]
      );
      if (claimedElsewhere && Number(claimedElsewhere.n) > 0) {
        console.warn(
          `[Journey] Every call in the last ${windowDays}d for customer ${customerId} already belongs to a ` +
            `different sale's journey — skipping (sale=${zohoRecordId})`
        );
        return null;
      }
    }
    console.warn(`[Journey] No calls in the last ${windowDays}d for customer ${customerId} — skipping`);
    return null;
  }
  const callIds = calls.map((c) => c.id).sort();

  // Mend-in-place: attach any calls the customer's existing sale is missing and
  // re-score it, instead of standing up a second journey beside it. See
  // `extendExisting` on the params for why this is opt-in.
  //
  // Runs before the idempotency check below because the two answer different
  // questions: that one asks "has this exact call set already been scored", this
  // one asks "is there a sale here that should absorb these calls".
  if (extendExisting) {
    const target = await queryOne<{ id: string; window_start: string | null }>(
      `SELECT id, window_start FROM journeys
         WHERE organization_id = $1 AND customer_id = $2
           AND status IN ('scored', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
      [organizationId, customerId]
    );
    if (target) {
      const linked = await query<{ call_id: string }>(
        'SELECT call_id FROM journey_calls WHERE journey_id = $1',
        [target.id]
      );
      const linkedIds = new Set(linked.map((r) => r.call_id));
      const missing = calls.filter((c) => !linkedIds.has(c.id));
      if (missing.length === 0) {
        console.log(`[Journey] ${target.id} already covers every call for customer ${customerId} — nothing to mend`);
        return target.id;
      }

      await withTransaction(async (tx) => {
        for (const c of missing) {
          await tx.query(
            "INSERT INTO journey_calls (journey_id, call_id, role) VALUES ($1, $2, 'context') ON CONFLICT DO NOTHING",
            [target.id, c.id]
          );
        }
        await tx.query('UPDATE calls SET journey_id = $1 WHERE id = ANY($2::uuid[])', [
          target.id,
          missing.map((c) => c.id),
        ]);
        // Recompute wrap-up across the whole set: a recovered call can be newer
        // than the previous closing call, and the wrap-up drives both the QA
        // write-back's agent and the "who closed this sale" attribution.
        await tx.query(
          `UPDATE journey_calls SET role = 'context' WHERE journey_id = $1`,
          [target.id]
        );
        await tx.query(
          `UPDATE journey_calls SET role = 'wrap_up'
             WHERE journey_id = $1
               AND call_id = (
                 SELECT c.id FROM journey_calls jc JOIN calls c ON c.id = jc.call_id
                  WHERE jc.journey_id = $1
                  ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) DESC
                  LIMIT 1)`,
          [target.id]
        );
        // Widen the window to cover a recovered call older than the original
        // assembly, so the stored window still describes what was scored. The
        // previous score is deliberately left in place: it stays visible while
        // the re-score runs, and score-journey records the move in
        // journey_score_runs (migration 074).
        await tx.query(
          `UPDATE journeys
              SET status = 'pending',
                  window_start = LEAST(window_start, $2::timestamptz),
                  updated_at = now()
            WHERE id = $1`,
          [target.id, windowStart.toISOString()]
        );
      });

      const toHydrateExisting = missing.filter((c) => c.status === 'captured');
      for (const c of toHydrateExisting) {
        await ingestionQueue.add(
          'hydrate-call',
          { callId: c.id },
          { jobId: `hydrate-${c.id}`, attempts: 6, backoff: { type: 'exponential', delay: 60_000 } }
        );
      }
      if (toHydrateExisting.length === 0) {
        await scoringQueue.add(
          'score-journey',
          { journeyId: target.id, triggerSource: 'backfill' },
          { jobId: `score-journey-${target.id}-${missing.length}` }
        );
      }
      console.log(
        `[Journey] Mended journey ${target.id} for customer ${customerId}: +${missing.length} recovered call(s), ` +
          `${toHydrateExisting.length} hydrating, re-scoring ${toHydrateExisting.length ? 'deferred' : 'now'}`
      );
      return target.id;
    }
  }

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
           (organization_id, customer_id, scorecard_id, scorecard_version, window_start, window_end, trigger_source, status, zoho_record_id, client_name, product_source, crm_stage, trigger_context)
         VALUES ($1, $2, $3, $4, $5, now(), $6, 'pending', $7, $8, $9, $10, $11)
         RETURNING id`,
        [organizationId, customerId, scorecard.id, scorecard.version, windowStart.toISOString(), triggerSource, zohoRecordId ?? null, clientName ?? null, productSource, crmStage, triggerContext ? JSON.stringify(triggerContext) : null]
      );
      const id = journeyRow!.id;

      // Attach the products resolved from the CRM. Left empty (and
      // product_source null) when unresolved — score-journey infers them from
      // the transcript when it runs.
      for (const p of products) {
        await tx.query(
          `INSERT INTO journey_products (journey_id, product_id, product_name, source)
           VALUES ($1, $2, $3, 'crm')`,
          [id, p.product_id, p.product_name]
        );
      }

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

  // Calls captured as metadata-only need their audio fetched + transcribed
  // before the journey can be scored; kick off hydration for each and defer
  // scoring. When the last one finishes transcribing, maybeScoreJourneyWhenReady
  // (called from jobs/processors/transcribe.ts) enqueues the score-journey job.
  // If nothing needs hydrating (every call already has a transcript — the
  // manual-flag path, or a non-capture org), score straight away.
  const toHydrate = calls.filter((c) => c.status === 'captured');
  if (toHydrate.length > 0) {
    for (const c of toHydrate) {
      await ingestionQueue.add(
        'hydrate-call',
        { callId: c.id },
        {
          jobId: `hydrate-${c.id}`,
          // The recording can still be processing on CloudTalk's side; give the
          // fetch generous retry headroom rather than failing the whole journey.
          attempts: 6,
          backoff: { type: 'exponential', delay: 60_000 },
        }
      );
    }
    console.log(
      `[Journey] Assembled journey ${journeyId} for customer ${customerId}: ${calls.length} call(s), ` +
        `hydrating ${toHydrate.length}, scoring deferred (trigger=${triggerSource})`
    );
  } else {
    await scoringQueue.add('score-journey', { journeyId }, { jobId: `score-journey-${journeyId}` });
    console.log(
      `[Journey] Assembled journey ${journeyId} for customer ${customerId}: ${calls.length} call(s), scoring now (trigger=${triggerSource})`
    );
  }
  return journeyId;
}

/**
 * Enqueue journey scoring once every call linked to a pending journey has
 * reached a terminal transcription state. Called from the transcribe processor
 * as each hydrated call finishes. No-op unless the journey is still 'pending'
 * and nothing is left mid-flight, so it fires exactly once per journey (the
 * fixed score-journey jobId also dedupes a race between two calls finishing
 * together).
 */
export async function maybeScoreJourneyWhenReady(journeyId: string): Promise<void> {
  const journey = await queryOne<{ status: string }>(
    'SELECT status FROM journeys WHERE id = $1',
    [journeyId]
  );
  if (!journey || journey.status !== 'pending') return;

  const pending = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM journey_calls jc
       JOIN calls c ON c.id = jc.call_id
      WHERE jc.journey_id = $1
        AND c.status NOT IN ('transcribed', 'scored', 'failed', 'skipped')`,
    [journeyId]
  );
  if (pending && Number(pending.n) === 0) {
    await scoringQueue.add('score-journey', { journeyId }, { jobId: `score-journey-${journeyId}` });
    console.log(`[Journey] ${journeyId}: all calls transcribed — enqueued scoring`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Partial-journey coverage detection (docs/partial-journey-detection.md).
//
// Phase 1 only (spec §6): detect and persist on every new scoring run, do
// not act — nothing downstream (breach caveats, UI, aggregates, Zoho
// write-back) changes yet. That is deliberate: the spec gates those on
// measuring the false-positive rate first, and announcing before enabling.
// ─────────────────────────────────────────────────────────────────────────

/** The model's own judgement of whether a journey's evidence looks complete (spec §3.1). */
export interface CoverageModelSignal {
  startsMidConversation: boolean;
  missingStages: string[];
  rationale: string;
}

/**
 * Turn the model's raw coverage judgement (spec §3.1) into a validated,
 * defaulted CoverageModelSignal.
 *
 * The spec asks for this as one extra object on the main scoring pass's
 * existing submit_scores tool schema (services/scoring.ts), billed once per
 * run rather than a second call — scoreTranscript requests it whenever
 * journeyMode is true, and scoreTranscriptConsensus resolves the majority
 * verdict across consensus runs into a single winning raw object (see
 * ConsensusCoverage there). This function's only job is defending against
 * the model omitting or malforming a field, exactly as it did when this used
 * to be a live API response of its own — never throws, since coverage
 * assessment is best-effort and must not fail a journey score.
 */
export function assessJourneyCoverage(raw: RawCoverageSignal | undefined): CoverageModelSignal {
  return {
    startsMidConversation: raw?.starts_mid_conversation === true,
    missingStages: Array.isArray(raw?.missing_stages)
      ? raw.missing_stages.filter((s): s is string => typeof s === 'string')
      : [],
    rationale: typeof raw?.rationale === 'string' ? raw.rationale.slice(0, 2000) : '',
  };
}

/** Free, computed corroboration of the model's coverage judgement (spec §3.2). Never sufficient alone. */
export interface StructuralCorroboration {
  agrees: boolean;
  reasons: Array<'front_fail_back_pass' | 'no_prior_history' | 'single_call_below_median'>;
}

// A tenant needs at least this many days of call history before "this
// customer's first call is also the org's earliest" counts as evidence of a
// missing prior call, rather than the tenant simply being new (spec §3.2:
// "on a tenant whose capture has been live materially longer").
const MATERIALLY_LONGER_CAPTURE_DAYS = 14;

export async function computeStructuralCorroboration(params: {
  organizationId: string;
  journeyId: string;
  customerId: string;
  // The earliest call's created_at (when CallGuard first saw it), not
  // call_date — the Jimara case compares record-creation timestamps
  // ("customer created 09:52:16, its only call created 09:52:16").
  earliestCallCreatedAt: string;
  callCount: number;
  itemResults: Array<{ sortOrder: number; pass: boolean }>;
}): Promise<StructuralCorroboration> {
  const reasons: StructuralCorroboration['reasons'] = [];

  // Front-fail / back-pass shape: every checkpoint in the scorecard's
  // opening half failed while the closing half largely passed — the Jimara
  // shape exactly (every front-of-sale item at 0, every back-of-sale item
  // passing). Requires a reasonably sized scorecard so a 2-item split isn't
  // read as a shape.
  const sorted = [...params.itemResults].sort((a, b) => a.sortOrder - b.sortOrder);
  if (sorted.length >= 6) {
    const mid = Math.floor(sorted.length / 2);
    const front = sorted.slice(0, mid);
    const back = sorted.slice(mid);
    const frontFailRate = front.filter((i) => !i.pass).length / front.length;
    const backPassRate = back.filter((i) => i.pass).length / back.length;
    if (frontFailRate >= 0.8 && backPassRate >= 0.8) {
      reasons.push('front_fail_back_pass');
    }
  }

  // No prior history: this customer's record was created at the same moment
  // as their only call in the journey, on a tenant whose capture has been
  // live materially longer.
  const customer = await queryOne<{ first_seen_at: string }>(
    'SELECT first_seen_at FROM customers WHERE id = $1',
    [params.customerId]
  );
  if (customer) {
    const firstSeen = new Date(customer.first_seen_at).getTime();
    const earliestCall = new Date(params.earliestCallCreatedAt).getTime();
    const sameInstant = Math.abs(firstSeen - earliestCall) < 60_000;
    if (sameInstant) {
      const orgHistory = await queryOne<{ earliest: string | null }>(
        'SELECT min(created_at)::text AS earliest FROM calls WHERE organization_id = $1',
        [params.organizationId]
      );
      if (orgHistory?.earliest) {
        const daysOfHistory = (earliestCall - new Date(orgHistory.earliest).getTime()) / (24 * 60 * 60 * 1000);
        if (daysOfHistory >= MATERIALLY_LONGER_CAPTURE_DAYS) {
          reasons.push('no_prior_history');
        }
      }
    }
  }

  // Single-call sale where the tenant's median sale spans more.
  if (params.callCount === 1) {
    const median = await queryOne<{ median: string | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY calls_scored)::text AS median
         FROM journey_score_runs
        WHERE organization_id = $1 AND journey_id <> $2 AND calls_scored IS NOT NULL`,
      [params.organizationId, params.journeyId]
    );
    if (median?.median && Number(median.median) > 1) {
      reasons.push('single_call_below_median');
    }
  }

  return { agrees: reasons.length > 0, reasons };
}

/**
 * Combine the model's declared judgement with the structural check (spec
 * §3.3's table). Crucially, structure agreeing on its own (model says
 * complete) never produces 'partial' — that is the adviser-skipped-
 * everything case, which must keep scoring at face value rather than being
 * waved away as a coverage gap.
 */
export function resolveCoverage(
  modelSignal: CoverageModelSignal,
  structural: StructuralCorroboration
): { coverage: JourneyCoverage; rationale: string } {
  if (modelSignal.startsMidConversation) {
    const rationale = structural.agrees
      ? modelSignal.rationale
      : `${modelSignal.rationale} (structural signals do not corroborate this — flagged for review)`.trim();
    return { coverage: 'partial', rationale };
  }
  if (structural.agrees) {
    return {
      coverage: 'unknown',
      rationale: `Model reported the journey complete, but structural signals (${structural.reasons.join(', ')}) suggest otherwise — logged for tuning.`,
    };
  }
  return { coverage: 'complete', rationale: modelSignal.rationale };
}
