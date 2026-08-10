import { describe, it, expect } from 'vitest';
import {
  stem,
  deriveSearchTerms,
  absenceIsMeaningful,
  transcriptRedactsHealth,
  findEvidence,
  quoteAround,
  quoteExchange,
  evidenceExcerpts,
  compareAnswers,
  classifyItem,
  isActionable,
  classifyAmendment,
  isAmendmentActionable,
  type ClassifyInput,
} from './reconciliation.js';

describe('stem', () => {
  it('collapses the forms a question and a spoken answer differ by', () => {
    // The application asks "Have you smoked"; the adviser says "do you smoke",
    // "any smoking". All three must reduce to the same stem.
    expect(stem('smoked')).toBe('smok');
    expect(stem('smoking')).toBe('smok');
    expect(stem('smokes')).toBe('smok');
  });

  it('leaves short words alone rather than mangling them', () => {
    expect(stem('gp')).toBe('gp');
    expect(stem('job')).toBe('job');
  });
});

describe('deriveSearchTerms', () => {
  it('keeps the distinctive medical vocabulary and drops the scaffolding', () => {
    const terms = deriveSearchTerms(
      'Have you smoked, vaped, used e-cigarettes, tobacco or nicotine products in the last 12 months?'
    );
    expect(terms).toContain('smok');
    expect(terms).toContain('vape');
    expect(terms).toContain('tobacco');
    expect(terms).toContain('nicotine');
    // Scaffolding that appears in every question proves nothing.
    expect(terms).not.toContain('have');
    expect(terms).not.toContain('last');
    expect(terms).not.toContain('month');
    expect(terms).not.toContain('product');
  });

  it('mines the guidance for clinical terms the question itself omits', () => {
    // "Heart disease or disorder…" is generic; the specifics live in the
    // insurer's "Including:" note.
    const terms = deriveSearchTerms(
      'Heart disease or disorder, circulatory disease or diabetes?',
      'Including: Angina or heart attack, Cardiomyopathy, Heart Murmur, Deep vein thrombosis (DVT)'
    );
    expect(terms).toContain('heart');
    expect(terms).toContain('angina');
    expect(terms).toContain('cardiomyopathy');
  });

  it('does not reduce a generic parent question to nothing useful', () => {
    const terms = deriveSearchTerms('Have you ever had, or do you currently have, any of the following?');
    // Every word here is scaffolding, so there is nothing to search for — and
    // that is the correct answer. absenceIsMeaningful will then be false, so the
    // question resolves to undetermined rather than a false "not asked".
    expect(terms).toHaveLength(0);
    expect(absenceIsMeaningful(terms)).toBe(false);
  });
});

describe('absenceIsMeaningful', () => {
  it('is true for questions whose terms survive redaction', () => {
    expect(absenceIsMeaningful(deriveSearchTerms('Do you smoke?'))).toBe(true);
    expect(absenceIsMeaningful(deriveSearchTerms('How many units of alcohol do you drink in a typical week?'))).toBe(true);
    expect(absenceIsMeaningful(deriveSearchTerms('What is your weight?'))).toBe(true);
    expect(absenceIsMeaningful(deriveSearchTerms('What is your current job?'))).toBe(true);
  });

  it('is false for the conditions measured absent from all 63 real transcripts', () => {
    // diabetes, cancer, stroke, asthma, depression, anxiety appeared zero times.
    // Absence of these terms is caused by our own redaction, so it cannot be
    // used to conclude the question was skipped.
    for (const q of [
      'Any form of cancer, tumour, lymphoma or leukaemia?',
      'Have you been diagnosed with diabetes?',
      'During the last 5 years have you had depression or anxiety?',
      'Asthma, bronchitis, or any other disorder affecting your lungs?',
    ]) {
      expect(absenceIsMeaningful(deriveSearchTerms(q))).toBe(false);
    }
  });

  it('is false when a surviving term is only incidental to a redacted subject', () => {
    // Contains 'blood' and 'surgery', which both survive — but the subject is
    // 'stroke', which does not, and an adviser asking this says "any strokes?".
    // Letting the incidental survivor vouch for the question would report it as
    // skipped on every sale.
    const terms = deriveSearchTerms('A stroke, brain haemorrhage or surgery to your blood vessels?');
    expect(terms).toContain('blood');
    expect(terms).toContain('stroke');
    expect(absenceIsMeaningful(terms)).toBe(false);
  });

  it('is conservative on a question mixing survivors and redacted terms', () => {
    // "Raised blood pressure, raised cholesterol, chest pain or pre-diabetes?"
    // is genuinely verifiable — advisers were observed saying "blood pressure,
    // cholesterol" verbatim — but it also names diabetes, so the default errs to
    // unverifiable. Under-reporting is the safe direction; a human can confirm
    // this one as verifiable when the profile is reviewed.
    const terms = deriveSearchTerms('Raised blood pressure, raised cholesterol, chest pain or pre-diabetes?');
    expect(absenceIsMeaningful(terms)).toBe(false);
  });
});

