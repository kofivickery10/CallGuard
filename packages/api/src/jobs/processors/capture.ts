import { Job } from 'bullmq';
import { query, queryOne, withTransaction } from '../../db/client.js';
import { captureFromTranscript, sanitizeAnswers } from '../../services/capture.js';
import { getCaptureForm } from '../../services/capture-runs.js';
import { recordUsage } from '../../services/usage.js';
import { evaluateCaptureRunAlerts } from '../../services/alert-evaluator.js';
import type { CaptureRun } from '@callguard/shared';

// ============================================================
// Data Capture extraction job ('capture' on the scoring queue). One run =
// one form extracted over one journey's combined transcript (or one call).
// Runs strictly AFTER scoring and entirely independently of it — a capture
// failure marks the run failed, never the journey/call.
// ============================================================

interface TranscriptCall {
  id: string;
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  transcript_text: string | null;
}

export async function processCapture(job: Job<{ runId: string }>) {
  const { runId } = job.data;
  console.log(`[Capture] Processing run ${runId}`);

  const run = await queryOne<CaptureRun>('SELECT * FROM capture_runs WHERE id = $1', [runId]);
  if (!run) throw new Error(`Capture run ${runId} not found`);
  if (run.status === 'completed') {
    console.log(`[Capture] Run ${runId} already completed — skipping`);
    return;
  }

  await query(
    "UPDATE capture_runs SET status = 'running', started_at = now() WHERE id = $1",
    [runId]
  );

  try {
    const form = await getCaptureForm(run.organization_id, run.form_id);
    if (!form) throw new Error(`Capture form ${run.form_id} not found in org ${run.organization_id}`);
    if (form.fields.length === 0) throw new Error(`Capture form ${run.form_id} has no fields`);

    // Assemble the transcript: journey mode uses the same call-delimited
    // combined format (and [Call N] evidence attribution) as journey scoring.
    let calls: TranscriptCall[];
    const journeyMode = run.journey_id !== null;
    if (run.journey_id) {
      calls = await query<TranscriptCall>(
        `SELECT c.id, c.call_date, c.created_at, c.agent_name, c.transcript_text
           FROM journey_calls jc
           JOIN calls c ON c.id = jc.call_id
          WHERE jc.journey_id = $1
          ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
        [run.journey_id]
      );
    } else {
      const call = await queryOne<TranscriptCall>(
        `SELECT id, call_date, created_at, agent_name, transcript_text
           FROM calls WHERE id = $1 AND organization_id = $2`,
        [run.call_id, run.organization_id]
      );
      calls = call ? [call] : [];
    }

    const withTranscript = calls.filter((c) => c.transcript_text);
    if (withTranscript.length === 0) throw new Error('No transcribed calls available for capture');

    const transcript = journeyMode
      ? withTranscript
          .map((c, i) => {
            const date = c.call_date ?? c.created_at;
            return `=== Call ${i + 1} (${new Date(date).toLocaleDateString('en-GB')}, agent: ${c.agent_name ?? 'unknown'}) ===\n${c.transcript_text}`;
          })
          .join('\n\n')
      : withTranscript[0]!.transcript_text!;

    const org = await queryOne<{ industry: string | null }>(
      'SELECT industry FROM organizations WHERE id = $1',
      [run.organization_id]
    );

    const { answers: raw, usage, model } = await captureFromTranscript(
      transcript,
      form.fields,
      org?.industry ?? null,
      journeyMode
    );

    await recordUsage({
      organizationId: run.organization_id,
      callId: run.call_id ?? withTranscript[withTranscript.length - 1]!.id,
      provider: 'anthropic',
      operation: 'capture',
      modelId: model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens,
    });

    // Enforcement layer: PII suppression, type coercion, review routing —
    // never trust the model's raw output with those rules.
    const sanitized = sanitizeAnswers(form.fields, raw);

    await withTransaction(async (tx) => {
      // Re-runs replace the previous answer set for this run atomically.
      await tx.query('DELETE FROM capture_answers WHERE run_id = $1', [runId]);
      for (const a of sanitized) {
        // [Call N] is 1-based over the calls the model actually saw.
        const sourceCallId =
          a.source_call_index && withTranscript[a.source_call_index - 1]
            ? withTranscript[a.source_call_index - 1]!.id
            : journeyMode
              ? null
              : withTranscript[0]!.id;
        await tx.query(
          `INSERT INTO capture_answers
             (run_id, field_id, asked, answered, captured_value, value_redacted,
              result, confidence, evidence, source_call_id, reasoning)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            runId, a.field_id, a.asked, a.answered, a.captured_value, a.value_redacted,
            a.result, a.confidence, a.evidence, sourceCallId, a.reasoning,
          ]
        );
      }
      await tx.query(
        `UPDATE capture_runs
            SET status = 'completed', model_id = $2, completed_at = now(), error_message = NULL
          WHERE id = $1`,
        [runId, model]
      );
    });

    const missedRequired = sanitized.filter(
      (a) => a.result === 'missed' && form.fields.find((f) => f.id === a.field_id)?.required
    ).length;
    console.log(
      `[Capture] Run ${runId} completed: ${sanitized.length} fields, ` +
      `${sanitized.filter((a) => a.result === 'captured').length} captured, ` +
      `${missedRequired} required missed`
    );

    // Alert supervisors about missed required answers (rule-driven, no-op
    // unless the org has a capture_missed_required rule). Fire-and-forget —
    // an alert failure never fails the completed run.
    if (missedRequired > 0) {
      evaluateCaptureRunAlerts(runId).catch((alertErr) => {
        console.error(`[Capture] Alert evaluation failed for run ${runId}:`, alertErr);
      });
    }
  } catch (err) {
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      await query(
        "UPDATE capture_runs SET status = 'failed', error_message = $1 WHERE id = $2",
        [(err as Error).message, runId]
      );
    } else {
      console.warn(
        `[Capture] Run ${runId} failed on attempt ${job.attemptsMade + 1}/${totalAttempts}, will retry:`,
        (err as Error).message
      );
    }
    throw err;
  }
}
