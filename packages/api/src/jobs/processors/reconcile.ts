import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import { resolveApplicationDocument, statusForFailure } from '../../services/reconciliation-runs.js';
import {
  buildCombinedTranscriptWithOffsets,
  callNumberAtOffset,
} from '../../services/journey-transcript.js';
import {
  deriveSearchTerms,
  absenceIsMeaningful,
  transcriptRedactsHealth,
  findEvidence,
  quoteAround,
  classifyItem,
  classifyAmendment,
} from '../../services/reconciliation.js';
import type { ParsedPair } from '../../services/application-pdf.js';
import { extractCallAnswers, type ExtractedValue } from '../../services/reconciliation-values.js';
import { recordUsage } from '../../services/usage.js';

// ============================================================
// Reconciliation job ('reconcile' on the scoring queue). One run = one sale's
// submitted application compared against its calls.
//
// Runs strictly after scoring and independently of it: a reconciliation failure
// marks the run failed, never the journey.
//
// The comparison here is entirely deterministic. Nothing consults a model. A
// reconciliation flag is in effect an allegation that an adviser mis-recorded a
// customer's disclosure, so it has to be reproducible and inspectable. Where the
// deterministic rules cannot decide, the outcome is 'undetermined' — an honest
// "we could not tell" — and a later pass can escalate those specific items to a
// model without any of this becoming model-dependent.
// ============================================================

interface RunRow {
  id: string;
  organization_id: string;
  journey_id: string;
  status: string;
}

interface TranscriptCall {
  id: string;
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  transcript_text: string | null;
}

