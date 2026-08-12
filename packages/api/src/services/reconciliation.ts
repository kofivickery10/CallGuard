// ============================================================
// Data Forms reconciliation: comparing the submitted application against what
// the customer actually said on the call.
//
// Everything here is deterministic and pure. That is a deliberate choice, not a
// cost optimisation: a reconciliation flag is in effect an allegation that an
// adviser mis-recorded a customer's disclosure, and "the words 'blood pressure'
// appear nowhere in this 52-minute call" is reproducible and inspectable in a way
// that "the model thought so" is not. A model is only consulted where these rules
// return `unclear`, and its answer is recorded as reasoning rather than as fact.
// ============================================================

export type ReconciliationOutcome =
  | 'match'
  | 'mismatch'
  | 'not_asked'
  | 'asked_no_answer'
  | 'no_application_answer'
  | 'undetermined';

/**
 * Words carrying no discriminating power when searching a sales call for whether
 * a particular question was put. Includes the scaffolding insurers wrap every
 * question in ("have you ever had, or do you currently have, any of the
 * following") — without stripping these, every question matches every call.
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'against', 'also', 'always', 'another', 'answer',
  'apart', 'application', 'apply', 'been', 'before', 'being', 'below', 'currently',
  'detail', 'details', 'does', 'doing', 'during', 'each', 'either', 'else', 'ever',
  'every', 'following', 'form', 'from', 'further', 'give', 'have', 'having', 'here',
  'include', 'included', 'includes', 'including', 'information', 'into', 'itself',
  'just', 'know', 'last', 'like', 'more', 'most', 'much', 'must', 'need', 'never',
  'only', 'other', 'others', 'over', 'own', 'part', 'past', 'please',
  // Generic across insurance vocabulary — "nicotine products", "protection
  // products", "the product" — so it discriminates nothing.
  'product', 'products', 'provide',
  // The label application-pdf.ts prepends to guidance to carry a question's
  // section heading ("Section: YOUR HEALTH — ..."). The label itself must never
  // become a search term, or every question in the document would share it.
  'section',
  'question', 'questions', 'received', 'regular', 'regularly', 'related', 'result',
  'results', 'same', 'select', 'since', 'some', 'such', 'tell', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'told',
  'under', 'until', 'used', 'using', 'very', 'were', 'what', 'when',
  'where', 'which', 'while', 'will', 'with', 'within', 'without', 'would', 'year',
  'years', 'your', 'yours', 'anything', 'already',
  'month', 'months', 'week', 'weeks', 'time', 'times', 'type', 'types',
  'yes', 'no', 'none', 'all', 'any', 'both',
]);

/**
 * Crude suffix stripping so a question's wording matches how it is actually
 * spoken: the application asks "Have you smoked", the adviser says "do you
 * smoke", "any smoking". Matching on the stem catches all three. Deliberately
 * not a full stemmer — the goal is recall on topic presence, not linguistic
 * correctness.
 */
const MIN_STEM = 4;

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('ing') && w.length - 3 >= MIN_STEM) return w.slice(0, -3);
  if (w.endsWith('ed')) {
    // "smoked" -> "smok". But "vaped" is "vape" + d, so where stripping both
    // letters leaves too little, keep the e. A bare 'd' is never stripped
    // otherwise, or "blood" becomes "bloo".
    if (w.length - 2 >= MIN_STEM) return w.slice(0, -2);
    if (w.length - 1 >= MIN_STEM) return w.slice(0, -1);
    return w;
  }
  if (w.endsWith('es') && w.length - 2 >= MIN_STEM) return w.slice(0, -2);
  // "illness" must not become "illnes".
  if (w.endsWith('s') && !w.endsWith('ss') && w.length - 1 >= MIN_STEM) return w.slice(0, -1);
  return w;
}

/**
 * Terms observed to SURVIVE the transcription provider's health redaction, from
 * a measurement across 63 real protection calls.
 *
 * This list is what makes "absence proves the question was not asked" safe to
 * assert. For a question whose distinctive terms are all absent from it, absence
 * proves nothing, because redaction would have removed them anyway — those
 * questions must resolve to `undetermined`, never `not_asked`.
 *
 * Measured absent from all 63 calls, i.e. destroyed by redaction: diabetes,
 * cancer, stroke, asthma, depression, anxiety. Re-measure with
 * scripts/verify-redaction.ts before extending this list; do not guess.
 */
