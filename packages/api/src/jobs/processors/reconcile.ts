import { Job } from 'bullmq';
import { query, queryOne } from '../../db/client.js';
import {
  resolveApplicationDocument,
  learnProfileFromSale,
  statusForFailure,
  type ResolutionResult,
  type LearnOutcome,
} from '../../services/reconciliation-runs.js';
import { downloadSaleAttachment, type ZohoAttachment } from '../../services/zoho.js';
import {
  buildCombinedTranscriptWithOffsets,
  callNumberAtOffset,
} from '../../services/journey-transcript.js';
import {
  deriveSearchTerms,
  absenceIsMeaningful,
  transcriptRedactsHealth,
  findEvidence,
  evidenceExcerpts,
  deriveAnswerTerms,
  defaultCheckMode,
  classifyItem,
  classifyAmendment,
  type QuestionCheckMode,
} from '../../services/reconciliation.js';
import {
  extractPdfText,
  fingerprintQuestions,
  describeUnusableAttachments,
} from '../../services/application-pdf.js';
import type { ParsedPair } from '../../services/application-pdf.js';
import {
  extractApplicationPairs,
  ApplicationExtractionError,
} from '../../services/application-extraction.js';
import { extractCallAnswers, type ExtractedValue } from '../../services/reconciliation-values.js';
import { recordUsage } from '../../services/usage.js';
import { notify, recipientsByRole } from '../../services/notify.js';
import type { AlertSeverity, NotificationType } from '@callguard/shared';

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
//
// READING the document is a different matter. The preferred read is a stored
// profile (free, deterministic); when no usable profile exists YET — a brand-new
// insurer, a format awaiting its corroborating second sale, a parse that broke —
// the document is read directly by a model as a verified, clearly-marked
// fallback, so the sale is checked today instead of parking unread. The run
// carries extraction_method = 'model' and is re-read deterministically the
// moment a format for it goes live (see migration 093).
// ============================================================

/**
 * Propose a format for a document nothing recognised, so a human has something
 * to confirm instead of something to go and find.
 *
 * Never throws, and reports nothing on failure — the caller decides what to tell
 * the tenant once it knows whether the model fallback rescued the sale anyway.
 * Returns the learn outcome so the caller can reuse the attachment it judged
 * best, or null when the attempt itself blew up.
 */