export async function processReconcile(job: Job<{ runId: string }>) {
  const { runId } = job.data;
  console.log(`[Reconciliation] Processing run ${runId}`);

  const run = await queryOne<RunRow>(
    'SELECT id, organization_id, journey_id, status FROM capture_reconciliation_runs WHERE id = $1',
    [runId]
  );
  if (!run) {
    // A deliberate re-run deletes prior rows; a job queued for one of those is
    // orphaned by design. Throwing would only burn BullMQ retries on a row that
    // is permanently gone.
    console.log(`[Reconciliation] Run ${runId} no longer exists — skipping`);
    return;
  }
  if (run.status === 'completed' || run.status === 'summary_only') {
    console.log(`[Reconciliation] Run ${runId} already finished — skipping`);
    return;
  }

  // Counted here rather than on completion, so an attempt that dies mid-flight
  // still moves the retry cadence on and still changes the next attempt's job id.
  await query(
    `UPDATE capture_reconciliation_runs
        SET status = 'running', attempts = attempts + 1, last_attempt_at = now()
      WHERE id = $1`,
    [runId]
  );

  try {
    const journey = await queryOne<{ zoho_record_id: string | null }>(
      'SELECT zoho_record_id FROM journeys WHERE id = $1',
      [run.journey_id]
    );
    if (!journey?.zoho_record_id) {
      // Terminal, not waiting. Without a CRM record there is nowhere for a
      // document to appear, so retrying on a cadence would burn the window to
      // reach the same answer every time.
      await finish(
        runId,
        'abandoned',
        'This sale has no CRM record, so there is no application document to fetch.'
      );
      return;
    }

    const resolution = await resolveApplicationDocument(run.organization_id, journey.zoho_record_id);

    if (!resolution.document) {
      const failure = resolution.failure ?? 'no_attachments';
      const status = statusForFailure(failure);
      const message =
        failure === 'drifted' && resolution.drift
          ? describeDrift(resolution.drift)
          : failure === 'no_profile_match'
            ? `None of the ${resolution.candidates.length} attached document(s) match a known application format for this tenant.`
            : failure === 'not_configured'
              ? 'The CRM connection is not configured for attachment reads.'
              : 'No application document has been attached to the sale yet.';
      await finish(runId, status, message, {
        profileId: failure === 'drifted' ? resolution.drift?.profile.id ?? null : null,
      });
      return;
    }

    const { attachment, profile, parsed } = resolution.document;

    // A summary sheet carries no question set. Recorded explicitly, because a
    // clean result here must never be read as "the health answers matched" when
    // the document contained no health questions at all.
    if (parsed.empty) {
      await finish(
        runId,
        'summary_only',
        'The application document contains no question set to compare against.',
        { profileId: profile.id, attachment, fingerprint: parsed.fingerprint }
      );
      return;
    }

    const calls = await query<TranscriptCall>(
      `SELECT c.id, c.call_date, c.created_at, c.agent_name, c.transcript_text
         FROM journey_calls jc
         JOIN calls c ON c.id = jc.call_id
        WHERE jc.journey_id = $1
        ORDER BY COALESCE(c.call_date::timestamptz, c.created_at) ASC`,
      [run.journey_id]
    );
    const { text: transcript, segments } = buildCombinedTranscriptWithOffsets(calls);
    const redacted = transcriptRedactsHealth(transcript);

    // Per-question absence judgement comes from the confirmed profile where it
    // has one, falling back to the measured default. The profile is the
    // authority: it was reviewed by a human, this heuristic was not.
    const profileFlags = new Map<string, boolean>();
    for (const q of profile.questions ?? []) {
      if (typeof q.absence_meaningful === 'boolean') {
        profileFlags.set(normaliseKey(q.question), q.absence_meaningful);
      }
    }

    // PHASE 1 — deterministic. Locate each question in the call and attribute the
    // hit to a specific call. No model involved.
    const located = parsed.pairs.map((pair) => {
      const terms = deriveSearchTerms(pair.question, pair.guidance);
      const hits = findEvidence(terms, transcript);
      const offset = hits.length > 0 ? hits[0]!.index : null;
      const callNumber = offset == null ? null : callNumberAtOffset(segments, offset);
      return {
        pair,
        terms,
        hits,
        excerpt: offset == null ? null : quoteAround(transcript, offset, 420),
        sourceCallId: callNumber == null ? null : (calls[callNumber - 1]?.id ?? null),
        absenceMeaningful:
          profileFlags.get(normaliseKey(pair.question)) ?? absenceIsMeaningful(terms),
      };
    });

    // PHASE 2 — the one part a model is better at. Only questions that were
    // located AND carry an application answer are sent, and only their excerpt,
    // never the whole transcript. A question nobody asked needs no model to tell
    // us so, and sending it would invite an answer to be invented for it.
    const extractionTargets = located.filter(
      (l) => l.excerpt !== null && l.pair.answer !== null && l.pair.answer.trim() !== ''
    );
    const extracted = new Map<string, ExtractedValue>();
    if (extractionTargets.length > 0) {
      try {
        const result = await extractCallAnswers(
          extractionTargets.map((l) => ({
            key: String(l.pair.order),
            question: l.pair.question,
            applicationAnswer: l.pair.answer!,
            excerpt: l.excerpt!,
          }))
        );
        for (const v of result.values) extracted.set(v.key, v);
        await recordUsage({
          organizationId: run.organization_id,
          provider: 'anthropic',
          operation: 'reconcile',
          modelId: result.model,
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        });
      } catch (err) {
        // Value extraction failing must not lose the deterministic findings. A
        // sale where questions were demonstrably never asked is still worth
        // reporting even if we could not read the answers to the rest.
        console.warn(
          `[Reconciliation] Value extraction failed for run ${runId}, falling back to coverage only:`,
          (err as Error).message
        );
      }
    }

    await query('DELETE FROM capture_reconciliation_items WHERE run_id = $1', [runId]);

    let flagged = 0;
    for (const l of located) {
      const pair = l.pair;
      const item = comparePair(l, redacted, extracted.get(String(pair.order)) ?? null);
      if (item.actionable) flagged++;
      await query(
        `INSERT INTO capture_reconciliation_items
           (run_id, sort_order, question, guidance, application_answer, call_answer,
            call_answer_redacted, outcome, evidence, reasoning, source_call_id,
            confidence, application_answered_at, application_recorded_by,
            answer_amended, amendment_type, revisions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          runId,
          pair.order,
          pair.question,
          pair.guidance,
          pair.answer,
          item.callAnswer,
          item.callAnswerRedacted,
          item.outcome,
          item.evidence,
          item.reasoning,
          item.sourceCallId,
          item.confidence,
          pair.answeredAt ?? null,
          pair.recordedBy ?? null,
          (pair.revisions?.length ?? 0) > 0,
          item.amendmentType,
          JSON.stringify(pair.revisions ?? []),
        ]
      );
    }

    await finish(runId, 'completed', null, {
      profileId: profile.id,
      attachment,
      fingerprint: parsed.fingerprint,
    });
    console.log(
      `[Reconciliation] Run ${runId} completed: ${parsed.pairs.length} questions, ${flagged} needing attention`
    );
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[Reconciliation] Run ${runId} failed:`, message);
    // Consecutive, not cumulative: the sweep re-attempts a failed run precisely
    // because the cause is usually transient, and this is what eventually stops
    // it doing so for a run that errors every single time.
    await query(
      `UPDATE capture_reconciliation_runs
          SET status = 'failed',
              failure_streak = failure_streak + 1,
              error_message = $1,
              completed_at = now()
        WHERE id = $2`,
      [message.slice(0, 500), runId]
    );
    throw err;
  }
}

function normaliseKey(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

interface ComparedItem {
  outcome: string;
  callAnswer: string | null;
  callAnswerRedacted: boolean;
  evidence: string | null;
  reasoning: string | null;
  sourceCallId: string | null;
  confidence: number | null;
  amendmentType: string | null;
  actionable: boolean;
}

/** One application question, located in the call by the deterministic pass. */
interface LocatedQuestion {
  pair: ParsedPair;
  terms: string[];
  hits: Array<{ term: string; index: number }>;
  excerpt: string | null;
  sourceCallId: string | null;
  absenceMeaningful: boolean;
}

/**
 * Decide one question's outcome from the deterministic locate plus, where one was
 * obtained, the extracted call answer.
 *
 * The division of labour is the point. Coverage — was the question put at all,
 * and does its absence prove anything — is settled deterministically and is
 * reproducible. Only the answer's CONTENT comes from a model, and only for
 * questions already located. Where no value was obtained, the outcome is
 * 'undetermined' rather than an assumed match.
 */
function comparePair(
  located: LocatedQuestion,
  redacted: boolean,
  extracted: ExtractedValue | null
): ComparedItem {
  const { pair, terms, hits, absenceMeaningful } = located;
  const found = hits.length > 0;

  // A redaction verdict from the model is stronger evidence than the whole-
  // transcript flag: it saw the actual passage.
  const callAnswerRedacted = extracted?.redacted ?? (found && redacted);

  // A low-confidence extraction is discarded rather than compared. Below this the
  // model is guessing, and a guess here becomes an allegation against an adviser.
  const MIN_CONFIDENCE = 0.6;
  const callAnswer =
    extracted && extracted.value && extracted.confidence >= MIN_CONFIDENCE
      ? extracted.value
      : null;

  const outcome = classifyItem({
    applicationAnswer: pair.answer,
    callAnswer,
    callAnswerRedacted,
    evidenceFound: found,
    absenceMeaningful,
    redactedTranscript: redacted,
  });

  const amendmentType = classifyAmendment(pair.answer, pair.revisions ?? []);

  const reasoning = !found
    ? terms.length === 0
      ? 'This question has no distinctive wording to search for, so the call could not be checked for it.'
      : absenceMeaningful
        ? `None of these terms appear anywhere in the call: ${terms.slice(0, 6).join(', ')}.`
        : 'The words identifying this question are removed from stored transcripts, so their absence proves nothing.'
    : extracted
      ? extracted.reasoning ||
        `Found in the call on: ${hits.slice(0, 4).map((h) => h.term).join(', ')}.`
      : `Found in the call on: ${hits.slice(0, 4).map((h) => h.term).join(', ')}. The customer's answer could not be read from the passage.`;

  return {
    outcome,
    callAnswer,
    callAnswerRedacted,
    evidence: located.excerpt,
    reasoning,
    sourceCallId: located.sourceCallId,
    confidence: extracted?.confidence ?? null,
    amendmentType,
    actionable:
      outcome === 'mismatch' ||
      outcome === 'not_asked' ||
      outcome === 'asked_no_answer' ||
      amendmentType === 'disclosure_withdrawn',
  };
}

function describeDrift(drift: { added: string[]; removed: string[]; reordered: boolean }): string {
  const parts: string[] = [];
  if (drift.added.length) parts.push(`${drift.added.length} question(s) added`);
  if (drift.removed.length) parts.push(`${drift.removed.length} removed`);
  if (drift.reordered) parts.push('questions reordered');
  return `The insurer's question set has changed (${parts.join(', ') || 'wording changed'}). Nothing has been compared until the new question set is confirmed.`;
}

async function finish(
  runId: string,
  status: string,
  message: string | null,
  extra: {
    profileId?: string | null;
    attachment?: { id: string; file_name: string };
    fingerprint?: string;
  } = {}
): Promise<void> {
  // Any outcome that is not the catch block clears the failure streak: reaching
  // one means the run is working, whatever it concluded, so a later transient
  // error gets its full allowance of retries rather than the remains of an old
  // run of bad luck.
  await query(
    `UPDATE capture_reconciliation_runs
        SET status = $1,
            failure_streak = 0,
            error_message = $2,
            profile_id = COALESCE($3, profile_id),
            attachment_id = COALESCE($4, attachment_id),
            attachment_name = COALESCE($5, attachment_name),
            document_fingerprint = COALESCE($6, document_fingerprint),
            completed_at = now()
      WHERE id = $7`,
    [
      status,
      message,
      extra.profileId ?? null,
      extra.attachment?.id ?? null,
      extra.attachment?.file_name ?? null,
      extra.fingerprint ?? null,
      runId,
    ]
  );
}
