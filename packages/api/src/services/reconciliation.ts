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
  | 'recorded'
  | 'missing_from_application'
  | 'undetermined';

/** See QuestionCheckMode in @callguard/shared — kept in step with it. */
export type QuestionCheckMode = 'reconcile' | 'presence' | 'none';

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
 * Terms an adviser would have to SAY in order to put the question at all.
 *
 * A second, independent bar from surviving redaction, and conflating the two was
 * a real bug. REDACTION_RESISTANT_STEMS answers "would the provider strip this
 * word from the transcript?" — a fact about our own pipeline. This answers
 * "would the adviser have used this word?" — a fact about how people talk. For
 * `smoke` or `pint` both answers are yes and nothing distinguished them. For
 * `occupation` the first is yes and the second is emphatically no: an adviser
 * says "what do you do for work?", never "what is your occupation?". Reusing one
 * list for both meant the insurer's field label "Occupation" was treated as
 * proof, and six advisers were recorded as never having asked about employment
 * on sales where they plainly had.
 *
 * The omissions are the content of this list, so they are stated:
 *
 *   occupation, employment, employed  — form labels. Nobody speaks them.
 *   income, salary, earnings          — the adviser asks "what do you take
 *                                       home", "what are you on". Too easily
 *                                       absent from a call that covered it.
 *   height                            — the question is "how tall are you?".
 *   medication, prescription          — "are you on anything from the doctor?"
 *   unit, units                       — means two unrelated things. Alcohol
 *                                       units in a health question, and units
 *                                       of cover on MetLife's "No. of Units".
 *                                       Costs nothing to drop: the alcohol
 *                                       question still carries `alcohol` and
 *                                       `drink`, while "No. of Units" has no
 *                                       other term and stops accusing.
 *
 * Erring toward omission is the safe direction: a term left out downgrades a
 * would-be `not_asked` to `undetermined`, which under-reports. A term wrongly
 * included produces an allegation against a named adviser. Add only what an
 * adviser could not avoid saying.
 */
const SPOKEN_VERBATIM_STEMS = new Set(
  [
    'smoke', 'smoked', 'smoking', 'vape', 'vaped', 'cigarette', 'cigarettes',
    'tobacco', 'nicotine',
    'alcohol', 'drink', 'drinking', 'pint', 'wine', 'spirits',
    'weight', 'stone', 'kilo', 'kilos',
    'blood', 'pressure', 'cholesterol', 'heart',
    'tablet', 'tablets', 'treatment',
    'doctor', 'surgery', 'specialist', 'hospital', 'consultant',
    'job', 'work',
    'driving', 'drive', 'driver', 'travel', 'sport', 'sports',
  ].map(stem)
);
SPOKEN_VERBATIM_STEMS.add('gp');

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
  // BOTH conditions, on the same term. A term that survives redaction but that
  // an adviser would never utter proves nothing by its absence, and a term an
  // adviser always utters proves nothing if redaction removes it. Only a term
  // that clears both bars can carry the claim.
  return terms.some((t) => REDACTION_RESISTANT_STEMS.has(t) && SPOKEN_VERBATIM_STEMS.has(t));
}

/**
 * How many times one search term may match before the first hit is a coin flip.
 *
 * Three. Measured across 18 MetLife sales: "No. of Units" matches a median of
 * four times per call and never fewer than four, because "unit" is also how
 * alcohol is measured. Two matches could be the same exchange mentioned twice;
 * from three separate places there is no basis for reading the first one.
 */
const COINCIDENTAL_HIT_THRESHOLD = 3;

/**
 * Was this question located, or did one of its words merely turn up?
 *
 * A question carrying a single searchable term is identified by that term alone,
 * so if the term is a common word the located passage is whichever place it
 * happened to appear first. The excerpt then goes to the model, which reads a
 * passage about something else and reports honestly on what it was given — and
 * that becomes a finding about how an adviser ran a call.
 *
 * Deliberately requires BOTH conditions. One term matching once or twice is
 * ordinary and usable. Many hits across several terms is a well-identified
 * question mentioned often, which is fine. And a single term matching NOTHING is
 * not coincidental at all — it resolves 'undetermined' through the normal path,
 * which is what "UK Residency" does on every sale.
 */
export function coincidentalEvidence(terms: string[], hitCount: number): boolean {
  return terms.length <= 1 && hitCount >= COINCIDENTAL_HIT_THRESHOLD;
}

/**
 * Fields the insurer generates, which cannot have been discussed on the call.
 *
 * A policy number does not exist while the sale is happening — it is issued on
 * submission — so searching a call for it is not a check that can pass. Left in
 * the comparison it produces an item that is permanently unverifiable, and a
 * reviewer has no way to tell that apart from one we merely failed to find.
 *
 * Deliberately narrow. "Date of application" and a policy reference are the
 * only fields observed that a customer could not in principle have stated;
 * everything else on a summary sheet — name, address, date of birth, premium,
 * direct debit date — IS said out loud and is worth checking.
 */
const INSURER_GENERATED =
  /^\s*(policy|plan|application|quote|reference|agency|scheme)\s*(number|no\.?|ref(erence)?|id)\s*:?\s*$|^\s*date of (application|issue|submission)\s*:?\s*$/i;

export function isInsurerGenerated(question: string): boolean {
  return INSURER_GENERATED.test(question.trim());
}