async function autoProposeProfile(
  organizationId: string,
  journeyId: string,
  zohoRecordId: string
): Promise<LearnOutcome | null> {
  try {
    const outcome = await learnProfileFromSale(organizationId, journeyId, zohoRecordId);

    if (!outcome.profileId) {
      console.log(
        `[Reconciliation] could not auto-propose a format from journey ${journeyId} ` +
          `(${outcome.failure ?? 'unusable'}): ` +
          outcome.problems.map((p) => p.message).join(' | ')
      );
      return outcome;
    }

    const live = await queryOne<{ status: string; insurer: string; product: string | null; auto_confirmed_at: string | null }>(
      'SELECT status, insurer, product, auto_confirmed_at FROM capture_document_profiles WHERE id = $1',
      [outcome.profileId]
    );

    console.log(
      `[Reconciliation] auto-proposed a format from journey ${journeyId}: ` +
        `${outcome.insurer} / ${outcome.product ?? '—'}, ${outcome.questionCount} question(s)` +
        `${outcome.reusedExisting ? ' (already seen)' : ''} — status ${live?.status ?? 'unknown'}`
    );

    // It confirmed itself on corroboration. Told, not asked: the point is that
    // nobody had to act, but a format going live changes what every future sale
    // is judged against, so it cannot happen silently either.
    if (live?.status === 'active' && live.auto_confirmed_at) {
      const warnings = outcome.problems.filter((p) => p.severity === 'warning');
      await notifyAdmins(organizationId, {
        type: 'dataforms.format_live',
        severity: warnings.length ? 'warning' : 'info',
        title: `Now reading ${live.insurer}${live.product ? ` — ${live.product}` : ''} applications`,
        body:
          `Two sales independently produced the same format, so CallGuard has started reading it ` +
          `and every sale waiting on it has been checked. ` +
          (warnings.length
            ? `Worth knowing: ${warnings.map((w) => w.message).join(' ')}`
            : 'Review it on Data Forms if you want to check the questions it found.'),
        actionUrl: `/data-forms/profiles/${outcome.profileId}`,
        dedupeKey: `dataforms-live-${outcome.profileId}`,
      });
    }
    return outcome;
  } catch (err) {
    console.warn(
      `[Reconciliation] auto-propose failed for journey ${journeyId}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Tell the people who can act. Never throws — a notification that cannot be
 * delivered must not fail the reconciliation it was reporting on.
 */
async function notifyAdmins(
  organizationId: string,
  input: {
    type: NotificationType;
    severity: AlertSeverity;
    title: string;
    body: string;
    actionUrl: string;
    dedupeKey: string;
  }
): Promise<void> {
  try {
    const recipients = await recipientsByRole(organizationId, ['admin']);
    if (recipients.length === 0) return;
    await notify({ organizationId, recipients, ...input });
  } catch (err) {
    console.warn(`[Reconciliation] could not notify: ${(err as Error).message}`);
  }
}

interface RunRow {
  id: string;
  organization_id: string;
  journey_id: string;
  status: string;
  extraction_method: 'profile' | 'model';
}

interface TranscriptCall {
  id: string;
  call_date: string | null;
  created_at: string;
  agent_name: string | null;
  transcript_text: string | null;
}

/**
 * How many attachments a model read will attempt before giving up on a sale.
 * The learner's chosen document goes first and is nearly always right; one
 * spare covers the pack where its choice was a summary sheet sitting above the
 * real application. Each attempt is a paid model pass, and this can run on the
 * sweep's retry cadence, so the cap is deliberately tight.
 */
const MODEL_READ_CANDIDATES = 2;

/**
 * Read the document with a model and complete the run from that reading.
 *
 * The last resort, and the piece that makes "an insurer we have never seen"
 * work: every deterministic route has already been tried by the time this runs.
 * Each candidate's extraction is verified word-for-word against the document
 * (services/application-extraction.ts), so a covering letter or suitability
 * report refuses cleanly and the next candidate is tried.
 *
 * Returns true when the run was completed. False means no candidate yielded a
 * trustworthy reading, and the caller parks the run exactly as before.
 */
async function reconcileByModel(
  run: RunRow,
  zohoRecordId: string,
  resolution: ResolutionResult,
  outcome: LearnOutcome | null
): Promise<boolean> {
  const seen = new Set<string>();
  const candidates: ZohoAttachment[] = [];
  for (const a of [outcome?.attachment ?? null, ...resolution.candidates]) {
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    candidates.push(a);
  }

  for (const attachment of candidates.slice(0, MODEL_READ_CANDIDATES)) {
    let text: string;
    try {
      const buffer = await downloadSaleAttachment(run.organization_id, zohoRecordId, attachment.id);
      text = await extractPdfText(buffer);
    } catch (err) {
      console.warn(
        `[Reconciliation] Could not read attachment ${attachment.file_name}: ${(err as Error).message}`
      );
      continue;
    }

    let pairs: ParsedPair[];
    let dropped: number;
    try {
      const result = await extractApplicationPairs(text);
      pairs = result.pairs;
      dropped = result.dropped;
      await recordUsage({
        organizationId: run.organization_id,
        provider: 'anthropic',
        operation: 'reconcile',
        modelId: result.model,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      });
    } catch (err) {
      if (err instanceof ApplicationExtractionError) {
        // The refusal still cost a model pass — billed, then on to the next
        // candidate. "Not an application" here is the guard doing its job.
        if (err.usage) {
          await recordUsage({
            organizationId: run.organization_id,
            provider: 'anthropic',
            operation: 'reconcile',
            modelId: err.model ?? '',
            inputTokens: err.usage.input_tokens,
            outputTokens: err.usage.output_tokens,
          });
        }
        console.log(
          `[Reconciliation] model read of ${attachment.file_name} refused ` +
            `(${err.rejection.reason}): ${err.rejection.detail}`
        );
        continue;
      }
      throw err;
    }

    // No profile means no human-reviewed absence flags; the measured default
    // decides for every question, exactly as it does for an unreviewed profile.
    const { flagged } = await compareAndStore(run, pairs, new Map());
    await finish(
      run.id,
      'completed',
      'Read directly by AI: no saved format could parse this document yet, so the questions and ' +
        'answers were extracted by a model and each one verified against the document text. ' +
        'The sale will be re-checked deterministically when a format for this document goes live.',
      {
        profileId: outcome?.profileId ?? resolution.drift?.profile.id ?? null,
        attachment,
        fingerprint: fingerprintQuestions(pairs.map((p) => p.question)),
        extractionMethod: 'model',
      }
    );
    console.log(
      `[Reconciliation] Run ${run.id} completed by model read of ${attachment.file_name}: ` +
        `${pairs.length} questions (${dropped} unverifiable pair(s) dropped), ${flagged} needing attention`
    );
    await notifyAdmins(run.organization_id, {
      type: 'dataforms.needs_attention',
      severity: 'info',
      title: 'A sale was checked without a saved format',
      body:
        `No saved format matched the application on this sale, so CallGuard read it directly with AI — ` +
        `${pairs.length} question(s) were extracted, each verified against the document, and compared ` +
        'against the calls. Once a format for this document is confirmed, the sale is re-checked ' +
        'deterministically.',
      actionUrl: `/journeys/${run.journey_id}`,
      dedupeKey: `dataforms-modelread-${run.journey_id}`,
    });
    return true;
  }
  return false;
}

export async function processReconcile(job: Job<{ runId: string }>) {
  const { runId } = job.data;
  console.log(`[Reconciliation] Processing run ${runId}`);

  const run = await queryOne<RunRow>(
    `SELECT id, organization_id, journey_id, status, extraction_method
       FROM capture_reconciliation_runs WHERE id = $1`,
    [runId]
  );
  if (!run) {
    // A deliberate re-run deletes prior rows; a job queued for one of those is
    // orphaned by design. Throwing would only burn BullMQ retries on a row that
    // is permanently gone.
    console.log(`[Reconciliation] Run ${runId} no longer exists — skipping`);
    return;
  }
  // A completed profile-parsed run is final. A completed MODEL-read run is
  // provisional by design: activateProfile re-queues it when a format goes
  // live, precisely so the deterministic parse can replace the model's reading.
  const upgradingModelRead = run.status === 'completed' && run.extraction_method === 'model';
  if (run.status === 'summary_only' || (run.status === 'completed' && !upgradingModelRead)) {
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

    let resolution = await resolveApplicationDocument(run.organization_id, journey.zoho_record_id);

    if (!resolution.document) {
      const failure = resolution.failure ?? 'no_attachments';

      // An upgrade attempt that finds nothing better keeps what it has. The
      // model read already holds a verified result; downgrading it to a parked
      // status because a re-read failed would delete an answer to restore a
      // question.
      if (upgradingModelRead) {
        console.log(
          `[Reconciliation] Run ${runId} could not be upgraded (${failure}) — keeping the model read`
        );
        await query(`UPDATE capture_reconciliation_runs SET status = 'completed' WHERE id = $1`, [
          runId,
        ]);
        return;
      }

      let outcome: LearnOutcome | null = null;
      if (failure === 'no_profile_match' || failure === 'drifted') {
        // First, teach: propose a format so the deterministic path exists for
        // the NEXT sale (and this one, once corroborated). This is the step
        // that makes the module run itself: it does NOT confirm anything — the
        // proposal lands as 'needs_confirmation' exactly as the manual button
        // leaves it — but it removes the discovery problem, and two sales
        // producing the same format activate it with no human act at all.
        // 'drifted' takes the same route deliberately: a changed question set
        // and an unknown format need the same thing, a fresh read of the
        // document as it is now.
        outcome = await autoProposeProfile(run.organization_id, run.journey_id, journey.zoho_record_id);

        // Proposing can activate a format there and then — corroboration hit,
        // or the same signature marked an active profile's questions as
        // varying. When it does, the deterministic path exists NOW, so use it
        // rather than paying for a model read of a document we can parse.
        if (outcome?.profileId) {
          const live = await queryOne<{ status: string }>(
            'SELECT status FROM capture_document_profiles WHERE id = $1',
            [outcome.profileId]
          );
          if (live?.status === 'active') {
            const retry = await resolveApplicationDocument(run.organization_id, journey.zoho_record_id);
            if (retry.document) resolution = retry;
          }
        }

        // Then, if the deterministic path still cannot read this sale, read it
        // with a model rather than leaving the sale unchecked. This is what
        // makes a wholly unknown insurer work from the first sale.
        if (!resolution.document) {
          const done = await reconcileByModel(run, journey.zoho_record_id, resolution, outcome);
          if (done) return;
        }
      }

      if (!resolution.document) {
        // Every route is exhausted: no profile, no proposal worth confirming,
        // and no candidate the model read could verify. This IS the human's
        // problem now — no amount of waiting fixes a pack the system cannot
        // read — so it is said out loud rather than left in a worker log.
        if (failure === 'no_profile_match' && outcome && !outcome.profileId) {
          await notifyAdmins(run.organization_id, {
            type: 'dataforms.needs_attention',
            severity: 'warning',
            title: 'A sale’s application could not be read',
            body:
              `CallGuard could not work out how to read the ${outcome.candidates.length} document(s) ` +
              `attached to this sale — a direct AI read did not produce a verifiable result either — ` +
              `so nothing has been compared. ` +
              (outcome.problems.length
                ? `Reason: ${outcome.problems.map((p) => p.message).join(' ')}`
                : 'The attachments may not include the application form.'),
            actionUrl: `/journeys/${run.journey_id}`,
            // One per sale. A tenant with a systemic problem gets one
            // notification per affected sale, not one per sweep tick for ever.
            dedupeKey: `dataforms-unreadable-${run.journey_id}`,
          });
        }
        const status = statusForFailure(failure);
        // "None of them match a known format" is only honest once there is a
        // format to not match. On a tenant with none set up it reads as though
        // the documents are wrong, when nothing has been taught yet — a first-run
        // state and a genuine mismatch need entirely different actions, so they
        // must not share a sentence.
        const message =
          failure === 'drifted' && resolution.drift
            ? describeDrift(resolution.drift)
            : failure === 'no_profile_match'
              ? resolution.profilesAvailable === 0
                ? `No application formats have been set up yet, so the ${resolution.candidates.length} attached ` +
                  'document(s) could not be read. Read one of them to propose a format, then confirm it on Data Forms.'
                : `None of the ${resolution.candidates.length} attached document(s) match a known application format for this tenant.`
              : failure === 'not_configured'
                ? 'The CRM connection is not configured for attachment reads.'
                : failure === 'no_usable_attachment'
                  ? describeUnusableAttachments(resolution.candidates)
                  : 'No application document has been attached to the sale yet.';
        await finish(runId, status, message, {
          profileId: failure === 'drifted' ? resolution.drift?.profile.id ?? null : null,
        });
        return;
      }
    }

    const { attachment, profile, parsed } = resolution.document;

    // A summary sheet carries no question set. Recorded explicitly, because a
    // clean result here must never be read as "the health answers matched" when
    // the document contained no health questions at all. Items are cleared for
    // the upgrade case: a model read that left items behind must not sit under
    // a run now declaring there was nothing to compare.
    if (parsed.empty) {
      await query('DELETE FROM capture_reconciliation_items WHERE run_id = $1', [runId]);
      await finish(
        runId,
        'summary_only',
        'The application document contains no question set to compare against.',
        { profileId: profile.id, attachment, fingerprint: parsed.fingerprint, extractionMethod: 'profile' }
      );
      return;
    }

    // Per-question rulings override the measured defaults ONLY where a person
    // actually made them.
    //
    // The profile is the authority because a human reviewed it — that is the
    // whole justification, and it does not hold for a profile that went live by
    // corroboration. There, nobody ruled on anything: the stored values are a
    // snapshot of these same heuristics taken on the day the format was learned.
    // Treating that snapshot as authoritative freezes every bug in the heuristic
    // at the moment of learning, and silently outranks the fix.
    //
    // Which is exactly what happened. MetLife's profile stores
    // absence_meaningful=true for "Employment status" and "Occupation", learned
    // before those words were removed from the spoken-verbatim set. Re-running
    // three sales after that fix changed nothing: the stale `true` won, and all
    // three advisers were still recorded as never having asked.
    //
    // So a human-confirmed profile keeps its rulings for ever, and an
    // auto-confirmed one gets today's heuristics. Both fields are read
    // independently, because a profile stored before check modes existed carries
    // absence_meaningful and no mode.
    const humanReviewed = profile.confirmed_by !== null;
    const profileRulings = new Map<string, ProfileRuling>();
    if (humanReviewed) {
      for (const q of profile.questions ?? []) {
        profileRulings.set(normaliseKey(q.question), {
          absenceMeaningful:
            typeof q.absence_meaningful === 'boolean' ? q.absence_meaningful : undefined,
          checkMode: q.check_mode,
        });
      }
    }

    const { flagged } = await compareAndStore(run, parsed.pairs, profileRulings);

    await finish(runId, 'completed', null, {
      profileId: profile.id,
      attachment,
      fingerprint: parsed.fingerprint,
      extractionMethod: 'profile',
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

/**
 * The comparison itself: locate each question in the calls, read the answers,
 * and write the items. One implementation shared by both ways of obtaining the
 * pairs — a profile parse and a model read must be judged identically, or the
 * fallback would quietly apply a different standard of evidence.
 */
async function compareAndStore(
  run: RunRow,
  pairs: ParsedPair[],
  profileRulings: Map<string, ProfileRuling>
): Promise<{ flagged: number }> {
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

  // PHASE 1 — deterministic. Locate each question in the call and attribute the
  // hit to a specific call. No model involved.
  const located = pairs.map((pair) => {
    const ruling = profileRulings.get(normaliseKey(pair.question));
    const checkMode: QuestionCheckMode = ruling?.checkMode ?? defaultCheckMode(pair.question);

    // The question's own wording, plus the submitted answer's distinctive
    // values. The second is what makes a summary sheet checkable at all: its
    // "questions" are form labels nobody speaks, so searching for "Telephone"
    // or "DOB" finds nothing on a call where the customer gave both, while the
    // number and the year of birth are right there.
    //
    // Not searched for at all outside 'reconcile' mode. comparePair ignores the
    // result either way, but a masked account number yields terms like "38" that
    // match somewhere in any long transcript, and an excerpt attached to an item
    // is read by a human as the passage we checked. Better to hold none than one
    // picked by coincidence.
    const questionTerms =
      checkMode === 'reconcile' ? deriveSearchTerms(pair.question, pair.guidance) : [];
    const terms =
      checkMode === 'reconcile'
        ? [...questionTerms, ...deriveAnswerTerms(pair.answer)]
        : [];
    const hits = terms.length > 0 ? findEvidence(terms, transcript) : [];
    const offset = hits.length > 0 ? hits[0]!.index : null;
    const callNumber = offset == null ? null : callNumberAtOffset(segments, offset);
    return {
      pair,
      terms,
      hits,
      // Every place the topic comes up, not just the earliest. The adviser
      // habitually names what they are about to ask before asking it, so the
      // first mention is the one window an answer cannot be in.
      excerpts: evidenceExcerpts(transcript, hits),
      sourceCallId: callNumber == null ? null : (calls[callNumber - 1]?.id ?? null),
      // The date of the call this question was located in, so an answer given
      // as elapsed time ("7 years ago") can be read against the year the
      // application records.
      callDate:
        callNumber == null
          ? null
          : (() => {
              const c = calls[callNumber - 1];
              const raw = c?.call_date ?? c?.created_at ?? null;
              const d = raw ? new Date(raw) : null;
              return d && !Number.isNaN(d.getTime()) ? d : null;
            })(),
      // Judged on the QUESTION's terms alone. A submitted value not appearing
      // proves nothing — digits are read back in fragments, a date of birth is
      // spoken in words — so letting the answer's terms vouch for their own
      // absence would turn every unmatched identity field into an accusation.
      // The answer terms exist to FIND evidence, never to condemn its absence.
      absenceMeaningful: ruling?.absenceMeaningful ?? absenceIsMeaningful(questionTerms),
      checkMode,
    };
  });

  // PHASE 2 — the one part a model is better at. Only questions that were
  // located AND carry an application answer are sent, and only their excerpt,
  // never the whole transcript. A question nobody asked needs no model to tell
  // us so, and sending it would invite an answer to be invented for it.
  const extractionTargets = located.filter(
    (l) =>
      l.excerpts.length > 0 &&
      l.pair.answer !== null &&
      l.pair.answer.trim() !== '' &&
      // Only 'reconcile' questions have anything to extract. The others resolve
      // from the document alone, so paying to read a passage about a sort code
      // or a policy number buys nothing — and asking the model about a field
      // that cannot be verified invites an answer to be invented for it.
      l.checkMode === 'reconcile'
  );
  const extracted = new Map<string, ExtractedValue>();
  if (extractionTargets.length > 0) {
    try {
      const result = await extractCallAnswers(
        extractionTargets.map((l) => ({
          key: String(l.pair.order),
          question: l.pair.question,
          applicationAnswer: l.pair.answer!,
          excerpts: l.excerpts,
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
        `[Reconciliation] Value extraction failed for run ${run.id}, falling back to coverage only:`,
        (err as Error).message
      );
    }
  }

  // PHASE 3 — corroborate the claims that name a person.
  //
  // A single model read is not trusted to activate a document format; it should
  // not be trusted to accuse an adviser either. Re-running one sale twice with
  // identical code, document and transcript moved 7 of 17 items, including a
  // child-cover finding that was a 'mismatch' on one pass and 'asked_no_answer'
  // on the next — two different allegations about two different people's
  // conduct, from the same inputs. Pinning the temperature narrowed that to 4;
  // it did not fix it.
  //
  // Only 'mismatch' and 'asked_no_answer' are re-checked, because they are the
  // only actionable outcomes the model produces. 'not_asked' comes from a string
  // search and 'missing_from_application' from a blank field on the document —
  // both deterministic, so a second model pass cannot tell us anything new about
  // them. On one tenant that is 25 items out of 1,020, which is why this costs
  // almost nothing.
  const firstPass = new Map<number, ComparedItem>();
  for (const l of located) {
    firstPass.set(l.pair.order, comparePair(l, redacted, extracted.get(String(l.pair.order)) ?? null));
  }

  const secondPass = new Map<number, ComparedItem>();
  const disputed = located.filter((l) => {
    const outcome = firstPass.get(l.pair.order)?.outcome;
    return outcome === 'mismatch' || outcome === 'asked_no_answer';
  });
  if (disputed.length > 0) {
    try {
      const result = await extractCallAnswers(
        disputed.map((l) => ({
          key: String(l.pair.order),
          question: l.pair.question,
          applicationAnswer: l.pair.answer!,
          excerpts: l.excerpts,
        }))
      );
      const reread = new Map(result.values.map((v) => [v.key, v]));
      await recordUsage({
        organizationId: run.organization_id,
        provider: 'anthropic',
        operation: 'reconcile',
        modelId: result.model,
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
      });
      for (const l of disputed) {
        secondPass.set(
          l.pair.order,
          comparePair(l, redacted, reread.get(String(l.pair.order)) ?? null)
        );
      }
    } catch (err) {
      // A failed second call is not evidence of instability, so it must not
      // silently erase findings — that would hide real ones behind a transient
      // API error. The first pass stands, uncorroborated, and says so loudly
      // here because a run that never corroborates is a run whose findings are
      // weaker than the rest of the tenant's.
      console.warn(
        `[Reconciliation] Corroboration pass failed for run ${run.id}; ` +
          `${disputed.length} finding(s) stand on a single reading:`,
        (err as Error).message
      );
    }
  }

  await query('DELETE FROM capture_reconciliation_items WHERE run_id = $1', [run.id]);

  let flagged = 0;
  for (const l of located) {
    const pair = l.pair;
    const item = corroborate(firstPass.get(pair.order)!, secondPass.get(pair.order));
    if (item.actionable) flagged++;

    // A withdrawn question has an answer but no SUBMITTED answer, and the
    // difference is the whole point. Storing its value in application_answer
    // would assert the insurer was told something it was not; dropping the value
    // would lose the disclosure. So it moves to the revision trail, which is
    // exactly what it is — an answer that was superseded, here by removal.
    // Only where there is a value to move. A withdrawn question the portal
    // never captured an answer for has nothing to preserve, and an empty
    // revision would read on screen as an answer that was given and blanked.
    const applicationAnswer = pair.withdrawn ? null : pair.answer;
    const revisions =
      pair.withdrawn && pair.answer && pair.answer.trim() !== ''
        ? [
            ...(pair.revisions ?? []),
            {
              value: pair.answer,
              timestamp: pair.answeredAt ?? null,
              recordedBy: pair.recordedBy ?? null,
            },
          ]
        : (pair.revisions ?? []);

    await query(
      `INSERT INTO capture_reconciliation_items
         (run_id, sort_order, question, guidance, application_answer, call_answer,
          call_answer_redacted, outcome, evidence, reasoning, source_call_id,
          confidence, application_answered_at, application_recorded_by,
          answer_amended, amendment_type, revisions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        run.id,
        pair.order,
        pair.question,
        pair.guidance,
        applicationAnswer,
        item.callAnswer,
        item.callAnswerRedacted,
        item.outcome,
        item.evidence,
        item.reasoning,
        item.sourceCallId,
        item.confidence,
        pair.answeredAt ?? null,
        pair.recordedBy ?? null,
        revisions.length > 0,
        item.amendmentType,
        JSON.stringify(revisions),
      ]
    );
  }

  return { flagged };
}