// Listed as WORDS and passed through stem(), so the set can never drift out of
// step with the stemmer — hand-writing stems here previously produced entries
// like 'nicotin' and 'occupat' that nothing could ever match.
const REDACTION_RESISTANT_STEMS = new Set(
  [
    'smoke', 'smoked', 'smoking', 'vape', 'vaped', 'cigarette', 'cigarettes',
    'tobacco', 'nicotine',
    'alcohol', 'unit', 'units', 'drink', 'drinking', 'pint', 'wine', 'spirits',
    'height', 'weight', 'stone', 'kilo', 'kilos', 'trouser', 'trousers',
    'blood', 'pressure', 'cholesterol', 'heart',
    'medication', 'medicine', 'prescribed', 'prescription', 'tablet', 'tablets',
    'treatment',
    'doctor', 'surgery', 'specialist', 'hospital', 'consultant',
    'occupation', 'job', 'work', 'employed', 'employment', 'earn', 'earnings',
    'salary', 'income',
    'driving', 'drive', 'driver', 'travel', 'sport', 'sports',
  ].map(stem)
);
// 'gp' is shorter than MIN_STEM so stem() leaves it alone, but the derive step
// drops sub-MIN_STEM tokens unless they are in this set. Added explicitly.
REDACTION_RESISTANT_STEMS.add('gp');

/**
 * Terms MEASURED ABSENT from all 63 real transcripts, i.e. reliably destroyed by
 * the provider's health redaction.
 *
 * A question about one of these cannot be judged by absence even when it also
 * mentions something that does survive. "A stroke, brain haemorrhage or surgery
 * to your blood vessels?" contains both `blood` and `surgery`, which survive —
 * but an adviser asking it says "any strokes?", and `stroke` is gone. Treating
 * the incidental survivor as proof would report the question as skipped.
 *
 * Only measured terms belong here. Add nothing on intuition: `tumour` looks like
 * it should be redacted and was in fact observed in 6 calls, so it survives.
 * Re-measure with scripts/verify-redaction.ts before extending.
 */
const REDACTION_PRONE_STEMS = new Set(
  [
    'diabetes', 'diabetic',
    'cancer',
    'stroke', 'strokes',
    'asthma',
    'depression', 'depressed',
    'anxiety',
  ].map(stem)
);

/** Placeholders the provider leaves where it removed health content. */
const HEALTH_REDACTION_TAGS = [
  '[CONDITION_', '[DRUG_', '[MEDICAL_PROCESS_', '[INJURY_', '[DOSE_',
  '[HEALTHCARE_NUMBER_',
];

/**
 * Does this transcript show signs that health content was redacted out of it?
 * When true, a question with no redaction-resistant terms cannot be judged by
 * absence.
 */
export function transcriptRedactsHealth(transcript: string): boolean {
  return HEALTH_REDACTION_TAGS.some((tag) => transcript.includes(tag));
}

/**
 * Distinctive stems to search a transcript for, derived from the insurer's own
 * question wording. Guidance text is included because it often carries the
 * clinical vocabulary the question itself omits ("Including: Angina or heart
 * attack, Cardiomyopathy…").
 */
export function deriveSearchTerms(question: string, guidance?: string | null): string[] {
  const source = `${question} ${guidance ?? ''}`;
  const words = source
    .toLowerCase()
    // Keep hyphenated forms as separate words too: "e-cigarettes" should yield
    // "cigarett" as well as "e".
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

  const stems = new Set<string>();
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const s = stem(word);
    // Short stems ("any", "had", "not") match everything and prove nothing.
    if (s.length < 4 && !REDACTION_RESISTANT_STEMS.has(s)) continue;
    if (STOPWORDS.has(s)) continue;
    stems.add(s);
  }
  return [...stems];
}

