// Did the question survive the parse intact?
//
// A stored profile's question list is what a human confirms on the Data Forms
// screen, and what per-question rulings are keyed by. A question that arrived
// mangled cannot be confirmed sensibly, and — worse — its ruling can never be
// looked up again: the key is built from the question text, so a snapshot saying
// "Have you : ever" will never match the "Have you ever:" a later parse produces.
// reconcile.ts falls back silently when a key misses, so the operator sets a mode
// on the tenant's suicide and self-harm questions, sees it saved, and the
// pipeline goes on using the heuristic.
//
// Observed on the first deploying firm's live UnderwriteMe profile: four of its
// 39 questions, all four in the mental-health block —
//
//   "In the have you had any of these? last 5 years"   two spans, out of order
//   "Have you had any of these? ever"                  the same
//   "Have you : ever"                                  a bold run closed and
//   "Have you : ever"                                  reopened mid-sentence
//
// These tests began life in scripts/inspect-reconciliation-accuracy.ts, as a
// diagnostic run by hand after the damage was done. They belong on the path that
// creates a profile, which is the only moment they can prevent anything.
//
// SHAPE, NOT WORDING
//
// Every test describes text no insurer would ever have printed. None of them
// judges whether a question is well phrased or complete — that is the human's
// job on confirmation, and a heuristic guessing at it would block good profiles.
//
// There was a "too short to be a question" test here, and it is instructive that
// it had to go. A summary sheet's questions ARE short labels — "Name", "DOB",
// "Age", "Term", "Sex" — and flagging them put two legitimate National Friendly
// formats over the refusal threshold at 1-of-2 and 2-of-6. Shortness is not
// corruption. The one real fragment observed, "For", is caught by 'truncated
// tail' on its own.

export interface CorruptionFlag {
  name: string;
  /** What in the text triggered it, for the reader. */
  detail: string;
}

const TESTS: Array<{ name: string; test: RegExp; detail: string }> = [
  {
    // "Have you : ever" — a colon with a space before it, which happens when a
    // bold run is closed and reopened mid-sentence and the joiner goes in blind.
    name: 'stranded colon',
    test: / :\s/,
    detail: 'a colon separated from the word before it',
  },
  {
    // "In the have you had any of these? last 5 years" — a '?' with the sentence
    // resuming mid-phrase after it. Two spans emitted out of order.
    //
    // Lower-case or a digit specifically. Insurers do print two-sentence
    // questions — "...because of this? If you don't work, on how many days..." —
    // and an earlier version of this test flagged every one of them. What marks
    // the corruption is not a second sentence but a continuation that never
    // started one.
    name: 'interior question mark',
    test: /\?\s+[a-z0-9]/,
    detail: 'text resuming mid-phrase after a question mark',
  },
  {
    name: 'stray spacing',
    test: /\s{2,}|\s+[,.;]/,
    detail: 'doubled spaces, or a space before punctuation',
  },
  {
    // "youever", "inthe last" — a word glued to the next.
    name: 'missing space',
    test: /[a-z][A-Z]/,
    detail: 'two words run together',
  },
  {
    // Ends on a word that cannot end a sentence.
    name: 'truncated tail',
    test: /\b(the|a|an|of|in|to|and|or|with|for)\s*$/i,
    detail: 'ends mid-clause',
  },
  {
    // "Page \t2 \tof \t6" — a page footer captured as a question. Five of one
    // proposed Aviva profile's eight "questions" were exactly this.
    name: 'page furniture',
    test: /^\s*page\s+\d+\s+of\s+\d+\s*$|^\s*\d+\s+of\s+\d+\s*$|--\s*\d+\s+of\s+\d+\s*--/i,
    detail: 'page numbering, not a question',
  },
];

/** Every shape problem in this question. Empty means it looks intact. */
export function corruptionFlags(question: string): CorruptionFlag[] {
  return TESTS.filter((t) => t.test.test(question)).map((t) => ({
    name: t.name,
    detail: t.detail,
  }));
}

export function looksCorrupt(question: string): boolean {
  return corruptionFlags(question).length > 0;
}

export interface QuestionSetAudit {
  total: number;
  corrupt: Array<{ index: number; question: string; flags: CorruptionFlag[] }>;
  /** Share of the set that looks mangled, 0–1. */
  corruptShare: number;
}

export function auditQuestionSet(questions: string[]): QuestionSetAudit {
  const corrupt = questions
    .map((question, index) => ({ index, question, flags: corruptionFlags(question) }))
    .filter((r) => r.flags.length > 0);
  return {
    total: questions.length,
    corrupt,
    corruptShare: questions.length === 0 ? 0 : corrupt.length / questions.length,
  };
}

/**
 * Above this share of mangled questions, a proposal is a bad parse rather than a
 * format with a few rough edges, and offering it to a human wastes their time on
 * something they can only reject.
 *
 * A third. Below it the set is worth confirming with the bad ones flagged — the
 * live UnderwriteMe profile is 4 of 39, and it is a genuinely useful format. At
 * or above it the parse has failed: the proposed Aviva profile was five page
 * footers out of eight questions.
 */
export const MAX_CORRUPT_SHARE = 1 / 3;

export function proposalIsUsable(questions: string[]): boolean {
  return auditQuestionSet(questions).corruptShare < MAX_CORRUPT_SHARE;
}

// ── Repairing a stored snapshot ──────────────────────────────────────────────

/** Word multiset, for telling a re-ordered question from a different one. */
function tokenKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * The intact wording of a mangled question, found among questions observed
 * intact elsewhere.
 *
 * The corruption seen in practice is span re-ordering: the parser emits the
 * right words in the wrong order, so the mangled text and the correct text have
 * the same word multiset. That makes the repair derivable rather than typed by
 * hand — "In the have you had any of these? last 5 years" and "In the last 5
 * years have you had any of these?" are the same eleven words.
 *
 * Returns null unless EXACTLY ONE candidate matches. Two candidates sharing a
 * multiset means the evidence does not identify which was meant, and guessing
 * would rewrite a question into a different question.
 */
export function repairFromObserved(mangled: string, observed: string[]): string | null {
  const key = tokenKey(mangled);
  const matches = [...new Set(observed.filter((o) => tokenKey(o) === key && o !== mangled))];
  return matches.length === 1 ? matches[0]! : null;
}