describe('transcriptRedactsHealth', () => {
  it('recognises the placeholders the provider leaves behind', () => {
    expect(transcriptRedactsHealth('Are you on medication for your [CONDITION_12]')).toBe(true);
    expect(transcriptRedactsHealth('just your [DRUG_6] so far?')).toBe(true);
    expect(transcriptRedactsHealth('to have a [MEDICAL_PROCESS_7]')).toBe(true);
  });

  it('is false for an unredacted transcript', () => {
    expect(transcriptRedactsHealth('Do you smoke at all? No, gave up in 1986.')).toBe(false);
  });
});

describe('findEvidence and quoteAround', () => {
  const transcript =
    'Agent: And blood pressure, cholesterol, all up to date? Customer: Yes, I take one tablet for the blood pressure.';

  it('locates the question topic in the transcript', () => {
    const hits = findEvidence(deriveSearchTerms('Raised blood pressure or raised cholesterol?'), transcript);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.term)).toContain('cholesterol');
  });

  it('finds nothing when the topic is absent', () => {
    expect(findEvidence(deriveSearchTerms('Do you ride a motorbike?'), transcript)).toEqual([]);
  });

  it('quotes the surrounding text for display', () => {
    const hits = findEvidence(['cholesterol'], transcript);
    const quote = quoteAround(transcript, hits[0]!.index);
    expect(quote).toContain('cholesterol');
  });
});

// The call that produced 252 of one tenant's 448 items as "asked but never
// answered". The adviser names the topics before asking about any of them, so
// the earliest mention of every one of them is a place the answer cannot be.
const PREVIEW_THEN_ASK = [
  'Agent: Right, so in a moment I need to run through the health questions — ' +
    'that covers cancer, heart conditions, diabetes and your smoking, all of it.',
  'Customer: No problem at all, go ahead whenever you are ready.',
  'Agent: Lovely. First one then. Have you ever been diagnosed with cancer, or ' +
    'had any treatment for a tumour of any kind?',
  'Customer: No, never, nothing like that.',
  'Agent: And do you smoke, or have you used any tobacco in the last twelve months?',
  'Customer: No, I gave up years ago now.',
].join('\n\n');

describe('findEvidence — every occurrence, not just the first', () => {
  it('finds a topic again where it is actually asked about', () => {
    const hits = findEvidence(['cancer'], PREVIEW_THEN_ASK);
    expect(hits.length).toBeGreaterThan(1);
    // The first lands in the adviser's preview; the second is where the question
    // is genuinely put, and only that one has an answer after it.
    expect(quoteExchange(PREVIEW_THEN_ASK, hits[0]!.index)).toContain('in a moment');
    expect(quoteExchange(PREVIEW_THEN_ASK, hits[1]!.index)).toContain('Have you ever been diagnosed');
  });

  it('returns hits in call order, so the preamble comes before the question', () => {
    const hits = findEvidence(['cancer', 'smok'], PREVIEW_THEN_ASK);
    const indexes = hits.map((h) => h.index);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });

  it('caps how often one word may report itself, so a common stem cannot crowd out the rest', () => {
    const repeated = Array.from({ length: 20 }, () => 'Agent: cancer').join('\n\n');
    expect(findEvidence(['cancer'], repeated).length).toBeLessThanOrEqual(4);
  });

  it('still finds nothing when the topic is genuinely absent', () => {
    expect(findEvidence(deriveSearchTerms('Do you ride a motorbike?'), PREVIEW_THEN_ASK)).toEqual([]);
  });
});

describe('quoteExchange — a quote shaped like the question it answers', () => {
  it('reaches the customer reply, which a centred window can miss', () => {
    const at = PREVIEW_THEN_ASK.indexOf('diagnosed with cancer');
    const quote = quoteExchange(PREVIEW_THEN_ASK, at);
    expect(quote).toContain('No, never, nothing like that');
  });

  it('starts at the speaker turn, so the question is not cut off mid-sentence', () => {
    const at = PREVIEW_THEN_ASK.indexOf('diagnosed with cancer');
    expect(quoteExchange(PREVIEW_THEN_ASK, at)).toContain('Have you ever been diagnosed');
  });

  it('does not reach back into the previous turn, which is not evidence about this question', () => {
    const at = PREVIEW_THEN_ASK.indexOf('do you smoke');
    expect(quoteExchange(PREVIEW_THEN_ASK, at)).not.toContain('No problem at all');
  });

  it('stays bounded on a transcript with no turn breaks at all', () => {
    const unbroken = 'Agent: ' + 'word '.repeat(4000) + 'cancer yes';
    const quote = quoteExchange(unbroken, unbroken.indexOf('cancer'));
    expect(quote.length).toBeLessThanOrEqual(700);
  });
});

