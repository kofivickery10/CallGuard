import { query, queryOne } from '../db/client.js';
import { scoringQueue } from '../jobs/queue.js';
import type { CaptureForm, CaptureFormField, CaptureFormRule } from '@callguard/shared';

// ============================================================
// Data Capture run orchestration: which form applies, and starting runs.
// Deliberately separate from scoring — a capture failure never blocks or
// taints a score, and capture only runs for orgs with capture_enabled.
// ============================================================

export async function isCaptureEnabled(organizationId: string): Promise<boolean> {
  const row = await queryOne<{ capture_enabled: boolean }>(
    'SELECT capture_enabled FROM organizations WHERE id = $1',
    [organizationId]
  );
  return row?.capture_enabled === true;
}

export async function getCaptureForm(
  organizationId: string,
  formId: string
): Promise<(CaptureForm & { fields: CaptureFormField[] }) | null> {
  const form = await queryOne<CaptureForm>(
    'SELECT * FROM capture_forms WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL',
    [formId, organizationId]
  );
  if (!form) return null;
  const fields = await query<CaptureFormField>(
    'SELECT * FROM capture_form_fields WHERE form_id = $1 AND archived_at IS NULL ORDER BY sort_order',
    [form.id]
  );
  return { ...form, fields };
}

/**
 * Which capture form applies. Resolution order:
 *  1. An explicit pick (journey.capture_form_id, or the manual-run route).
 *  2. Active crm_field rules in priority order, matched (case-insensitive
 *     substring) against the provided context values — e.g. the CRM
 *     sale-trigger payload. First match wins.
 *  3. If the org has exactly ONE active form, use it — the common small-tenant
 *     case where rules are unnecessary ceremony.
 *  4. null — the run is created as needs_form and a human picks in the UI.
 *     Never guess.
 */
export async function resolveCaptureFormId(
  organizationId: string,
  contextValues: Record<string, string> | null = null
): Promise<string | null> {
  if (contextValues && Object.keys(contextValues).length > 0) {
    const rules = await query<CaptureFormRule>(
      `SELECT * FROM capture_form_rules
        WHERE organization_id = $1 AND is_active AND source = 'crm_field'
        ORDER BY priority DESC, created_at ASC`,
      [organizationId]
    );
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(contextValues)) lowered[k.toLowerCase()] = v.toLowerCase();
    for (const rule of rules) {
      if (!rule.source_key || !rule.match_value) continue;
      const value = lowered[rule.source_key.toLowerCase()];
      if (value && value.includes(rule.match_value.toLowerCase())) return rule.form_id;
    }
  }

  const active = await query<{ id: string }>(
    'SELECT id FROM capture_forms WHERE organization_id = $1 AND is_active AND archived_at IS NULL LIMIT 2',
    [organizationId]
  );
  if (active.length === 1) return active[0]!.id;
  return null;
}

/**
 * Create (or reuse) a capture run for a scored journey and enqueue the
 * extraction job. Idempotent: an existing pending/running/completed run for
 * the same journey + form version is left alone (migration 060's partial
 * unique indexes are the backstop). Fire-and-forget from scoring — errors
 * are logged, never thrown into the scoring path.
 */
export async function maybeStartJourneyCapture(
  organizationId: string,
  journeyId: string
): Promise<void> {
  try {
    if (!(await isCaptureEnabled(organizationId))) return;

    const journey = await queryOne<{
      capture_form_id: string | null;
      trigger_context: Record<string, string> | null;
    }>(
      'SELECT capture_form_id, trigger_context FROM journeys WHERE id = $1 AND organization_id = $2',
      [journeyId, organizationId]
    );
    if (!journey) return;

    // Resolution order: explicit pick on the journey, then the tenant's
    // crm_field rules evaluated against the sale-trigger payload snapshot,
    // then the single-active-form default (inside resolveCaptureFormId).
    const formId =
      journey.capture_form_id ??
      (await resolveCaptureFormId(organizationId, journey.trigger_context));

    if (!formId) {
      // No form resolvable — record the gap so it surfaces in the UI queue
      // rather than silently not capturing. needs_form rows carry no form
      // (form_id nullable, migration 061); the partial unique index there
      // enforces one needs_form row per journey across re-scores.
      await query(
        `INSERT INTO capture_runs (organization_id, journey_id, status)
         VALUES ($1, $2, 'needs_form')
         ON CONFLICT DO NOTHING`,
        [organizationId, journeyId]
      );
      console.log(`[Capture] Journey ${journeyId}: no capture form resolvable — queued as needs_form`);
      return;
    }

    const form = await getCaptureForm(organizationId, formId);
    if (!form || form.fields.length === 0) {
      console.warn(`[Capture] Journey ${journeyId}: form ${formId} missing or has no fields — skipping`);
      return;
    }

    const inserted = await query<{ id: string }>(
      `INSERT INTO capture_runs (organization_id, journey_id, form_id, form_version, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [organizationId, journeyId, form.id, form.version]
    );
    const runId = inserted[0]?.id;
    if (!runId) return; // already ran / in flight for this form version

    // A form resolved — clear any stale needs_form marker from an earlier
    // scoring pass so the attention queue doesn't show a solved gap.
    await query(
      `DELETE FROM capture_runs WHERE journey_id = $1 AND status = 'needs_form'`,
      [journeyId]
    );

    if (journey.capture_form_id !== form.id) {
      await query('UPDATE journeys SET capture_form_id = $1, updated_at = now() WHERE id = $2', [form.id, journeyId]);
    }

    await scoringQueue.add('capture', { runId }, { jobId: `capture-${runId}` });
    console.log(`[Capture] Journey ${journeyId}: capture run ${runId} enqueued (form "${form.name}" v${form.version})`);
  } catch (err) {
    console.error(`[Capture] Failed to start capture for journey ${journeyId}:`, (err as Error).message);
  }
}

/**
 * Per-call variant for orgs that score every call individually.
 */
export async function maybeStartCallCapture(
  organizationId: string,
  callId: string
): Promise<void> {
  try {
    if (!(await isCaptureEnabled(organizationId))) return;

    const formId = await resolveCaptureFormId(organizationId);
    if (!formId) return; // per-call flow: no needs_form queueing, forms must resolve

    const form = await getCaptureForm(organizationId, formId);
    if (!form || form.fields.length === 0) return;

    const inserted = await query<{ id: string }>(
      `INSERT INTO capture_runs (organization_id, call_id, form_id, form_version, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [organizationId, callId, form.id, form.version]
    );
    const runId = inserted[0]?.id;
    if (!runId) return;

    await scoringQueue.add('capture', { runId }, { jobId: `capture-${runId}` });
    console.log(`[Capture] Call ${callId}: capture run ${runId} enqueued (form "${form.name}" v${form.version})`);
  } catch (err) {
    console.error(`[Capture] Failed to start capture for call ${callId}:`, (err as Error).message);
  }
}
