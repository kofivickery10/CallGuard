// A deterministic cross-check on the Agent/Customer labels, independent of both
// the diarisation heuristic (services/transcription.ts) and the Claude cleanup
// pass's own verdict (services/transcript-cleanup.ts).
//
// Why this exists: the cleanup pass's speaker verdict is the ONLY thing that can
// lift a mono transcript's attribution confidence above the consent-gate floor
// (resolveSpeakerConfidence: 'confirmed' -> 0.75, floor 0.5). On an observed
// Trust Point sale it returned 'confirmed' for a 33-minute health-and-lifestyle
// call whose labels were inverted across most of the call. The lift put every
// consent gate back into auto-scoring, and a critical "did NOT lead the customer"
// checkpoint was failed on evidence that was the CUSTOMER speaking.
//
// One model checking its own transcript is a single point of failure. This
// module is the second opinion: cheap, deterministic, and — crucially — it only
// has to be right often enough to DISAGREE. Agreement changes nothing; a
// disagreement between the model's verdict and the content markers is itself the
// signal, and the transcript is then treated as unreliable rather than trusted.
// That means the marker lists below don't need to be exhaustive or perfect: a
// miss degrades to the old behaviour, and a false hit degrades to manual review,
// never to a wrong compliance verdict.
//
// NOTE ON TURN COUNTS: transcription.ts merges consecutive same-speaker
// utterances, so the emitted transcript ALWAYS strictly alternates and the two
// labels always have near-equal turn counts. Turn-count balance is therefore not
// evidence of anything — only the CONTENT under each label is.