describe('evidenceExcerpts — what the model is actually given', () => {
  it('sends the place the question was asked, not only the preamble', () => {
    const hits = findEvidence(deriveSearchTerms('Have you ever been diagnosed with cancer?'), PREVIEW_THEN_ASK);
    const excerpts = evidenceExcerpts(PREVIEW_THEN_ASK, hits);
    expect(excerpts.join(' ')).toContain('No, never, nothing like that');
  });

  it('collapses hits that land in the same passage instead of repeating it', () => {
    // Several of a question's terms in one sentence is the normal case; quoting
    // each separately would send the same text three times and pay for it.
    const t = 'Agent: Any heart attack, angina or stroke at all?\n\nCustomer: No, none of those.';
    const hits = findEvidence(['heart', 'angina', 'stroke'], t);
    expect(hits.length).toBe(3);
    expect(evidenceExcerpts(t, hits)).toHaveLength(1);
  });

  it('never sends more than a handful, whatever the call does', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      `Agent: cancer question ${i}?\n\nCustomer: no.\n\n` + 'filler '.repeat(200)
    ).join('\n\n');
    expect(evidenceExcerpts(many, findEvidence(['cancer'], many)).length).toBeLessThanOrEqual(3);
  });

  it('returns nothing when the topic never appears', () => {
    expect(evidenceExcerpts(PREVIEW_THEN_ASK, [])).toEqual([]);
  });
});

describe('compareAnswers', () => {
  it('matches yes/no across the ways they are spoken', () => {
    expect(compareAnswers('No', 'no')).toBe('match');
    expect(compareAnswers('Yes', 'yeah')).toBe('match');
    expect(compareAnswers('No', 'nope')).toBe('match');
  });

  it('treats the multi-select negative as equivalent to no', () => {
    // Insurers render it "None of the above"; customers just say no.
    expect(compareAnswers('None of the above', 'no')).toBe('match');
    expect(compareAnswers('No to all', 'no')).toBe('match');
  });

  it('catches a polarity disagreement — the core non-disclosure case', () => {
    // The application says the customer denied it; the call says they disclosed it.
    expect(compareAnswers('No', 'yes')).toBe('mismatch');
    expect(compareAnswers('None of the above', 'yes')).toBe('mismatch');
  });

  it('catches a mis-keyed number', () => {
    // 50 cigarettes a day keyed as 5.
    expect(compareAnswers('50', '5')).toBe('mismatch');
    expect(compareAnswers('135', '135')).toBe('match');
    expect(compareAnswers('1', 'one unit')).toBe('unclear');
  });

  it('matches a number stated with its unit', () => {
    expect(compareAnswers('50', '50 a day')).toBe('match');
  });

  it('matches where the customer said more than the canonical value', () => {
    expect(compareAnswers('Raised blood pressure', 'yeah, raised blood pressure a few years back')).toBe('match');
  });

  it('escalates rather than guesses on compound or unit-converted answers', () => {
    // The application carries both forms; the customer said neither exactly.
    expect(compareAnswers('111.1kg or 17 stone 7 pounds', 'about seventeen and a half stone')).toBe('unclear');
    expect(compareAnswers('1.75m or 5 feet 9 inches', 'five nine')).toBe('unclear');
  });
});

describe('classifyItem', () => {
  const base: ClassifyInput = {
    applicationAnswer: 'No',
    callAnswer: 'no',
    callAnswerRedacted: false,
    evidenceFound: true,
    absenceMeaningful: true,
    redactedTranscript: false,
  };

  it('matches when both sides agree', () => {
    expect(classifyItem(base)).toBe('match');
  });

  it('flags a mismatch', () => {
    expect(classifyItem({ ...base, applicationAnswer: 'No', callAnswer: 'yes' })).toBe('mismatch');
  });

  it('flags not_asked when the application has an answer the call never covered', () => {
    // The serious one: the form was completed without putting the question.
    expect(classifyItem({ ...base, evidenceFound: false })).toBe('not_asked');
  });

  it('NEVER says not_asked when absence could be redaction', () => {
    // The safety rule. Without it, every cancer/diabetes/stroke/mental-health
    // question would be reported as skipped on every sale — a false allegation
    // against an adviser, generated by our own redaction.
    expect(
      classifyItem({
        ...base,
        evidenceFound: false,
        absenceMeaningful: false,
        redactedTranscript: true,
      })
    ).toBe('undetermined');
  });

  it('still says not_asked on an unredacted transcript even with weak terms', () => {
    // Nothing was removed, so absence really is absence.
    expect(
      classifyItem({
        ...base,
        evidenceFound: false,
        absenceMeaningful: false,
        redactedTranscript: false,
      })
    ).toBe('not_asked');
  });

  it('reports asked_no_answer when the question was put but never answered', () => {
    expect(classifyItem({ ...base, callAnswer: null })).toBe('asked_no_answer');
  });

  it('distinguishes a redacted value from an absent answer', () => {
    // We know they answered; we cannot see what they said, so no comparison is
    // possible and none is claimed.
    expect(classifyItem({ ...base, callAnswer: null, callAnswerRedacted: true })).toBe('undetermined');
  });

  it('reports no_application_answer when the insurer recorded nothing', () => {
    expect(classifyItem({ ...base, applicationAnswer: null })).toBe('no_application_answer');
    expect(classifyItem({ ...base, applicationAnswer: '  ' })).toBe('no_application_answer');
  });

  it('escalates an incomparable pair instead of asserting a match', () => {
    expect(
      classifyItem({
        ...base,
        applicationAnswer: '111.1kg or 17 stone 7 pounds',
        callAnswer: 'about seventeen and a half stone',
      })
    ).toBe('undetermined');
  });
});