/**
 * The customer's bank account identifiers, which cannot be checked against a
 * recording even in principle.
 *
 * Two independent reasons, either of which would be enough. The insurer masks
 * what it stores — "XX-XX-38", "XXXXX-388" — so there is no value to compare;
 * and the fragments that survive are short digit runs that match a transcript
 * somewhere by coincidence, which is worse than not matching at all. A stray
 * "38" gets located, the model is handed a passage about something else, it
 * correctly reports no account number in it, and that becomes 'asked_no_answer'
 * — an allegation about how the adviser ran the call, from a coincidence. One
 * sale ranked worst in its tenant on eight such items, none of them real.
 *
 * Even unmasked it would not work: customers read digits back in pieces ("oh
 * seven nine... oh seven..."), so absence of a contiguous match proves nothing.
 *
 * As narrow as INSURER_GENERATED, and for the same reason — this switches off a
 * compliance check, so it must catch the identifiers and nothing adjacent to
 * them. "Bank account held in payers name" and "Direct Debit allowed from
 * account" both deliberately fall outside it: those are asked out loud ("the
 * sort code and account number, is that in your name?") and are worth checking.
 */
const BANK_ACCOUNT_DETAIL =
  /^\s*(bank\s+|building\s+society\s+)?(account|a\/c)\s*(number|no\.?|num)\s*:?\s*$|^\s*(account\s+|bank\s+)?sort\s*-?\s*code\s*:?\s*$|^\s*iban\s*:?\s*$|^\s*(building\s+society\s+)?roll\s*(number|no\.?)\s*:?\s*$/i;

export function isBankAccountDetail(question: string): boolean {
  return BANK_ACCOUNT_DETAIL.test(question.trim());
}

/**
 * A tickbox on the form, not a question put to the customer.
 *
 * "Please confirm you have read this statement by clicking this box." is an
 * instruction to the person filling in the portal. Nobody says it aloud, and
 * nobody answers it aloud, so comparing it against a recording produces an
 * accusation from a certainty: the words will never be found, so an
 * absence-meaningful reading makes it 'asked_no_answer' — the adviser recorded a
 * declaration without putting it to the customer — on every sale carrying the
 * form. Observed once on a live tenant, on a Legal & General application.
 *
 * 'none' rather than 'presence': the box being ticked is what submitting the
 * application means, so its being populated says nothing either.
 *
 * Anchored on the instruction, not on the word "confirm". "Can I just confirm
 * your date of birth" and "confirmed happy with cover" are spoken questions and
 * must stay comparable, so this requires the box itself to be named.
 */
const FORM_DECLARATION =
  /\b(clicking|ticking|checking|selecting)\s+(this|the)\s+box\b|\bby\s+(ticking|checking)\b|\btick\s+(this|the)\s+box\b/i;

export function isFormDeclaration(question: string): boolean {
  return FORM_DECLARATION.test(question.trim());
}

/**
 * How a field should be checked, absent a human's ruling on the profile.
 *
 * A default is required rather than optional: three of one tenant's profiles
 * went live by corroboration with nobody reviewing them, so a mode that only
 * ever came from a person would never be set on the formats doing most of the
 * work.
 *
 * Order matters only in that the two special cases are disjoint; anything not
 * recognised is compared against the call, which is the behaviour every question
 * had before modes existed. Widening a case here silently stops a check running,
 * so both predicates stay anchored and narrow.
 */
export function defaultCheckMode(question: string): QuestionCheckMode {
  if (isInsurerGenerated(question)) return 'none';
  if (isFormDeclaration(question)) return 'none';
  if (isBankAccountDetail(question)) return 'presence';
  return 'reconcile';
}

/**
 * Distinctive strings from the SUBMITTED ANSWER, to search the call for.
 *
 * The ordinary technique searches for the question's own wording, which works
 * where the question is a question: "have you smoked" finds "do you smoke". It
 * fails completely on a summary sheet, where the "question" is a form label
 * nobody speaks. Searching a transcript for "Telephone" or "DOB" finds nothing
 * on a call where the customer plainly gave both, and the item resolves
 * unverifiable — fifteen genuinely checkable identity fields per sale, inert.
 *
 * So for these, search for the ANSWER instead. A phone number, a year of birth
 * and an email local-part are far more distinctive than any label, and the
 * customer said them aloud. Finding one produces the excerpt the model then
 * reads, which is the step that was never being reached.
 *
 * Note what this deliberately does NOT do: it does not make absence meaningful.
 * A value that cannot be found stays 'undetermined', because a customer reading
 * digits back in fragments ("oh seven nine... oh seven...") is normal and its
 * absence proves nothing. The gain is entirely on the finding side.
 */
/**
 * Distinctive strings from the OPTIONS the question offered, to search for.
 *
 * A list-selection health question carries almost none of its meaning in its own
 * wording. The portal prints "Have you ever:" or "Have you ever had any of
 * these?" and puts the substance underneath, in the list the adviser reads out:
 * cancer, leukaemia, multiple sclerosis, Parkinson's. Searching a call for the
 * wording alone finds nothing distinctive, so the question was never located,
 * never sent to be read, and resolved 'undetermined' — 39 items on one tenant,
 * the largest single named cause in its unresolved pile, and all of them health
 * disclosure questions.
 *
 * That the adviser genuinely says these words is not an assumption. It is
 * visible in the evidence of the questions that DO resolve, whose option lists
 * happened to survive as guidance text:
 *
 *     "...have you ever had any of these? Cancer, cancer in situ, leukaemia,
 *      Hodgkin's disease, or any of the tumour? Nope."
 *
 * Like the answer terms, and for the same reason, these FIND evidence and never
 * condemn its absence. An adviser is entitled to put a long list in their own
 * words — "any of the usual heart conditions?" — so no option appearing verbatim
 * is not proof the question went unasked. absenceIsMeaningful continues to see
 * only the question's own wording, so nothing here can produce an accusation
 * that the wording alone would not already have produced.
 */