function normaliseKey(question: string): string {
  return question.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * The distinct words a question was located on, for the reviewer.
 *
 * Deduplicated because findEvidence now reports every occurrence of a term, and
 * a topic mentioned four times would otherwise read as "found on: cancer,
 * cancer, cancer, cancer" — which says nothing and looks broken.
 */
function termList(hits: Array<{ term: string }>): string {
  return [...new Set(hits.map((h) => h.term))].slice(0, 4).join(', ');
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

/**
 * A confirmed profile's rulings for one question. Both optional and read
 * independently: a profile stored before check modes existed carries a reviewed
 * absence_meaningful and no mode, and must keep the half it has.
 */
interface ProfileRuling {
  absenceMeaningful?: boolean;
  checkMode?: QuestionCheckMode;
}

/** One application question, located in the call by the deterministic pass. */
interface LocatedQuestion {
  pair: ParsedPair;
  terms: string[];
  hits: Array<{ term: string; index: number }>;
  /** Every passage of call worth reading for this question, in call order. */
  excerpts: string[];
  /** When that call happened, for reading relative dates against. */
  callDate: Date | null;
  sourceCallId: string | null;
  absenceMeaningful: boolean;
  /** How this field is checked — the profile's ruling, or the measured default. */
  checkMode: QuestionCheckMode;
}

/**
 * Reconcile two readings of the same question into what we are willing to say.
 *
 * Agreement is on the OUTCOME, not the extracted wording, because the outcome is
 * the claim. Two passes reading "Yes" and "Yes, £50,000" against a form saying
 * "No" both mean the same thing — the customer said yes and the application does
 * not — and demanding identical strings would throw that finding away over a
 * phrasing difference the comparison already handles.
 *
 * A disagreement is not resolved, it is reported. The item keeps its evidence so
 * a reviewer can still read the passage and judge for themselves, but it stops
 * being a finding, because "the module said two different things about this
 * adviser" is not something we can put in front of the firm. That loses real
 * findings — on the sale this was built from, a genuine child-cover
 * non-disclosure goes quiet — and that is the deliberate trade: the same
 * direction of error the module takes everywhere else, silence over an
 * accusation it cannot stand behind.
 */
function corroborate(first: ComparedItem, second: ComparedItem | undefined): ComparedItem {
  if (!second || second.outcome === first.outcome) return first;
  return {
    ...first,
    outcome: 'undetermined',
    actionable: false,
    amendmentType: first.amendmentType,
    confidence: null,
    reasoning:
      'Checked twice and the two readings disagreed — ' +
      `${describeReading(first)} against ${describeReading(second)}. ` +
      'No finding is recorded, because a claim about how a call was conducted ' +
      'has to be one the check reaches the same way twice. The passage below is ' +
      'the one that was read, if you want to judge it yourself.',
  };
}

/** One reading, in the terms a reviewer would use. */
function describeReading(item: ComparedItem): string {
  const label =
    item.outcome === 'mismatch'
      ? 'a mismatch'
      : item.outcome === 'asked_no_answer'
        ? 'no answer given'
        : item.outcome.replace(/_/g, ' ');
  return item.callAnswer ? `${label} ("${item.callAnswer}")` : label;
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
  const { pair, terms, hits, absenceMeaningful, checkMode } = located;
  const found = hits.length > 0;

  // Answered during the application, then dropped from it before submission.
  //
  // Not compared, because the insurer was never asked this and flagging an
  // adviser over it would be an accusation about a question that is not on the
  // form. Not discarded either: what it says is the detail behind a withdrawal.
  // On the application that prompted this, two of these rows named the relative
  // and the cancer behind a family-history answer that had been changed from
  // "Any other cancer" to "No" — the strongest evidence on the sale, and it was
  // on screen as two questions the insurer had recorded nothing for.
  //
  // Deliberately NOT actionable, and deliberately not stamped as an amendment.
  // The portal drops a follow-up whenever its parent answer changes, so most of
  // this section is mechanical fallout — "Are you waiting for an operation? No",
  // "overall vision? Good or Perfect" — and flagging each one would manufacture
  // findings out of the form working normally. The withdrawal is already
  // reported once, on the parent question whose answer actually changed, which
  // is the claim that can be defended. These rows are the supporting detail a
  // reviewer reads after that flag brings them here.
  if (pair.withdrawn) {
    return {
      outcome: 'no_application_answer',
      callAnswer: null,
      callAnswerRedacted: false,
      evidence: null,
      reasoning:
        `Answered ${pair.answer ? `"${pair.answer}"` : 'during the application'}` +
        `${pair.answeredAt ? ` at ${pair.answeredAt}` : ''}` +
        `${pair.recordedBy ? ` by ${pair.recordedBy}` : ''}, then removed from the application ` +
        'before it was submitted. Not compared against the call, because it is not part of what ' +
        'the insurer received.',
      sourceCallId: null,
      confidence: null,
      amendmentType: null,
      actionable: false,
    };
  }

  // Fields that cannot be checked against a recording resolve from the document
  // alone. Nothing below this point runs for them: no evidence was gathered, so
  // there is none to weigh, and every reason string here says which of the two
  // it is rather than leaving a reader to wonder whether we simply failed to
  // find something.
  if (checkMode !== 'reconcile') {
    const outcome = classifyItem({
      applicationAnswer: pair.answer,
      callAnswer: null,
      callAnswerRedacted: false,
      evidenceFound: false,
      absenceMeaningful: false,
      redactedTranscript: redacted,
      checkMode,
    });
    return {
      outcome,
      callAnswer: null,
      callAnswerRedacted: false,
      evidence: null,
      reasoning:
        checkMode === 'none'
          ? 'The insurer issues this on submission, so it did not exist during the call and cannot be checked against it.'
          : outcome === 'missing_from_application'
            ? 'This had to be completed on the application and was submitted blank.'
            : 'Recorded on the application. Values like this are read back in fragments and are ' +
              'masked by the insurer, so they are checked for completion rather than against the call.',
      sourceCallId: null,
      confidence: null,
      amendmentType: null,
      actionable: outcome === 'missing_from_application',
    };
  }

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
    // Only the model can assert this, and only when it saw the exchange run
    // past the question. Absent an extraction it stays undefined, so a failed
    // value pass reports 'undetermined' rather than accusing every adviser on
    // the sale of taking answers nobody gave.
    customerDidNotAnswer: extracted?.customerDidNotAnswer,
    referenceDate: located.callDate,
  });

  const amendmentType = classifyAmendment(pair.answer, pair.revisions ?? []);

  const reasoning = !found
    ? terms.length === 0
      ? 'This question has no distinctive wording to search for, so the call could not be checked for it.'
      : absenceMeaningful
        ? `None of these terms appear anywhere in the call: ${terms.slice(0, 6).join(', ')}.`
        // Deliberately does not blame redaction. It often is the reason — the
        // condition names in a health question are stripped before storage —
        // but it is not the only one, and saying so where it is untrue is
        // worse than saying nothing. "Uk Resident" and "Telephone" are not
        // redacted at all; their terms are simply ones an adviser would never
        // have to say to ask the question ("do you live in the UK", "what's
        // your number"), so finding them absent establishes nothing either way.
        : `This question cannot be verified from its wording alone: ${terms
            .slice(0, 4)
            .join(', ')} would not necessarily be spoken even where the question was asked, or are removed from stored transcripts. Its absence proves nothing.`
    : extracted
      ? extracted.reasoning ||
        `Found in the call on: ${termList(hits)}.`
      : `Found in the call on: ${termList(hits)}. The customer's answer could not be read from the passage.`;

  return {
    outcome,
    callAnswer,
    callAnswerRedacted,
    // The first passage is the display quote; the rest were read but showing
    // all of them would bury the reviewer in repeated context.
    evidence: located.excerpts[0] ?? null,
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

function describeDrift(drift: {
  added: string[];
  removed: string[];
  reordered: boolean;
  brokenReason?: string;
}): string {
  // A form marked as asking conditional follow-ups has no question set to have
  // changed, so there is nothing to describe in those terms. What stopped is the
  // parse, and saying so points at the actual problem.
  if (drift.brokenReason) {
    return (
      `This document no longer reads the way its saved format expects — ${drift.brokenReason}. ` +
      'Nothing has been compared. Read the document again to propose an updated format.'
    );
  }
  const parts: string[] = [];
  if (drift.added.length) parts.push(`${drift.added.length} question(s) added`);
  if (drift.removed.length) parts.push(`${drift.removed.length} removed`);
  if (drift.reordered) parts.push('questions reordered');
  return (
    `The insurer's question set has changed (${parts.join(', ') || 'wording changed'}). ` +
    'Nothing has been compared until the new question set is confirmed. If this form asks ' +
    'different questions depending on the answers given, mark it as having a variable ' +
    'question set when you confirm it, and sales will stop parking here.'
  );
}

async function finish(
  runId: string,
  status: string,
  message: string | null,
  extra: {
    profileId?: string | null;
    attachment?: { id: string; file_name: string };
    fingerprint?: string;
    extractionMethod?: 'profile' | 'model';
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
            extraction_method = COALESCE($7, extraction_method),
            completed_at = now()
      WHERE id = $8`,
    [
      status,
      message,
      extra.profileId ?? null,
      extra.attachment?.id ?? null,
      extra.attachment?.file_name ?? null,
      extra.fingerprint ?? null,
      extra.extractionMethod ?? null,
      runId,
    ]
  );
}