describe('classifyAmendment', () => {
  const rev = (...values: string[]) => values.map((value) => ({ value }));

  it('reports nothing when the answer was never changed', () => {
    expect(classifyAmendment('No', [])).toBeNull();
  });

  it('flags a disclosure that was entered and then withdrawn', () => {
    // Real case: mental health answered "None of these", changed to "Stress",
    // then changed back — all inside the same minute. The submitted document
    // shows only "None of these", so without the trail this is invisible.
    expect(classifyAmendment('None of these', rev('None of these', 'Stress'))).toBe('disclosure_withdrawn');
  });

  it('flags a positive answer replaced by a negative one', () => {
    expect(classifyAmendment('None of these', rev('Anxiety'))).toBe('disclosure_withdrawn');
    expect(classifyAmendment('No', rev('Yes'))).toBe('disclosure_withdrawn');
  });

  it('treats disclosing more as benign', () => {
    // Real case: "have you ever stopped taking prescribed treatment without
    // medical advice" changed from No to Yes. More was disclosed, not less.
    expect(classifyAmendment('Yes', rev('No'))).toBe('disclosure_added');
    expect(classifyAmendment('Any other cancer', rev('No'))).toBe('disclosure_added');
  });

  it('handles multi-select answers as sets', () => {
    // Real case: family history went from "Heart attack, angina or stroke" to
    // the same plus Diabetes.
    expect(
      classifyAmendment('Heart attack, angina or stroke, Diabetes', rev('Heart attack, angina or stroke'))
    ).toBe('disclosure_added');
    // The reverse is the concerning direction.
    expect(
      classifyAmendment('Heart attack, angina or stroke', rev('Heart attack, angina or stroke, Diabetes'))
    ).toBe('disclosure_withdrawn');
  });

  it('does not split a single option on the commas inside it', () => {
    // "Heart attack, angina or stroke" is ONE option. Splitting it into three
    // would make an unchanged answer look like a withdrawal.
    expect(
      classifyAmendment('Heart attack, angina or stroke', rev('Heart attack, angina or stroke'))
    ).toBeNull();
  });

  it('reports a plain value change without judging direction', () => {
    // Real case: weekly measures of spirits 0 -> 2, and a relative's age at
    // diagnosis 63 -> 61. Both worth surfacing; neither is a disclosure being
    // added or withdrawn.
    expect(classifyAmendment('2', rev('0'))).toBe('value_changed');
    expect(classifyAmendment('61', rev('63'))).toBe('value_changed');
  });

  it('flags an answer that was cleared', () => {
    expect(classifyAmendment(null, rev('Yes'))).toBe('value_changed');
  });

  it('surfaces only withdrawals on their own', () => {
    expect(isAmendmentActionable('disclosure_withdrawn')).toBe(true);
    expect(isAmendmentActionable('disclosure_added')).toBe(false);
    expect(isAmendmentActionable('value_changed')).toBe(false);
    expect(isAmendmentActionable(null)).toBe(false);
  });
});

describe('isActionable', () => {
  it('surfaces the three real flags', () => {
    expect(isActionable('mismatch')).toBe(true);
    expect(isActionable('not_asked')).toBe(true);
    expect(isActionable('asked_no_answer')).toBe(true);
  });

  it('does not surface undetermined as a finding', () => {
    // It means we could not tell. Presenting it as a finding would bury the real
    // flags under noise our own redaction created.
    expect(isActionable('undetermined')).toBe(false);
    expect(isActionable('match')).toBe(false);
    expect(isActionable('no_application_answer')).toBe(false);
  });
});