export function deriveChoiceTerms(choices: string[] | undefined): string[] {
  if (!choices || choices.length === 0) return [];
  // The options that are answers rather than content. Every list ends with one,
  // and they are the words least worth searching for: "no" and "none" appear in
  // every call ever recorded.
  const NON_CONTENT = /^(no|yes|none of these|neither of these|i don'?t know|other)$/i;
  const content = choices.filter((c) => !NON_CONTENT.test(c.trim()));
  if (content.length === 0) return [];
  return deriveSearchTerms(content.join(' '));
}

export function deriveAnswerTerms(answer: string | null): string[] {
  if (!answer) return [];
  const terms = new Set<string>();
  const value = answer.trim();

  // A year, which is how a date of birth is actually identifiable in speech —
  // "fourth of May nineteen seventy-three" shares nothing with 04/05/1973
  // except the year.
  for (const m of value.matchAll(/\b(19|20)\d{2}\b/g)) terms.add(m[0]);

  // Digit runs, separators stripped, as a phone number or an account reference
  // is written on a form but grouped differently when read aloud ("07907
  // 769991"). The tail is what stays stable across groupings, so both the whole
  // run and its last six digits are offered.
  const digitsOnly = value.replace(/[^\d]/g, '');
  if (digitsOnly.length >= 7) {
    terms.add(digitsOnly);
    terms.add(digitsOnly.slice(-6));
  }

  // The local part of an email, which is usually the customer's own name or
  // handle and is spoken in full when they give the address.
  const email = /([a-z0-9._%+-]{3,})@/i.exec(value);
  if (email) terms.add(email[1]!.toLowerCase());

  // A postcode's outward code, distinctive and said as one token.
  const postcode = /\b([a-z]{1,2}\d[a-z\d]?)\s*\d[a-z]{2}\b/i.exec(value);
  if (postcode) terms.add(postcode[1]!.toLowerCase());

  return [...terms];
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
  // Every place the topic comes up, not just the first few. A window is a run of
  // hits close enough together to be one passage.
  const windows: Array<{ index: number; terms: Set<string> }> = [];
  for (const hit of hits) {
    const current = windows[windows.length - 1];
    // Within the span already covered: the same passage, not a new one.
    if (current !== undefined && hit.index - current.index < width * 0.75) {
      current.terms.add(hit.term);
      continue;
    }
    windows.push({ index: hit.index, terms: new Set([hit.term]) });
  }

  // Choose the RICHEST windows — the ones matching most of the question's
  // distinct terms — rather than the earliest.
  //
  // Position is close to meaningless here. A sale runs 40 minutes and a topic is
  // raised over and over: the adviser trails it, covers it, refers back to it,
  // and the customer mentions it in passing. Real questions had 12, 16 and 18
  // separate windows, and the first three were being taken from that.
  //
  // Measured over one tenant: of the undetermined items whose topic WAS found in
  // the call, 63% had a discarded window matching more of the question's terms
  // than any window sent. On one, the answer the insurer recorded — "2022, blood
  // test, discomfort, fully recovered" — sat in a window matching NINE terms,
  // discarded in favour of three matching one, and the item resolved "no clear
  // answer in the passages". The evidence was already in hand; only the choice
  // of which to look at was wrong.
  //
  // Ties break by position, so a question whose windows all match equally — a
  // single-term search, the common case for an identity field — behaves exactly
  // as it did before.
  const chosen = [...windows]
    .sort((a, b) => b.terms.size - a.terms.size || a.index - b.index)
    .slice(0, maxExcerpts)
    // Back into the order they occur in the call, because the passages are read
    // as a sequence and an answer often refers back to what came before it.
    .sort((a, b) => a.index - b.index);

  const excerpts: string[] = [];
  for (const window of chosen) {
    const quote = quoteExchange(transcript, window.index, width);
    if (quote !== '') excerpts.push(quote);
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

/**
 * A polar answer followed by the detail that makes it worth having.
 *
 * Requires a real delimiter — "Yes, inhaler as a child", "Yes - £50,000 for
 * daughter", "Yes — father, bowel cancer at 58". That is what separates a
 * qualified answer from a noun phrase that merely begins with a polar word:
 * MetLife's "No Premium details" has no delimiter and stays unreadable, which
 * is correct, because it is a field value rather than someone saying "no".
 *
 * Matched on the RAW value, before normaliseAnswer replaces the punctuation
 * with spaces and destroys the very boundary this depends on.
 */
const QUALIFIED_POLAR = /^\s*([a-z]+)\s*[,;:—–-]+\s*(\S[\s\S]*)$/i;

/**
 * Words that take back the answer in front of them.
 *
 * "No, but I did have asthma as a child" leads with a negative and means the
 * opposite, so reading its first word would invent a mismatch against a form
 * that correctly says Yes. Where one of these appears the answer stays
 * unreadable, which is the safe direction: silence rather than a false
 * allegation.
 */
const HEDGES = new Set(['but', 'although', 'though', 'however', 'except', 'unless', 'apart']);

/**
 * Yes, no, or neither.
 *
 * The qualified case is not a nicety. Exact whole-string matching meant only a
 * bare "Yes" ever compared, so the module lost a finding precisely when the
 * customer said something specific — and a customer being specific is what a
 * disclosure IS. On one real sale the model extracted "Yes - £50,000 for
 * daughter" against an application recording "No", and the comparison returned
 * unclear: a child-cover non-disclosure, correctly read from the call, reported
 * as "could not verify".
 */
function polarity(value: string): 'yes' | 'no' | null {
  const n = normaliseAnswer(value);
  // Whole-string first, so the multi-word negatives above are never split.
  if (AFFIRMATIVE.has(n)) return 'yes';
  if (NEGATIVE.has(n)) return 'no';

  const m = QUALIFIED_POLAR.exec(value.trim());
  if (!m) return null;
  const lead = normaliseAnswer(m[1] ?? '');
  const isYes = AFFIRMATIVE.has(lead);
  const isNo = NEGATIVE.has(lead);
  if (!isYes && !isNo) return null;
  if (normaliseAnswer(m[2] ?? '').split(' ').some((w) => HEDGES.has(w))) return null;
  return isYes ? 'yes' : 'no';
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
const RELATIVE_YEARS = /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)\s*(?:ago|back)/;

/** A four-digit year, as distinct from a count of anything. */
function isYear(n: number): boolean {
  return Number.isInteger(n) && n >= 1900 && n <= 2099;
}

/**
 * The smallest sum at which people start rounding when they speak. Below it a
 * difference is a different number, not the same number said loosely: 22 against
 * 36 is a real disagreement about a premium, and 5 cigarettes against 50 is the
 * mis-keying the numeric rule exists to catch.
 */
const ROUNDING_FLOOR = 1000;

/** How far apart two large figures may be and still be the same figure. */
const ROUNDING_TOLERANCE = 0.01;

/**
 * Is one of these the other, rounded — the way a person says a large number?
 *
 * A customer asked their income says "about £48,000". The adviser writes down
 * what the payslip says: 48250. Compared as bare numbers those disagree, and the
 * module reported a mismatch at 0.95 confidence — an adviser accused of
 * recording an income the customer never gave, over £250 on a figure the
 * customer explicitly approximated.
 *
 * Deliberately relative and deliberately tight. The numeric rule exists to catch
 * mis-keying — a digit dropped, a figure transposed — and every one of those is
 * an order-of-magnitude error, not a 0.5% one. One percent is far below the
 * smallest mis-keying that can occur and far above the rounding people do out
 * loud, so it separates the two cleanly rather than trading one off against the
 * other.
 *
 * The floor matters as much as the tolerance: without it, a percentage of a
 * small number is a fraction of a unit and this would decide nothing, while
 * "2 pints" against "3 pints" must stay a disagreement.
 */
function isRounded(a: number, b: number): boolean {
  if (a < ROUNDING_FLOOR || b < ROUNDING_FLOOR) return false;
  return Math.abs(a - b) / Math.max(a, b) <= ROUNDING_TOLERANCE;
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
    // Fractions folded first, in both notations people use aloud. Without this
    // the leading digits of "3.5 years ago" are skipped and the FIVE is taken as
    // the whole figure: on a real sale that read as 2021 against a form saying
    // 2023 and was reported as the adviser recording a year the customer never
    // gave. It is the same fault as "16 and a half stone", in a different unit —
    // a half the pattern could not see, turned into an accusation.
    const elapsed = RELATIVE_YEARS.exec(foldSpokenFractions(normaliseAnswer(elapsedSide)));
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

/**
 * Weight units in any spelling, for telling "this states no unit" apart from
 * "this states one and we failed to read it". The distinction is the whole
 * safety of compareBareWeight below.
 */
const WEIGHT_UNIT = /\b(?:kg|kilo(?:gram)?s?|st|stones?|lbs?|pounds?)\b/;

/**
 * "16 and a half stone", as people actually say a weight aloud.
 *
 * The digits are not adjacent to the unit, so the patterns below cannot see the
 * figure at all — and the half is 3.2kg, which is the whole distance between a
 * match and an accusation.
 */
function foldSpokenFractions(text: string): string {
  return text
    .replace(/(\d+)\s+and\s+a\s+half\b/g, (_m, d: string) => `${Number(d) + 0.5}`)
    .replace(/(\d+)\s+and\s+a\s+quarter\b/g, (_m, d: string) => `${Number(d) + 0.25}`)
    .replace(/(\d+)\s+and\s+three\s+quarters\b/g, (_m, d: string) => `${Number(d) + 0.75}`);
}

export function weightInKg(text: string): number | null {
  const n = foldSpokenFractions(normaliseAnswer(text));
  const kg = /(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?)\b/.exec(n);
  if (kg) return Number(kg[1]);
  const stone = /(\d+(?:\.\d+)?)\s*(?:st|stones?)\b(?:\s*(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)?\b)?/.exec(n);
  if (stone) return Number(stone[1]) * KG_PER_STONE + (stone[2] ? Number(stone[2]) * KG_PER_POUND : 0);
  const pounds = /(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\b/.exec(n);
  if (pounds) return Number(pounds[1]) * KG_PER_POUND;
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};


/**
 * Every date this text could plausibly be, as UTC epoch milliseconds.
 *
 * Ambiguity is preserved rather than resolved: a numeric 03/04/1957 yields both
 * readings, and a contradiction is only claimed when no reading of one side
 * matches any reading of the other. A written month ("20 October 1962",
 * "August 26, 2005") is unambiguous and yields one.
 */
export function dateCandidates(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  const push = (y: number, m: number, d: number): void => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    if (y < 1900 || y > 2100) return;
    const t = Date.UTC(y, m - 1, d);
    // Rejects 31/02 and friends: the constructed date rolls over to March.
    const back = new Date(t);
    if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return;
    out.add(t);
  };

  const s = text.toLowerCase();

  // Written month, either order: "20 october 1962", "october 20 1962",
  // "august 26, 2005".
  const wordRe = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?\s+(\d{4})\b|\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
  for (const m of s.matchAll(wordRe)) {
    if (m[1]) {
      const mon = MONTHS[m[2]!.slice(0, 3)];
      if (mon) push(Number(m[3]), mon, Number(m[1]));
    } else {
      const mon = MONTHS[m[4]!.slice(0, 3)];
      if (mon) push(Number(m[6]), mon, Number(m[5]));
    }
  }

  // Numeric, separated by / - or . — both field orders, plus ISO.
  const numRe = /\b(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g;
  for (const m of s.matchAll(numRe)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    if (m[1]!.length === 4) {
      // ISO: yyyy-mm-dd. One reading only.
      push(a, b, c);
      continue;
    }
    const year = c < 100 ? (c <= new Date().getUTCFullYear() % 100 ? 2000 + c : 1900 + c) : c;
    push(year, b, a); // dd/mm/yyyy
    push(year, a, b); // mm/dd/yyyy
  }

  return [...out];
}

/**
 * A height in centimetres, every reading the text could plausibly be.
 *
 * The same problem as weight, one conversion further out: insurers record metric
 * and customers speak imperial, and comparing the bare numbers declared them a
 * contradiction. "6 foot" against a stored 1.83 was reported as a mismatch at
 * 0.95 confidence on a live sale — with the model's own reasoning ending "so this
 * matches". Across the first deploying firm, 31 height comparisons produced 4
 * usable verdicts: 24 undetermined and 3 mismatches, and all three mismatches
 * were the same height in different units.
 *
 * WHY A SET OF READINGS RATHER THAN ONE VALUE
 *
 * The application side is usually a bare number with no unit at all — "1.83",
 * "1.7", "183" — so there is nothing to read the unit from. Rather than guess,
 * every unit it could be is generated and implausible ones dropped: 1.83 is
 * 183cm as metres, 1.83cm as centimetres and 55cm as feet, and only the first is
 * a person. That filter does the disambiguation without a rule about which
 * format which insurer uses, and it is why "6" alone reads as six foot while
 * "183" alone reads as centimetres.
 *
 * Agreement under ANY pair of readings is agreement — two heights landing within
 * an inch of each other by coincidence does not happen. Disagreement under every
 * reading is a genuine mismatch, so a real mis-keying (1.83 against 1.63) still
 * reports.
 */
const CM_PER_INCH = 2.54;
const CM_PER_FOOT = 30.48;

// Human heights. Anything outside is a misread unit, not a person.
const MIN_HUMAN_CM = 120;
const MAX_HUMAN_CM = 220;

/** Spoken feet and inches, as people actually say a height aloud. */
const HEIGHT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function foldHeightWords(text: string): string {
  return text.replace(/\b([a-z]+)\b/g, (m, w: string) =>
    HEIGHT_WORDS[w] === undefined ? m : String(HEIGHT_WORDS[w])
  );
}

export function heightCandidatesCm(text: string): number[] {
  const n = foldHeightWords(normaliseAnswer(text));
  const out = new Set<number>();
  const add = (cm: number): void => {
    if (cm >= MIN_HUMAN_CM && cm <= MAX_HUMAN_CM) out.add(Math.round(cm * 100) / 100);
  };

  // Explicit units first. A stated unit is not a guess, so these are added
  // whatever else the string contains.
  for (const m of n.matchAll(/(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/g)) add(Number(m[1]) * 100);
  for (const m of n.matchAll(/(\d+(?:\.\d+)?)\s*(?:cm|centimetres?|centimeters?)\b/g)) add(Number(m[1]));
  // Feet, with optional inches: 6 foot, 5'7", 5 ft 7 in, 6 feet 4 inches.
  for (const m of n.matchAll(
    /(\d+)\s*(?:'|ft\b|feet\b|foot\b)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|''|in\b|ins\b|inches?\b)?)?/g
  )) {
    add(Number(m[1]) * CM_PER_FOOT + (m[2] ? Number(m[2]) * CM_PER_INCH : 0));
  }

  if (out.size > 0) return [...out];

  // No unit stated anywhere. Two bare numbers read as feet and inches — "5 7",
  // "5 5" — which is how a height comes back when the unit was spoken once and
  // the transcript kept only the figures.
  const pair = /^(\d{1,2})\s+(\d{1,2})$/.exec(n.trim());
  if (pair) {
    add(Number(pair[1]) * CM_PER_FOOT + Number(pair[2]) * CM_PER_INCH);
    return [...out];
  }

  // One bare number: try every unit it could be and keep the plausible ones.
  const bare = /^(\d+(?:\.\d+)?)$/.exec(n.trim());
  if (bare) {
    const v = Number(bare[1]);
    add(v * 100); // metres
    add(v); // centimetres
    add(v * CM_PER_FOOT); // feet
  }
  return [...out];
}

/**
 * An inch and a bit either way. A height spoken to the nearest inch against a
 * form field converted to two decimals differs by up to half an inch before
 * anyone has made a mistake; 3cm covers that and stays far below a real
 * mis-keying, which moves a height by a decimetre or more.
 */
const HEIGHT_TOLERANCE_CM = 3;

function compareHeights(applicationAnswer: string, callAnswer: string): AnswerComparison | null {
  const app = heightCandidatesCm(applicationAnswer);
  const call = heightCandidatesCm(callAnswer);
  if (app.length === 0 || call.length === 0) return null;
  for (const a of app) {
    for (const c of call) {
      if (Math.abs(a - c) <= HEIGHT_TOLERANCE_CM) return 'match';
    }
  }
  return 'mismatch';
}

/**
 * Two dates, compared as dates rather than as strings.
 *
 * A date of birth written 20/05/1995 on the form and read back 05/20/1995 on the
 * call is one date in two field orders, and the numeric rule below sees three
 * numbers on each side and returns 'unclear'. Across the first deploying firm
 * that left 22 of 51 date-of-birth comparisons unresolved — and buried three
 * genuine discrepancies among them, indistinguishable on screen from the
 * format-only cases.
 *
 * dateCandidates keeps every reading of an ambiguous numeric date, so a match
 * requires only that some reading of each side agrees. Disjoint readings ARE a
 * mismatch: a differing day-of-month or year is a real discrepancy, whatever
 * order the fields are in.
 */
/**
 * A month and year with no day, as YYYYMM.
 *
 * Insurers ask "when did you last have this?" and get a month: the form stores
 * "10/2025" and the customer says "October 2025". Neither carries a day, so
 * dateCandidates finds nothing on either side and the item resolved
 * 'undetermined' — observed on a live sale's cataract-operation date, at 0.90
 * confidence, on two values that plainly agree.
 *
 * Deliberately kept out of dateCandidates. That function feeds the identity
 * guard, which decides whether a whole run is about the right person, and
 * month-precision readings there would let a February and a February eleven years
 * apart look comparable.
 */
function monthCandidates(text: string): number[] {
  const out = new Set<number>();
  const s = text.toLowerCase();
  for (const m of s.matchAll(/\b([a-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mon = MONTHS[m[1]!.slice(0, 3)];
    if (mon) out.add(Number(m[2]) * 100 + mon);
  }
  for (const m of s.matchAll(/\b(\d{1,2})\s*[/\-.]\s*(\d{4})\b/g)) {
    const mon = Number(m[1]);
    if (mon >= 1 && mon <= 12) out.add(Number(m[2]) * 100 + mon);
  }
  return [...out];
}

function compareDates(applicationAnswer: string, callAnswer: string): AnswerComparison | null {
  const app = dateCandidates(applicationAnswer);
  const call = dateCandidates(callAnswer);
  if (app.length > 0 && call.length > 0) {
    return app.some((a) => call.includes(a)) ? 'match' : 'mismatch';
  }
  // Neither side carries a full date. Fall back to month precision — but only
  // when BOTH sides lack a day, so a month-precision reading is never compared
  // against a full date it cannot properly disagree with.
  if (app.length === 0 && call.length === 0) {
    const appMonths = monthCandidates(applicationAnswer);
    const callMonths = monthCandidates(callAnswer);
    if (appMonths.length === 0 || callMonths.length === 0) return null;
    return appMonths.some((a) => callMonths.includes(a)) ? 'match' : 'mismatch';
  }
  return null;
}

/**
 * Both sides a bare number, and one could be the other in different units.
 *
 * compareBareWeight handles the common case, where ONE side names a unit and the
 * conversion can be tried against it. Neither naming one is different and the
 * numeric rule below decides it anyway: "65" against "145" on "How much do you
 * weigh?" was reported as a mismatch, and 65 kg is 143 lb. Same person, two
 * units, no unit written down on either side — and an accusation on a health
 * field as a result.
 *
 * Returns 'unclear' rather than 'match', deliberately. Nothing here establishes
 * that they agree; what it establishes is that the figures are consistent with
 * one conversion, which is not a basis for a finding either way. A real
 * mis-keying — 80 against a spoken "120 to 130 kilograms" — survives, because no
 * conversion reconciles it.
 *
 * Only the conversions people actually use for their own weight, and only where
 * both readings land on a plausible human weight, so two unrelated small numbers
 * cannot reconcile by arithmetic accident.
 */
const MIN_HUMAN_KG = 35;
const MAX_HUMAN_KG = 250;

function bareUnitConfusion(applicationAnswer: string, callAnswer: string): AnswerComparison | null {
  const app = numbersIn(applicationAnswer);
  const call = numbersIn(callAnswer);
  if (app.length !== 1 || call.length !== 1) return null;
  // A stated unit anywhere means this is not the case being handled.
  if (WEIGHT_UNIT.test(normaliseAnswer(applicationAnswer))) return null;
  if (WEIGHT_UNIT.test(normaliseAnswer(callAnswer))) return null;

  const a = app[0]!;
  const b = call[0]!;
  const plausible = (kg: number): boolean => kg >= MIN_HUMAN_KG && kg <= MAX_HUMAN_KG;
  // Each side read as kg, and the other as the imperial equivalent of that kg.
  const readings: Array<[number, number]> = [
    [a, b * KG_PER_POUND],
    [a, b * KG_PER_STONE],
    [b, a * KG_PER_POUND],
    [b, a * KG_PER_STONE],
  ];
  for (const [kg, converted] of readings) {
    if (!plausible(kg) || !plausible(converted)) continue;
    if (sameWeight(kg, converted)) return 'unclear';
  }
  return null;
}

/** A kilogram either way, or 2% on heavier figures: speech against a form field. */
function sameWeight(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1, a * 0.02);
}

/**
 * One side states a weight in units, the other is a bare number with none.
 *
 * An application storing "127.0058636" against a customer saying "20 stone" is
 * a correct conversion recorded to absurd precision, and the bare-number rule
 * below read it as a contradiction at 0.95 confidence. The form does not say
 * what unit that number is in, so the only honest thing to do is try each one
 * it could be: agreement under any reading is agreement, because a number
 * landing within a kilogram of a conversion by chance does not happen.
 *
 * Disagreement under EVERY reading is still a mismatch — the missing unit is
 * then not what separates the two figures, so withholding the finding would
 * lose a genuine mis-keying rather than avoid a false accusation.
 *
 * Returns null when neither side states a unit, or when the bare side is not a
 * single number — nothing here can speak to those.
 */
function compareBareWeight(
  applicationAnswer: string,
  callAnswer: string,
  appKg: number | null,
  callKg: number | null
): AnswerComparison | null {
  const known = appKg ?? callKg;
  if (known === null || (appKg !== null && callKg !== null)) return null;

  const bareSide = appKg === null ? applicationAnswer : callAnswer;

  // Only genuinely bare numbers belong here. A side that names a unit and still
  // would not parse is one whose phrasing beat us, not one missing a unit —
  // "16 and a half stone" did exactly that, and reading its 16 as unit-less
  // turned 105kg and 16st 7lb, the same weight, into a mismatch on a live sale.
  //
  // Says 'unclear' rather than declining, because declining is not neutral
  // here: the bare-number rule further down would then compare 105 against 16
  // as ordinary quantities and reach the same accusation by another route. One
  // side being a weight we could read is enough to know that comparison is
  // meaningless.
  if (WEIGHT_UNIT.test(normaliseAnswer(bareSide))) return 'unclear';

  const bare = numbersIn(bareSide);
  if (bare.length !== 1) return null;
  const stated = bare[0]!;

  const readings = [stated, stated * KG_PER_STONE, stated * KG_PER_POUND];
  return readings.some((kg) => sameWeight(known, kg)) ? 'match' : 'mismatch';
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
 * True if `needle` occurs in `haystack` as a whole phrase rather than an
 * arbitrary substring: the match must begin at the start of the string or
 * straight after a space, and end at the end of the string or straight
 * before a space. Deliberately not a regex — the needle is user text that
 * can contain `.` and `/`, which would otherwise need escaping.
 */
function containsAsPhrase(haystack: string, needle: string): boolean {
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const startsClean = at === 0 || haystack[at - 1] === ' ';
    const endsClean = at + needle.length === haystack.length || haystack[at + needle.length] === ' ';
    if (startsClean && endsClean) return true;
    from = at + 1;
  }
}

/**
 * Does a checklist answer cover what the customer named?
 *
 * A list-selection health question stores the OPTION the adviser ticked, and the
 * customer speaks the specific thing they have. The application records "Cancer,
 * cancer-in-situ, leukaemia, Hodgkin's disease or any other tumour" and the call
 * says "Bladder cancer" — the same disclosure, one as a category and one as an
 * instance. Neither string contains the other, so containment misses it, and
 * neither carries a number, so the numeric rule misses it too. On the first
 * deploying firm those resolved 'undetermined' at 0.90–0.95 confidence, on the
 * question class that matters most.
 *
 * WHY EVERY NAMED ITEM MUST BE COVERED
 *
 * A checklist is multi-select, so "the customer named three things and the form
 * records two" is a finding, not a paraphrase. Reporting a match because ONE
 * item lined up would paper over exactly the under-recording this module exists
 * to catch — "Chest pain, Fibromyalgia" against a list holding chest pain but not
 * fibromyalgia is not agreement. Partial coverage returns false and the item
 * stays 'undetermined', which is honest: something is there, and a person should
 * look.
 *
 * WHY THE SMALLER TERM SET IS THE ONE THAT MUST BE COVERED
 *
 * The relationship is asymmetric and runs both ways depending on the pair. A
 * category ("cancer") is a subset of the instance's words ("bladder cancer"); a
 * paraphrase ("changing bowel habit") carries the same words as the option. So
 * the test is that the shorter list is wholly accounted for in the longer, which
 * covers both without letting a single shared modifier decide anything: "Raised
 * cholesterol" against "Raised blood pressure" shares "rais" and is correctly NOT
 * covered, because "cholesterol" is matched by nothing.
 */
function termsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // "chang" against "change", from the stemmer treating -ing and -e differently,
  // and "heart" against "heartbeat", from a compound written both ways.
  const min = Math.min(a.length, b.length);
  return min >= 4 && (a.startsWith(b) || b.startsWith(a));
}

function coveredBy(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return false;
  // Prefix matching only where BOTH sides carry more than one term, so the
  // surrounding words corroborate it.
  //
  // A lone term has no corroboration, and splitting an option list on commas
  // produces them as artefacts: "Impaired, blurred or double vision" yields
  // "Impaired" with its noun gone. Allowed to prefix-match, that fragment would
  // cover "impaired hearing" — a different sense entirely. Required to match
  // exactly, it covers nothing it should not, while the genuine single-term
  // options still work: "cancer" exactly matches a term of "bladder cancer".
  const allowPrefix = needle.length >= 2 && haystack.length >= 2;
  return needle.every((n) =>
    haystack.some((h) => (allowPrefix ? termsMatch(n, h) : n === h))
  );
}

export function checklistCovers(applicationAnswer: string, callAnswer: string): boolean {
  // The option list, as the document prints it. Splitting on commas over-
  // fragments a phrase like "Impaired, blurred or double vision" into parts that
  // have lost their noun, so a single leftover word can never carry a match on
  // its own — hence the two-term minimum on one side or the other below.
  const options = applicationAnswer
    .split(/,| or /i)
    .map((o) => deriveSearchTerms(o))
    .filter((t) => t.length > 0);
  const named = callAnswer
    .split(/,| and /i)
    .map((c) => deriveSearchTerms(c))
    .filter((t) => t.length > 0);
  if (options.length === 0 || named.length === 0) return false;

  return named.every((item) => options.some((option) => coveredBy(item, option) || coveredBy(option, item)));
}

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
  // a few years back". The containment has to land on word boundaries, though —
  // an unanchored substring test reads "£150,000" as containing "£15,000" and
  // "15 cigarettes a day" as containing "5 cigarettes a day", which is a false
  // agreement between numerically different answers, not a paraphrase of the
  // same one.
  if (app.length >= 4 && (containsAsPhrase(call, app) || containsAsPhrase(app, call))) return 'match';

  // Weights first: both sides stating one in recognisable units is decidable by
  // arithmetic, whatever units each chose. Tolerance of a kilogram either way,
  // because "17 stone" is speech and 107.95 is a form field.
  const appKg = weightInKg(applicationAnswer);
  const callKg = weightInKg(callAnswer);
  if (appKg !== null && callKg !== null) {
    return sameWeight(appKg, callKg) ? 'match' : 'mismatch';
  }
  // A count of drinks against a count of units is two different quantities, and
  // only one side of the conversion between them is on the page. Ahead of the
  // bare-number weight reading below, so a lone "2" beside "2 pints" is never
  // taken for a weight.
  if (DRINK_MEASURE.test(normaliseAnswer(callAnswer)) !== DRINK_MEASURE.test(normaliseAnswer(applicationAnswer))) {
    return 'unclear';
  }

  // Heights, on the same principle as weights and for the same reason: the
  // insurer records metric, the customer speaks imperial, and the bare-number
  // rule below reads the two as a contradiction.
  const heights = compareHeights(applicationAnswer, callAnswer);
  if (heights !== null) return heights;

  // Dates as dates, before any rule that counts the numbers in them: a date of
  // birth carries three numbers on each side, which the numeric rule can only
  // ever call 'unclear'.
  const dates = compareDates(applicationAnswer, callAnswer);
  if (dates !== null) return dates;

  const bareWeight = compareBareWeight(applicationAnswer, callAnswer, appKg, callKg);
  if (bareWeight !== null) return bareWeight;

  // A date given as a year against one given as elapsed time is the same fact in
  // two units, and the bare-number rule below reads it as a disagreement.
  const elapsed = compareYearToElapsed(
    applicationAnswer,
    callAnswer,
    referenceDate ? referenceDate.getUTCFullYear() : null
  );
  if (elapsed !== null) return elapsed;

  // Two bare numbers that one unit conversion reconciles. Ahead of the numeric
  // rule, which would call them a contradiction.
  const unitConfusion = bareUnitConfusion(applicationAnswer, callAnswer);
  if (unitConfusion !== null) return unitConfusion;

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
    if (isRounded(appNums[0]!, callNums[0]!)) return 'match';
    return 'mismatch';
  }
  // Last: a checklist category against the specific thing the customer named.
  //
  // Deliberately after every rule that can decide a number or a date. It splits
  // an answer on commas to read the option list, and a comma is also a thousands
  // separator and a date separator — run earlier it read "£150,000" against
  // "£15,000" as two lists rather than two figures, and 09/04/1997 against
  // 19/04/1997 as agreeing. Everything decidable is decided by the time this
  // sees it, so it only judges prose the other rules had no purchase on.
  if (checklistCovers(applicationAnswer, callAnswer)) return 'match';

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
   * Whether the evidence was located by coincidence rather than by recognising
   * the question — see coincidentalEvidence.
   */
  evidenceCoincidental?: boolean;
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
  /**
   * How this field is checked. Defaults to 'reconcile' so every existing caller
   * and every stored item keeps its meaning; the non-default modes short-circuit
   * before any call evidence is consulted.
   */
  checkMode?: QuestionCheckMode;
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
  const mode = input.checkMode ?? 'reconcile';
  const answered =
    input.applicationAnswer !== null && input.applicationAnswer.trim() !== '';

  // A field that cannot be checked against a recording is checked for
  // completion instead, and nothing below this point applies to it: no call
  // evidence is consulted, so no absence of it can mean anything.
  //
  // Note this is the ONE place a blank is a finding. On a 'reconcile' question
  // the same emptiness is 'no_application_answer' and benign, because a
  // conditional follow-up that did not apply is legitimately blank. The mode is
  // what separates "nobody needed to fill this in" from "somebody should have".
  if (mode === 'presence') return answered ? 'recorded' : 'missing_from_application';

  // Never compared, never a finding — the value did not exist during the call.
  // Still reported rather than dropped: it was submitted, and a reviewer may
  // want to see it. Blank stays 'no_application_answer' rather than becoming a
  // finding, because nothing here is required of the adviser.
  //
  // A populated one is 'recorded', the same as under 'presence'. It used to be
  // 'undetermined', and that was wrong in the way this whole module has to avoid:
  // 'undetermined' means "we tried to establish this and could not", and a
  // reviewer reads it as a gap in the checking. A policy number was never going
  // to be checked — deciding not to look is not the same as looking and failing.
  // The two were indistinguishable on screen, and together they put every policy
  // number and application date of one tenant's sales into the unresolved pile,
  // which is where the module's headline "half of all items undetermined" was
  // partly coming from. The modes differ only in what they say about a BLANK.
  if (mode === 'none') return answered ? 'recorded' : 'no_application_answer';

  // Nothing was submitted for this question, so there is nothing to verify.
  // Re-tested against the field rather than reusing `answered`, because this is
  // also what narrows applicationAnswer to non-null for the comparison below.
  const applicationAnswer = input.applicationAnswer;
  if (applicationAnswer === null || applicationAnswer.trim() === '') {
    return 'no_application_answer';
  }

  // Evidence found by coincidence cannot support any conclusion, including a
  // match. If the passage we located is about something else, a value extracted
  // from it is not this question's answer whether or not it happens to agree.
  //
  // Same failure the bank-account rule already guards against — "a stray '38'
  // gets located, the model is handed a passage about something else" — reached
  // by a different route: a question whose entire searchable content is one
  // generic word. Measured on MetLife's summary sheet, "No. of Units" derives the
  // single term "unit", which matches a median of four times per call because the
  // adviser also asks about units of alcohol. Four of that format's five findings
  // came from it, one reading a drinking answer against a cover-units field.
  if (input.evidenceCoincidental) return 'undetermined';

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
    applicationAnswer,
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
  // A field the form had to carry, submitted empty. The only one of these that
  // is not a claim about the call — it is read off the document — but it still
  // needs somebody to act.
  'missing_from_application',
];

export function isActionable(outcome: ReconciliationOutcome): boolean {
  return ACTIONABLE_OUTCOMES.includes(outcome);
}
