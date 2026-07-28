/**
 * Flag scorecard checkpoints whose wording makes them unreliable to score,
 * at authoring time rather than after a tenant stops trusting their numbers.
 *
 * Grounded in measurement, not taste. Scoring the same sale repeatedly (see
 * scripts/measure-score-stability.ts) showed ~85% of checkpoints returning an
 * identical verdict every run and the rest producing all of the movement in the
 * headline score. Reading the disagreements line by line, the model was quoting
 * the SAME passage each time and differing only on whether it cleared the bar.
 *
 * The unstable ones shared concrete, detectable properties:
 *
 *   absolute     "every H&L question" makes one interruption a literal failure,
 *                which is rarely what the author means.
 *   conditional  "where applicable" with nothing saying who decides.
 *   subjective   "clearly stated", "properly explained" — a threshold word with
 *                no threshold.
 *
 * Checkpoints that never moved ask whether something was SAID. Checkpoints that
 * moved ask whether it was done WELL ENOUGH.
 *
 * WHAT IS DELIBERATELY NOT DETECTED, AND WHY
 *
 * The dominant cause of instability is compound criteria — 13 of the 17
 * unstable checkpoints bundled several requirements with no partial-credit
 * rule. A detector for it was written and measured against the same scorecard,
 * and it does not work:
 *
 *   detector      on unstable   on stable   precision
 *   compound            3           13         19%     <- base rate is 39%
 *   conditional         1            0        100%
 *   absolute            1            0        100%
 *   subjective          1            0        100%
 *
 * Counting comma/"and"-separated clauses cannot tell "authorised and regulated
 * by the FCA" (one scripted phrase, stable in every run) from "introduce
 * yourself, state the firm, explain the reason" (three separate acts, a coin
 * toss). The distinction is whether the clauses are one utterance or several
 * observable events, which is not recoverable from the grammar. Shipping it
 * would have flagged 13 perfectly stable checkpoints and sent a tenant off to
 * rewrite them.
 *
 * The reliable way to find compound checkpoints is to MEASURE them — score real
 * sales repeatedly and see which verdicts move (scripts/measure-score-stability.ts).
 * That needs scored calls, so it cannot run at authoring time, but it is
 * evidence rather than a guess about English.
 *
 * Advisory only. Blocking a save on a judgement about wording would be worse
 * than the problem. Warnings are returned alongside the saved scorecard for the
 * UI to surface.
 */

export type CheckpointIssueKind = 'absolute' | 'conditional' | 'subjective';

export interface CheckpointIssue {
  kind: CheckpointIssueKind;
  // What was found, quoted from the author's own text so the warning is
  // obviously about their wording rather than a generic lint rule.
  found: string;
  message: string;
}

export interface CheckpointWarning {
  sort_order: number;
  label: string;
  issues: CheckpointIssue[];
}

// Words that make a checkpoint fail on a single exception. Deliberately short:
// "any" and "always" produce too many false positives in ordinary phrasing
// ("any concerns", "always available"), so only the two that reliably signal an
// exhaustive requirement are listed.
const ABSOLUTES = /\b(every|all of the)\b/i;

// A get-out clause with no stated decider. The checkpoint cannot be scored
// consistently because "applicable" is doing undefined work.
const CONDITIONALS = /\b(where applicable|if applicable|if relevant|where relevant|as appropriate|for the path taken)\b/i;

// Threshold words with no threshold. The model has to invent where the bar sits,
// and a genuinely borderline call then lands either side of it between runs.
const SUBJECTIVE = /\b(clearly|properly|adequately|sufficiently|appropriately|effectively|fully understood|reasonable)\b/i;

/** Analyse one checkpoint's wording. Returns [] when nothing looks risky. */
export function analyseCheckpoint(item: {
  label: string;
  description?: string | null;
  expectation?: string | null;
}): CheckpointIssue[] {
  const issues: CheckpointIssue[] = [];
  // The description is the rubric the model actually receives, so it is what
  // matters most; fall back to the label when there is none.
  const rubric = (item.description || item.label || '').trim();
  if (!rubric) return issues;

  const absolute = rubric.match(ABSOLUTES);
  if (absolute) {
    issues.push({
      kind: 'absolute',
      found: absolute[0],
      message:
        `"${absolute[0]}" makes a single exception a failure. If that is the intent, keep it; if ` +
        `not, say what counts (for example "answered the material questions themselves").`,
    });
  }

  const conditional = rubric.match(CONDITIONALS);
  if (conditional) {
    issues.push({
      kind: 'conditional',
      found: conditional[0],
      message:
        `"${conditional[0]}" does not say who decides whether it applies, so the checkpoint may be ` +
        `scored on sales it was never meant to cover. Consider restricting it to the relevant ` +
        `products instead.`,
    });
  }

  const subjective = rubric.match(SUBJECTIVE);
  if (subjective) {
    issues.push({
      kind: 'subjective',
      found: subjective[0],
      message:
        `"${subjective[0]}" sets a bar without saying where it is. Checkpoints asking whether ` +
        `something was SAID score consistently; those asking whether it was done WELL ENOUGH do not.`,
    });
  }

  return issues;
}

/** Analyse a whole scorecard. Only checkpoints with issues are returned. */
export function analyseScorecard(
  items: Array<{ label: string; description?: string | null; expectation?: string | null; sort_order: number }>
): CheckpointWarning[] {
  return items
    .map((i) => ({ sort_order: i.sort_order, label: i.label, issues: analyseCheckpoint(i) }))
    .filter((w) => w.issues.length > 0)
    .sort((a, b) => b.issues.length - a.issues.length || a.sort_order - b.sort_order);
}