// Phrases that, in a UK regulated sales/advice call, are said by the adviser and
// essentially never by the customer: reading scripted questions, quoting prices,
// compliance wording, and driving the process.
const ADVISER_MARKERS: RegExp[] = [
  /\bcalls? (?:are|is) (?:being )?recorded\b/i,
  /\bauthorised and regulated\b/i,
  /\bwhole[- ]of[- ]market\b/i,
  /\bkey facts\b/i,
  /\bdirect debit guarantee\b/i,
  /\bhave you ever been diagnosed\b/i,
  /\bnone of these apply\b/i,
  /\b(?:i have to|i'?ll have to|i need to) read\b/i,
  /\bword for word\b/i,
  /\bi'?ll (?:just )?(?:put|pop) (?:that|this|you) down\b/i,
  /\b(?:just )?confirm your (?:date of birth|postcode|address|full name)\b/i,
  /\bcan i (?:just )?(?:take|confirm|get) your\b/i,
  /\bdo you have the sort code\b/i,
  /\bthe next question\b/i,
  /\bnext set of questions\b/i,
  /\bit (?:says|will say)\b/i,
  /\bare you happy (?:with|for)\b/i,
  /\bis that (?:all )?clear\b/i,
  /\bwe get paid by\b/i,
  /\bi'?ll (?:send|email) you\b/i,
  /\bper month\b/i,
  /\bshall i (?:put|send|get)\b/i,
];

// Phrases said by the customer and essentially never by the adviser: first-person
// ownership of their own body, household and circumstances.
const CUSTOMER_MARKERS: RegExp[] = [
  /\bmy (?:doctor|gp|consultant|specialist|surgery)\b/i,
  /\bi'?m not a (?:doctor|medic|nurse|specialist)\b/i,
  /\bmy (?:wife|husband|partner|kids|children|son|daughter|mum|dad)\b/i,
  /\bmy (?:employer|boss|job|shift|round)\b/i,
  /\bi (?:can'?t|cannot) afford\b/i,
  /\bthat'?s too (?:much|expensive)\b/i,
  /\bi'?ll (?:have a )?think about it\b/i,
  /\bhow much (?:is|does|would) it\b/i,
  /\bi'?m (?:driving|at work|busy)\b/i,
  /\bmy (?:bank|account|policy) (?:is|was)\b/i,
];

// Below this many total role markers the transcript simply doesn't say enough
// for a content-based judgement (a short call, or one heavily redacted). We
// report 'insufficient_evidence' and change nothing rather than guess.
const MIN_TOTAL_MARKERS = 6;

// Share of markers sitting under the wrong label at or above which they are
// treated as inverted. 0.65 rather than a bare majority: some adviser phrasing
// legitimately gets echoed back by a customer ("so it's £30 per month?"), and we
// want a clear lean, not a coin-flip.
const INVERSION_RATIO = 0.65;

// Whole-transcript threshold above which the adviser's voice appears under BOTH
// labels in comparable measure — scrambled or merged turns rather than a clean
// end-to-end swap.
const CONFLICT_RATIO = 0.4;

// Diarisation does not fail politely from the first turn: it drifts. On the call
// that prompted this module the opening third was labelled correctly and the
// remainder was inverted, which averaged out to a whole-transcript misplacement
// ratio of 0.38 — under every sane global threshold, while more than half the
// call was unusable.
//
// So the transcript is also scanned in a sliding window over the marker
// sequence: a single sustained run of misattributed content condemns the
// transcript even when the aggregate looks acceptable. The window is measured in
// markers, not turns, so it tracks evidence density rather than call length.
const WINDOW_MARKERS = 8;

/** Longest-run misplacement: the worst contiguous window in the marker sequence. */
function maxWindowMisplacementRatio(
  markers: Array<{ misplaced: boolean }>,
  windowSize: number
): number {
  if (markers.length < windowSize) return 0;
  let misplacedInWindow = 0;
  for (let i = 0; i < windowSize; i++) if (markers[i]!.misplaced) misplacedInWindow++;
  let worst = misplacedInWindow / windowSize;
  for (let i = windowSize; i < markers.length; i++) {
    if (markers[i]!.misplaced) misplacedInWindow++;
    if (markers[i - windowSize]!.misplaced) misplacedInWindow--;
    worst = Math.max(worst, misplacedInWindow / windowSize);
  }
  return worst;
}

export type SpeakerIntegrityFlag =
  // Adviser content sits predominantly under "Customer:" across the whole
  // transcript — the labels look inverted end to end.
  | 'inverted_labels'
  // A sustained run of the call is misattributed while the rest looks fine —
  // diarisation drifted mid-call. Not repairable by a whole-transcript flip.
  | 'partial_inversion'
  // Adviser content appears under both labels in comparable measure — turns are
  // scrambled/merged, so no single flip repairs it.
  | 'role_marker_conflict'
  // The cleanup model reported 'confirmed' but the content markers disagree.
  // The most dangerous case, because 'confirmed' is what lifts confidence above
  // the consent-gate floor.
  | 'model_verdict_conflict';

export interface SpeakerMarkerCounts {
  adviserUnderAgent: number;
  adviserUnderCustomer: number;
  customerUnderAgent: number;
  customerUnderCustomer: number;
}

export interface SpeakerIntegrityAssessment {
  flag: SpeakerIntegrityFlag | null;
  counts: SpeakerMarkerCounts;
  // Share of all role markers that are attributed to the wrong label (0-1).
  // Reported for diagnostics/logging; the flag is what callers act on.
  inversionRatio: number;
  // Worst contiguous run of misattributed markers (0-1). Catches mid-call
  // diarisation drift that the whole-transcript ratio averages away.
  worstWindowRatio: number;
  // Human-readable one-liner for logs and the ops surface.
  detail: string;
}

/** Split a transcript into (label, text) turns. Tolerates a missing trailing newline. */
function parseTurns(transcript: string): Array<{ label: 'Agent' | 'Customer'; text: string }> {
  const turns: Array<{ label: 'Agent' | 'Customer'; text: string }> = [];
  const re = /^(Agent|Customer):[ \t]*([\s\S]*?)(?=^(?:Agent|Customer):|\s*$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) {
    turns.push({ label: m[1] as 'Agent' | 'Customer', text: m[2] ?? '' });
  }
  return turns;
}

// One role-marker hit, in transcript order — the sequence the sliding window
// scans for a sustained run of misattribution.
interface MarkerHit {
  role: 'adviser' | 'customer';
  label: 'Agent' | 'Customer';
  misplaced: boolean;
}

/** Role-specific phrase hits, in transcript order, tagged with their label. */
export function collectSpeakerMarkers(transcript: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  for (const turn of parseTurns(transcript)) {
    // Count each distinct marker at most once per turn: a merged block can
    // repeat one phrase several times, and that shouldn't outweigh a turn that
    // carries several different role signals.
    for (const re of ADVISER_MARKERS) {
      if (re.test(turn.text)) {
        hits.push({ role: 'adviser', label: turn.label, misplaced: turn.label === 'Customer' });
      }
    }
    for (const re of CUSTOMER_MARKERS) {
      if (re.test(turn.text)) {
        hits.push({ role: 'customer', label: turn.label, misplaced: turn.label === 'Agent' });
      }
    }
  }
  return hits;
}

/** Count role-specific phrase hits under each speaker label. */
export function countSpeakerMarkers(transcript: string): SpeakerMarkerCounts {
  const counts: SpeakerMarkerCounts = {
    adviserUnderAgent: 0,
    adviserUnderCustomer: 0,
    customerUnderAgent: 0,
    customerUnderCustomer: 0,
  };
  for (const hit of collectSpeakerMarkers(transcript)) {
    if (hit.role === 'adviser') {
      if (hit.label === 'Agent') counts.adviserUnderAgent++;
      else counts.adviserUnderCustomer++;
    } else {
      if (hit.label === 'Agent') counts.customerUnderAgent++;
      else counts.customerUnderCustomer++;
    }
  }
  return counts;
}

/**
 * Assess whether the Agent/Customer labels can be trusted, cross-checking the
 * cleanup model's own verdict against deterministic content markers.
 *
 * `modelVerdict` is the cleanup pass's SPEAKER_LABELS decision. A 'confirmed'
 * that the markers contradict is escalated to 'model_verdict_conflict': that
 * verdict is the only thing that lifts confidence above the consent-gate floor,
 * so a wrong 'confirmed' is strictly more dangerous than no check at all.
 */
export function assessSpeakerIntegrity(
  transcript: string,
  modelVerdict?: 'swapped' | 'confirmed' | 'partial' | 'unclear' | 'not_checked'
): SpeakerIntegrityAssessment {
  const hits = collectSpeakerMarkers(transcript);
  const counts = countSpeakerMarkers(transcript);
  const adviserTotal = counts.adviserUnderAgent + counts.adviserUnderCustomer;
  const total = hits.length;

  const misplaced = counts.adviserUnderCustomer + counts.customerUnderAgent;
  const inversionRatio = total > 0 ? misplaced / total : 0;
  const worstWindowRatio = maxWindowMisplacementRatio(hits, WINDOW_MARKERS);

  if (total < MIN_TOTAL_MARKERS) {
    return {
      flag: null,
      counts,
      inversionRatio,
      worstWindowRatio,
      detail: `insufficient evidence (${total} role marker(s) found, need ${MIN_TOTAL_MARKERS})`,
    };
  }

  // Lean on the adviser markers specifically for the global verdict: they are
  // the more reliable half (scripted, role-exclusive), whereas customer markers
  // are sparser.
  const adviserMisplacedRatio =
    adviserTotal > 0 ? counts.adviserUnderCustomer / adviserTotal : 0;

  let flag: SpeakerIntegrityFlag | null = null;
  if (adviserMisplacedRatio >= INVERSION_RATIO) {
    flag = 'inverted_labels';
  } else if (worstWindowRatio >= INVERSION_RATIO) {
    // A sustained bad run inside an otherwise-plausible transcript. Checked
    // BEFORE the global conflict threshold: it is the more specific diagnosis,
    // and it is the case a whole-transcript average hides.
    flag = 'partial_inversion';
  } else if (adviserMisplacedRatio >= CONFLICT_RATIO) {
    flag = 'role_marker_conflict';
  }

  const detail =
    `adviser markers ${counts.adviserUnderAgent} under Agent / ${counts.adviserUnderCustomer} under Customer; ` +
    `customer markers ${counts.customerUnderCustomer} under Customer / ${counts.customerUnderAgent} under Agent; ` +
    `worst ${WINDOW_MARKERS}-marker run ${Math.round(worstWindowRatio * 100)}% misattributed`;

  // A model 'confirmed' that the content contradicts is the case that produced
  // the false critical breach — call it out distinctly so it is greppable and
  // so the confidence lift is refused rather than merely offset.
  // A model that reported 'partial' has already told us part of the call is
  // inverted, so the markers agreeing is corroboration, not a conflict. Record
  // it as the partial inversion it is rather than as the model contradicting
  // itself — the two need different follow-up (one is a bad verdict, the other
  // is a correct verdict we cannot yet act on).
  if (modelVerdict === 'partial') {
    return {
      flag: 'partial_inversion',
      counts,
      inversionRatio,
      worstWindowRatio,
      detail: `model reported partial inversion; ${detail}`,
    };
  }

  if (flag && modelVerdict === 'confirmed') {
    return {
      flag: 'model_verdict_conflict',
      counts,
      inversionRatio,
      worstWindowRatio,
      detail: `model said 'confirmed' but ${detail}`,
    };
  }

  return { flag, counts, inversionRatio, worstWindowRatio, detail };
}

// Where a flagged transcript's attribution confidence is pinned. Must stay
// strictly BELOW CONSENT_SPEAKER_CONFIDENCE_FLOOR (0.5) so every consent gate
// routes to manual review rather than auto-scoring off labels we don't trust.
export const UNRELIABLE_SPEAKER_CONFIDENCE = 0.3;

export interface AttributionSupport {
  /** False when no checkpoint about who said something can be judged from this. */
  ok: boolean;
  /** Reader-facing reason, for the log and the reviewer. Null when ok. */
  reason: string | null;
}

/**
 * Can this transcript support a claim about who said something?
 *
 * A score is an assertion about the adviser's conduct, so it needs a transcript
 * in which the adviser is identifiable. Two states fail that outright, and both
 * were being scored as though they passed it.
 *
 * ONE PARTY IN THE WHOLE TRANSCRIPT
 *
 * Diarisation returned a single cluster, so every word carries one label and the
 * other party does not appear. Measured on Trust Point: 76 of 297 transcribed
 * calls. Most are short — voicemails and no-answers — and never reach scoring.
 * Four are the wrap-up call of a scored sale, and one of those is a 19-minute
 * health-disclosure conversation stored as a single 'Customer:' turn with no
 * Agent turn at all. It scored 92.68: every "did the adviser say this"
 * checkpoint judged against a transcript with no adviser in it.
 *
 * Note this is read off the LABELS rather than a stored cluster count, because
 * it is the labels scoring actually consumes — and it catches a transcript that
 * arrived one-sided by any route, not only the one we know about.
 *
 * LABELS PRESENT BUT NOT TRUSTWORTHY
 *
 * Any integrity flag means the marker content contradicts the labelling. The
 * flag has been diagnostic until now: confidence was pinned, which protects
 * consent gates and leaves the thirty-odd checkpoints that are not consent
 * gates auto-scoring off the same suspect labels.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide the transcript is worthless. The words are all there and a
 * person listening to the recording can score the sale perfectly well — which is
 * why the caller routes every checkpoint to review rather than discarding the
 * sale. The reviewer's verdicts produce the score.
 */
export function transcriptSupportsAttribution(
  transcript: string | null | undefined,
  flag: SpeakerIntegrityFlag | null
): AttributionSupport {
  if (flag !== null) {
    return {
      ok: false,
      reason: `speaker labels are not trustworthy (${flag})`,
    };
  }
  const text = transcript ?? '';
  const agent = (text.match(/^Agent:/gm) ?? []).length;
  const customer = (text.match(/^Customer:/gm) ?? []).length;
  if (agent === 0 || customer === 0) {
    return {
      ok: false,
      reason:
        agent === 0 && customer === 0
          ? 'the transcript carries no speaker labels at all'
          : `the whole call is labelled ${agent === 0 ? 'Customer' : 'Agent'} — the two parties were never separated`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Mechanically flip every Agent:/Customer: turn label. Turn order and text are
 * untouched.
 *
 * The single implementation. transcript-cleanup.ts uses it when the model's swap
 * decision is known but its cleaned output cannot be trusted, and
 * repairInvertedLabels below uses it to act on a detected inversion.
 */
export function swapSpeakerLabels(transcript: string): string {
  return transcript.replace(/^(Agent|Customer):/gm, (_m, who: string) =>
    who === 'Agent' ? 'Customer:' : 'Agent:'
  );
}

// ============================================================
// Cluster → role assignment (used BEFORE any label exists)
//
// Everything above judges a transcript that already carries Agent:/Customer:
// labels. This section is the other end of the problem: deciding which of
// Deepgram's anonymous speaker clusters IS the adviser, so those labels can be
// applied in the first place. It reuses the same marker lists because the
// evidence is the same — the adviser is the party reading scripted questions,
// giving compliance wording and quoting prices.
//
// Two-party calls: replaces a positional guess that rested on a single
// utterance (see services/transcription.ts for the observed 33-minute
// inversion). Measured over three real calls, positional scored 1/3 and this
// scored 3/3.
//
// Multi-party calls: this is what makes them usable at all. Three or more
// clusters is routine in protection advice — joint applicants on one handset, a
// spouse brought onto the call, an interpreter, a transfer between advisers —
// and the positional rule has no answer for them. Because transcription.ts
// collapses every non-adviser cluster into "Customer", picking the adviser
// correctly is the whole job; the customer side does not need to be told apart
// person by person for compliance scoring.
//
// NOTE ON INDEPENDENCE: once labels are assigned this way, assessSpeakerIntegrity
// above is no longer a fully independent check on them — it reads the same
// markers, so it will tend to agree. What it still catches is the failure this
// function cannot see: Deepgram misassigning individual utterances BETWEEN
// clusters (partial_inversion), which shows up as a sustained misattributed run
// regardless of which cluster was named the adviser. The thresholds below
// therefore abstain rather than guess, since a wrong pick is a false-PASS risk:
// a customer labelled "Agent" can satisfy a checkpoint the adviser was supposed
// to deliver.
// ============================================================

// Adviser markers the winning cluster must actually hit. Guards against picking
// a cluster that only looks adviser-like by having no customer markers — a
// second applicant who barely speaks would otherwise win on a net score of 0.
const MIN_ADVISER_MARKERS = 2;

// How much more adviser-like the winner must be than the runner-up. A margin of
// 1 is noise on an hour-long call; 3 is a clear, repeated pattern. This is also
// what makes an adviser-to-adviser transfer abstain: two clusters both reading
// scripted content land close together, and collapsing the second adviser into
// "Customer" is precisely the misattribution to avoid.
const MIN_CLUSTER_MARGIN = 3;

// One diarisation cluster's entire speech, before any Agent/Customer label
// exists — the input to deciding which cluster is the adviser.
export interface ClusterSpeech {
  /** Deepgram's speaker cluster index. */
  key: number;
  /** Everything that cluster said across the call, concatenated. */
  text: string;
}

/**
 * Count role-specific phrase hits in UNLABELLED text — one cluster's speech,
 * before any Agent/Customer label exists. Each distinct marker counts at most
 * once, as in collectSpeakerMarkers, so a cluster repeating one catchphrase
 * can't outweigh one showing several different role behaviours.
 */
export function scoreRoleMarkers(text: string): { adviser: number; customer: number } {
  let adviser = 0;
  let customer = 0;
  for (const re of ADVISER_MARKERS) if (re.test(text)) adviser++;
  for (const re of CUSTOMER_MARKERS) if (re.test(text)) customer++;
  return { adviser, customer };
}

/**
 * Decide which diarisation cluster is the adviser, from what each cluster
 * actually says across the whole call. Works for any number of clusters.
 *
 * Returns null — "no defensible answer, use your fallback" — when no single
 * cluster is clearly the adviser. Abstaining is the safe outcome: the caller
 * keeps a low attribution confidence and consent gates route to manual review
 * rather than being auto-scored off labels nobody can vouch for.
 */
export function identifyAdviserCluster(
  clusters: ClusterSpeech[]
): { key: number; detail: string } | null {
  if (clusters.length < 2) return null;

  const scored = clusters
    .map((c) => {
      const { adviser, customer } = scoreRoleMarkers(c.text);
      return { key: c.key, adviser, customer, net: adviser - customer };
    })
    .sort((a, b) => b.net - a.net);

  const detail = scored
    .map((c) => `cluster ${c.key}: ${c.adviser} adviser / ${c.customer} customer markers`)
    .join('; ');

  const winner = scored[0]!;
  const runnerUp = scored[1]!;
  const margin = winner.net - runnerUp.net;

  if (winner.adviser < MIN_ADVISER_MARKERS || winner.net <= 0 || margin < MIN_CLUSTER_MARGIN) {
    return null;
  }

  return { key: winner.key, detail: `${detail} (margin ${margin})` };
}