/**
 * Whether absence of these terms from a transcript is meaningful — i.e. whether
 * "we found none of them" may be reported as "the question was not asked".
 *
 * Requires a term that survives redaction AND no term that redaction destroys.
 * Both conditions matter: without the first there is nothing to look for, and
 * without the second an incidental survivor would vouch for a question whose
 * actual subject was removed.
 *
 * This is a deliberately CONSERVATIVE default, not the final word. It errs
 * toward `undetermined`, which under-reports rather than falsely accusing. The
 * authoritative value is a per-question flag on the stored document profile,
 * decided once when the profile is learned and confirmed by a human — see
 * ClassifyInput.absenceMeaningful, which the caller supplies rather than this
 * function being consulted at judgement time.
 */
export function absenceIsMeaningful(terms: string[]): boolean {
  if (terms.some((t) => REDACTION_PRONE_STEMS.has(t))) return false;
  return terms.some((t) => REDACTION_RESISTANT_STEMS.has(t));
}

export interface EvidenceHit {
  term: string;
  /** Character offset of the match, for locating the surrounding quote. */
  index: number;
}

/**
 * How many times one term may be recorded. A stem like "cancer" can occur
 * dozens of times in a long call; the cap keeps a single word from crowding out
 * every other term's evidence, while still admitting the later occurrences that
 * matter.
 */
const MAX_HITS_PER_TERM = 4;

/**
 * Locate a question's terms in a transcript. Returns every hit so a caller can
 * quote the surrounding text and, once word timings are available, resolve a
 * timestamp.
 *
 * EVERY occurrence, not just the first. Taking only the first was a silent and
 * expensive mistake: an adviser routinely names the topics they are about to
 * cover ("I'll ask about heart conditions, cancer and diabetes") minutes before
 * asking about any of them, so the earliest mention is precisely the one place
 * the answer is guaranteed not to be. Judged on that window alone, a question
 * answered perfectly well reads as raised-and-never-answered — which is how 252
 * of one tenant's 448 items came to be flagged for review.
 */
export function findEvidence(terms: string[], transcript: string): EvidenceHit[] {
  const haystack = transcript.toLowerCase();
  const hits: EvidenceHit[] = [];
  for (const term of terms) {
    if (term === '') continue;
    let from = 0;
    for (let n = 0; n < MAX_HITS_PER_TERM; n++) {
      const index = haystack.indexOf(term, from);
      if (index < 0) break;
      hits.push({ term, index });
      from = index + term.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** A short quote around the strongest hit, for display as evidence. */
export function quoteAround(transcript: string, index: number, width = 160): string {
  const start = Math.max(0, index - Math.floor(width / 2));
  return transcript
    .slice(start, start + width)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A quote that runs from the speaker turn containing a hit through the replies
 * that follow it.
 *
 * quoteAround centres its window on the hit, which is the wrong shape for the
 * question being asked of it. We are not illustrating where a word occurs; we
 * are asking whether the customer ANSWERED, and an answer always comes after the
 * question. A centred window spends half its budget on what preceded the topic
 * and can leave the reply outside the other half — reliably so, because insurer
 * questions are long and are often read out as a list.
 *
 * Stored transcripts are speaker-labelled ("Agent: …\n\nCustomer: …"), so the
 * turn boundaries are real and this can start at the beginning of the turn the
 * hit falls in — giving the question in full — and run forward far enough to
 * include the reply to it.
 */
export function quoteExchange(transcript: string, index: number, width = 700): string {
  // Back up to the start of this speaker turn so the question is not cut off
  // mid-sentence, but no further: the previous turn is not evidence about this
  // question.
  const before = transcript.lastIndexOf('\n\n', index);
  const turnStart = before === -1 ? 0 : before + 2;
  // Bounded, so an unlabelled or single-block transcript cannot make one
  // question's excerpt swallow the whole call.
  const start = Math.max(turnStart, index - 200);
  return transcript
    .slice(start, start + width)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The passages of call worth reading to decide whether one question was
 * answered.
 *
 * Hits cluster: several of a question's terms land in the same sentence, and
 * quoting each separately would send the same text repeatedly. Overlapping hits
 * therefore collapse into one passage, and only genuinely distinct places in the
 * call — the adviser's preamble, then where the question was actually put —
 * become separate excerpts.
 *
 * Capped at a handful, because this text is what a model reads for every
 * question of every sale, and an unbounded version of this is how a cheap
 * deterministic pass turns into an expensive one.
 */
export function evidenceExcerpts(
  transcript: string,
  hits: EvidenceHit[],
  maxExcerpts = 3,
  width = 700
): string[] {
  const excerpts: string[] = [];
  let lastIndex = -Infinity;
  for (const hit of hits) {
    if (excerpts.length >= maxExcerpts) break;
    // Within the span already quoted: the same passage, not a new one.
    if (hit.index - lastIndex < width * 0.75) continue;
    const quote = quoteExchange(transcript, hit.index, width);
    if (quote !== '') {
      excerpts.push(quote);
      lastIndex = hit.index;
    }
  }
  return excerpts;
}

const AFFIRMATIVE = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'correct', 'true']);
const NEGATIVE = new Set([
  'no', 'n', 'nope', 'none', 'never', 'false',
  // Insurers render the negative of a multi-select this way; it means the same
  // as "no" and must compare equal to a customer simply saying no. All of these
  // wordings appear in real documents from the three formats seen.
  'none of the above', 'none of these', 'neither of these', 'no to all',
  'not applicable', 'n/a', 'not answered', 'i don\'t know', 'dont know',
]);

export function normaliseAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/[£$,]/g, '')
    .replace(/[^a-z0-9.\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function polarity(value: string): 'yes' | 'no' | null {
  const n = normaliseAnswer(value);
  if (AFFIRMATIVE.has(n)) return 'yes';
  if (NEGATIVE.has(n)) return 'no';
  return null;
}

/** Numbers present in an answer, for comparing "50" against "50 a day". */
function numbersIn(value: string): number[] {
  return (normaliseAnswer(value).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * "7 years ago", "about 8 yrs back" — how people actually date things aloud.
 *
 * Nobody says "my treatment ceased in 2019"; they say "seven years ago". The
 * application, filled in from the same conversation, records the year. Both are
 * the same fact in different units.
 */
const RELATIVE_YEARS = /(\d+)\s*(?:years?|yrs?)\s*(?:ago|back)/;

/** A four-digit year, as distinct from a count of anything. */
function isYear(n: number): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2099;
}

/**
 * A year and a count of years are the same fact in different units, and
 * comparing them as bare numbers is how "2019" and "7 years ago" became a
 * mismatch on a real sale — in 2026, when they agree exactly.
 *
 * Resolved against the call's own date where one is known. Rounded to a year of
 * tolerance because "seven years ago" is speech, not arithmetic: treatment that
 * ended in late 2019 is six and a half years ago and nobody says that.
 *
 * Returns null when this pair is not a year-against-elapsed-time comparison at
 * all, so the caller carries on with its ordinary rules.
 */
function compareYearToElapsed(
  app: string,
  call: string,
  referenceYear: number | null
): AnswerComparison | null {
  const pairs: Array<[string, string]> = [
    [app, call],
    [call, app],
  ];
  for (const [otherSide, elapsedSide] of pairs) {
    const elapsed = RELATIVE_YEARS.exec(normaliseAnswer(elapsedSide));
    if (!elapsed) continue;
    const nums = numbersIn(otherSide);
    if (nums.length !== 1) continue;

    if (isYear(nums[0]!)) {
      // Without a date to count back from there is nothing to compare, and
      // guessing would put the original mistake back. 'unclear' hands it on.
      if (referenceYear === null) return 'unclear';
      const resolved = referenceYear - Number(elapsed[1]);
      return Math.abs(resolved - nums[0]!) <= 1 ? 'match' : 'mismatch';
    }

    // An AGE against an elapsed time. "How old were you when you were diagnosed
    // with asthma?" recorded as 51, the customer saying "about 13 years ago" —
    // the same fact told from the other end, and one a person converts without
    // noticing they have. Resolving it needs a date of birth, which is not
    // available here and may itself be redacted, so the honest answer is that
    // we cannot tell. Declaring it a mismatch reads as the adviser having
    // invented an age, which on a real sale is exactly what it did.
    return 'unclear';
  }
  return null;
}

export type AnswerComparison = 'match' | 'mismatch' | 'unclear';

/**
 * A weight in kilograms, read from either side's phrasing, or null when the
 * text does not state one in recognisable units.
 *
 * Customers say weight in stone; insurers record kilograms. "17 stone" IS
 * "107.95 kg" — the adviser converted correctly — and comparing the bare
 * numbers 17 and 107.95 declared them a contradiction on a real sale, at 0.95
 * confidence, in the face of the model's own reasoning saying they agree.
 * The conversion is exact arithmetic, so this is deterministic code, not
 * model judgement.
 */
const KG_PER_STONE = 6.35029;
const KG_PER_POUND = 0.453592;

export function weightInKg(text: string): number | null {
  const n = normaliseAnswer(text);
  const kg = /(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?)\b/.exec(n);
  if (kg) return Number(kg[1]);
  const stone = /(\d+(?:\.\d+)?)\s*(?:st|stones?)\b(?:\s*(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)?\b)?/.exec(n);
  if (stone) return Number(stone[1]) * KG_PER_STONE + (stone[2] ? Number(stone[2]) * KG_PER_POUND : 0);
  const pounds = /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/.exec(n);
  if (pounds) return Number(pounds[1]) * KG_PER_POUND;
  return null;
}

/**
 * Measures of drink that are NOT units of alcohol. A pint is roughly two and a
 * half units depending entirely on what is in the glass, so "2 pints" against
 * "4 units" is not a numeric disagreement — the adviser converting pints to
 * units is doing their job, and the strength assumption that conversion rests
 * on is not ours to second-guess deterministically.
 */
const DRINK_MEASURE = /\b(pints?|glass(es)?|bottles?|cans?|shots?|measures?)\b/;

/**
 * Compare an application answer with what the customer said.
 *
 * Returns `unclear` rather than guessing wherever the two are not
 * deterministically comparable — "111.1kg or 17 stone 7 pounds" against "about
 * seventeen and a half stone" needs semantic judgement, and that is a model's
 * job, not this function's. `unclear` is the handover point, not a failure.
 */
export function compareAnswers(
  applicationAnswer: string,
  callAnswer: string,
  /** The call's date, for reading "7 years ago" against. */
  referenceDate: Date | null = null
): AnswerComparison {
  const appPolarity = polarity(applicationAnswer);
  const callPolarity = polarity(callAnswer);
  if (appPolarity && callPolarity) {
    return appPolarity === callPolarity ? 'match' : 'mismatch';
  }

  const app = normaliseAnswer(applicationAnswer);
  const call = normaliseAnswer(callAnswer);
  if (app === '' || call === '') return 'unclear';
  if (app === call) return 'match';

  // One containing the other is a match: the application stores a canonical
  // "Raised blood pressure" where the customer said "yeah, raised blood pressure
  // a few years back".
  if (app.length >= 4 && (call.includes(app) || app.includes(call))) return 'match';

  // Weights first: both sides stating one in recognisable units is decidable by
  // arithmetic, whatever units each chose. Tolerance of a kilogram either way,
  // because "17 stone" is speech and 107.95 is a form field.
  const appKg = weightInKg(applicationAnswer);
  const callKg = weightInKg(callAnswer);
  if (appKg !== null && callKg !== null) {
    return Math.abs(appKg - callKg) <= Math.max(1, appKg * 0.02) ? 'match' : 'mismatch';
  }

  // A count of drinks against a count of units is two different quantities, and
  // only one side of the conversion between them is on the page.
  if (DRINK_MEASURE.test(normaliseAnswer(callAnswer)) !== DRINK_MEASURE.test(normaliseAnswer(applicationAnswer))) {
    return 'unclear';
  }

  // A date given as a year against one given as elapsed time is the same fact in
  // two units, and the bare-number rule below reads it as a disagreement.
  const elapsed = compareYearToElapsed(
    applicationAnswer,
    callAnswer,
    referenceDate ? referenceDate.getUTCFullYear() : null
  );
  if (elapsed !== null) return elapsed;

  // Numeric answers are where mis-keying actually bites (50 cigarettes keyed as
  // 5). Only conclude when both sides carry exactly one number, so a compound
  // answer is escalated rather than guessed at.
  const appNums = numbersIn(applicationAnswer);
  const callNums = numbersIn(callAnswer);
  if (appNums.length === 1 && callNums.length === 1) {
    if (appNums[0] === callNums[0]) return 'match';
    // A year against a small count is not a mis-keying, it is two different
    // kinds of quantity — "2019" against "7", an age against a date, a year
    // against a number of episodes. Declaring those a mismatch accuses an
    // adviser on the strength of a unit confusion that is ours, not theirs.
    if (isYear(appNums[0]!) !== isYear(callNums[0]!)) return 'unclear';
    return 'mismatch';
  }
  // A number on one side and none on the other tells us nothing on its own.
  return 'unclear';
}

// ── Answer amendments ─────────────────────────────────────────────────────────

export type AmendmentType = 'disclosure_withdrawn' | 'disclosure_added' | 'value_changed';

/**
 * Comma-separated multi-select values as a comparable set. "Heart attack, angina
 * or stroke" is one option, not three, so only top-level commas split — the
 * insurer joins the words within an option using "or", never a comma.
 */
function answerSet(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((v) => normaliseAnswer(v))
      .filter((v) => v !== '')
  );
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * What changed between the first recorded answer and the submitted one.
 *
 * `disclosure_withdrawn` is the case worth a supervisor's time: something was
 * disclosed and then taken back, so the submitted document shows no trace of it.
 * Real examples from three sales — a mental-health answer entered as "Stress"
 * and returned to "None of these" a minute later, and "have you ever stopped
 * taking prescribed treatment without medical advice" changed from No to Yes.
 *
 * This is a signal, not a finding. Most amendments are an answer being corrected
 * as the conversation goes on, which is exactly what should happen. What makes it
 * worth surfacing is that the final document hides it, and the recording can
 * settle it.
 */
export function classifyAmendment(
  finalAnswer: string | null,
  revisions: Array<{ value: string }>
): AmendmentType | null {
  if (!revisions || revisions.length === 0) return null;
  if (finalAnswer === null || finalAnswer.trim() === '') return 'value_changed';

  const first = revisions[0]!.value;
  if (normaliseAnswer(first) === normaliseAnswer(finalAnswer)) {
    // Ended where it started, having been something else in between — the
    // "Stress" case. The round trip is the whole point, so it is not "no change".
    const wandered = revisions.some((r) => normaliseAnswer(r.value) !== normaliseAnswer(finalAnswer));
    if (!wandered) return null;
    const anyPositive = revisions.some((r) => polarity(r.value) !== 'no' && normaliseAnswer(r.value) !== normaliseAnswer(finalAnswer));
    return anyPositive && polarity(finalAnswer) === 'no' ? 'disclosure_withdrawn' : 'value_changed';
  }

  const firstPolarity = polarity(first);
  const finalPolarity = polarity(finalAnswer);
  if (firstPolarity && finalPolarity && firstPolarity !== finalPolarity) {
    // "No" -> "Yes" discloses more; "Yes" -> "No" takes it back.
    return finalPolarity === 'no' ? 'disclosure_withdrawn' : 'disclosure_added';
  }
  // A positive answer replaced by an explicit negative, where the positive is
  // not itself a yes/no ("Stress" -> "None of these").
  if (!firstPolarity && finalPolarity === 'no') return 'disclosure_withdrawn';
  if (firstPolarity === 'no' && !finalPolarity) return 'disclosure_added';

  // Multi-selects: did the submitted answer keep everything that was there?
  const firstSet = answerSet(first);
  const finalSet = answerSet(finalAnswer);
  if (firstSet.size > 0 && finalSet.size > 0) {
    const grew = isSubset(firstSet, finalSet) && finalSet.size > firstSet.size;
    const shrank = isSubset(finalSet, firstSet) && finalSet.size < firstSet.size;
    if (grew) return 'disclosure_added';
    if (shrank) return 'disclosure_withdrawn';
  }

  return 'value_changed';
}

/** Amendment types warranting a supervisor's attention on their own. */
export function isAmendmentActionable(type: AmendmentType | null): boolean {
  return type === 'disclosure_withdrawn';
}

export interface ClassifyInput {
  /** What the insurer's document recorded. null = the insurer marked it unanswered. */
  applicationAnswer: string | null;
  /** The customer's answer as extracted from the call, where one was found. */
  callAnswer: string | null;
  /** True when the question was covered but its value was redacted out. */
  callAnswerRedacted: boolean;
  /** Whether the question's terms were found in the transcript at all. */
  evidenceFound: boolean;
  /** Whether absence of those terms is meaningful — see absenceIsMeaningful. */
  absenceMeaningful: boolean;
  /** Whether this transcript shows health redaction at all. */
  redactedTranscript: boolean;
  /**
   * Whether the customer demonstrably did NOT answer — the exchange is there to
   * read, and they changed the subject, deflected, or the adviser moved on.
   *
   * Distinct from "no answer could be read", and the distinction is the whole
   * difference between a finding and a shrug. Undefined means nobody established
   * either way, which must not be reported as the customer having failed to
   * answer.
   */
  customerDidNotAnswer?: boolean;
  /**
   * When the call took place, so an answer given as elapsed time ("7 years
   * ago") can be read against the year the application records.
   */
  referenceDate?: Date | null;
}

/**
 * Decide one question's outcome.
 *
 * The important rule is the second one. Where a question's distinctive terms are
 * all ones redaction destroys, and the transcript is redacted, the question
 * resolves to `undetermined` — never `not_asked`. Getting this wrong would put a
 * false allegation on the record against an adviser, on the most serious
 * questions in the application, on every single sale.
 */
export function classifyItem(input: ClassifyInput): ReconciliationOutcome {
  // Nothing was submitted for this question, so there is nothing to verify.
  if (input.applicationAnswer === null || input.applicationAnswer.trim() === '') {
    return 'no_application_answer';
  }

  if (!input.evidenceFound) {
    // THE SAFETY RULE. Absence proves absence only where we can vouch for the
    // terms — they are distinctive enough to be searched for, and nothing would
    // have removed them from the transcript.
    //
    // This used to require redactedTranscript as well, which tied the whole
    // guard to health placeholders being present. Permitting 'phi' for a tenant
    // removes those placeholders, so the guard silently stopped firing and
    // questions it had been protecting fell straight through to 'not_asked' —
    // the single most serious thing this module can say about an adviser.
    // Observed on a live sale within a day of the setting changing: "Uk
    // Resident" and "Telephone" both alleged never asked, on a call where
    // nothing of the sort had been established.
    //
    // absenceMeaningful already carries the whole judgement, so it is now asked
    // on its own. A tenant turning redaction off cannot quietly convert
    // "we could not tell" into an accusation.
    if (!input.absenceMeaningful) return 'undetermined';
    // The application carries an answer and the call shows no trace of the
    // question being put. This is the serious one: the form was completed
    // without asking.
    return 'not_asked';
  }

  if (input.callAnswer === null || input.callAnswer.trim() === '') {
    // Covered on the call, but the value never reached storage. We know they
    // answered; we cannot see what they said, so we cannot compare.
    if (input.callAnswerRedacted) return 'undetermined';
    // "We could not read an answer" and "the customer did not answer" are not
    // the same claim, and collapsing them was expensive: 252 of one tenant's 448
    // items alleged an adviser had taken an answer nobody gave, when what had
    // actually happened was that we read the wrong 400 characters of the call.
    //
    // Only the stronger claim is a finding, and only the model can make it,
    // because it requires having seen the exchange run past the question. Absent
    // that, this is 'undetermined' — the honest "we could not tell" — which is
    // deliberately not actionable and so cannot bury the real flags.
    if (input.customerDidNotAnswer === true) return 'asked_no_answer';
    return 'undetermined';
  }

  const comparison = compareAnswers(
    input.applicationAnswer,
    input.callAnswer,
    input.referenceDate ?? null
  );
  if (comparison === 'unclear') return 'undetermined';
  return comparison;
}

/**
 * Outcomes that warrant a supervisor's attention. `undetermined` is deliberately
 * excluded: it means the system could not tell, and surfacing it as a finding
 * would bury the real flags under noise generated by our own redaction.
 */
export const ACTIONABLE_OUTCOMES: ReconciliationOutcome[] = [
  'mismatch',
  'not_asked',
  'asked_no_answer',
];

export function isActionable(outcome: ReconciliationOutcome): boolean {
  return ACTIONABLE_OUTCOMES.includes(outcome);
}
