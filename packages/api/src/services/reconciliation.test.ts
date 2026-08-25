import { describe, it, expect } from 'vitest';
import {
  stem,
  deriveSearchTerms,
  absenceIsMeaningful,
  transcriptRedactsHealth,
  findEvidence,
  deriveAnswerTerms,
  deriveChoiceTerms,
  isInsurerGenerated,
  isBankAccountDetail,
  isFormDeclaration,
  coincidentalEvidence,
  checklistCovers,
  dateCandidates,
  heightCandidatesCm,
  defaultCheckMode,
  quoteAround,
  quoteExchange,
  evidenceExcerpts,
  weightInKg,
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

  it('never turns the "Section:" label itself into a search term', () => {
    // application-pdf.ts now prepends "Section: <heading>" to guidance so a
    // repeated question stem can be told apart from its duplicates. The label
    // is scaffolding CallGuard added, not the insurer's wording, and every
    // question in a document shares it — it must never itself become
    // something the search looks for.
    const terms = deriveSearchTerms(
      'Have you had any of these?',
      'Section: WE NEED TO ASK YOU SOME QUESTIONS ABOUT YOUR LIFESTYLE'
    );
    expect(terms).not.toContain('section');
    // The real heading words are exactly what should survive — they are what
    // makes this occurrence of the question findable and distinct from the
    // others.
    expect(terms).toContain('lifestyle');
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

  it('is false for a form label an adviser would never say aloud', () => {
    // The regression this split exists for. These words survive redaction
    // perfectly — the transcript is not why they are missing. They are missing
    // because nobody says "what is your occupation?"; they say "what do you do
    // for work?". Treating their absence as proof produced nine of Trust
    // Point's eleven "never asked" findings, against six different advisers, on
    // calls where employment had plainly been covered.
    for (const label of ['Employment status', 'Occupation']) {
      expect(absenceIsMeaningful(deriveSearchTerms(label))).toBe(false);
    }
  });

  it('is false for the policy-admin labels that produced the rest of them', () => {
    for (const label of [
      'Active Lifestyle Cover', 'No. of Units', 'Guaranteed Sum Assured',
      'Term', 'Name', 'Bank account held in payers name',
    ]) {
      expect(absenceIsMeaningful(deriveSearchTerms(label))).toBe(false);
    }
  });

  it('still accuses on the health questions the module exists to check', () => {
    // The other side of the trade. Loosening this far enough to silence a form
    // label must not silence a disclosure question, or the module stops doing
    // the one thing it is for.
    for (const q of [
      'Have you smoked in the last 12 months?',
      'How many units of alcohol do you drink in a typical week?',
      'Do you have raised blood pressure or cholesterol?',
      'Have you seen a doctor or been to hospital in the last 5 years?',
      'Do you take part in any dangerous sports?',
      'What is your job?',
    ]) {
      expect(absenceIsMeaningful(deriveSearchTerms(q))).toBe(true);
    }
  });

  it('keeps the alcohol question checkable without letting "units" carry it alone', () => {
    // 'unit' means alcohol units here and units of COVER on MetLife's form, so
    // it cannot be the term that licenses an accusation. The alcohol question
    // survives on 'alcohol' and 'drink'; the cover field has nothing else and
    // stops accusing.
    expect(absenceIsMeaningful(deriveSearchTerms('How many units of alcohol do you drink?'))).toBe(true);
    expect(absenceIsMeaningful(deriveSearchTerms('No. of Units'))).toBe(false);
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

describe('deriveAnswerTerms — searching for the answer, not the label', () => {
  // A summary sheet's "questions" are form labels nobody speaks. Searching a
  // transcript for "Telephone" or "DOB" finds nothing on a call where the
  // customer gave both — fifteen checkable identity fields per sale, inert.
  // Their VALUES are what was said aloud.

  it('finds the phone number a customer read out, however it was grouped', () => {
    const terms = deriveAnswerTerms('07907769991');
    // The whole run, and the tail that survives being grouped differently.
    expect(terms).toContain('07907769991');
    expect(terms).toContain('769991');

    const call = 'Agent: And a contact number? Customer: Yeah, it is 07907 769991.';
    expect(findEvidence(terms, call).length).toBeGreaterThan(0);
  });

  it('finds a date of birth by its year, which is the only part spoken as written', () => {
    // "fourth of May nineteen seventy-three" shares nothing with 04/05/1973
    // except 1973 — and even that only when the transcriber writes digits.
    expect(deriveAnswerTerms('04/05/1973')).toContain('1973');
    const call = 'Agent: Date of birth? Customer: Fourth of the fifth, 1973.';
    expect(findEvidence(deriveAnswerTerms('04/05/1973'), call).length).toBeGreaterThan(0);
  });

  it('finds an email by its local part, which is what gets spelled out', () => {
    expect(deriveAnswerTerms('nathan.gonzalez@example.com')).toContain('nathan.gonzalez');
  });

  it('finds an address by its outward postcode', () => {
    expect(deriveAnswerTerms('12 High Street, London SW1A 1AA')).toContain('sw1a');
  });

  it('offers nothing for a short or absent value, rather than something useless', () => {
    // "Yes" and "4" are not distinctive; searching for them would match the
    // whole call and locate nothing.
    expect(deriveAnswerTerms(null)).toEqual([]);
    expect(deriveAnswerTerms('Yes')).toEqual([]);
    expect(deriveAnswerTerms('4')).toEqual([]);
  });

  it('never lets a value vouch for its own absence', () => {
    // The gain is entirely on the finding side. A customer reading digits back
    // in fragments is normal, so a value that cannot be found must stay
    // undetermined — never "the adviser invented it".
    expect(absenceIsMeaningful(deriveAnswerTerms('07907769991'))).toBe(false);
    expect(absenceIsMeaningful(deriveAnswerTerms('04/05/1973'))).toBe(false);
  });
});

describe('isInsurerGenerated — fields that could not have been said', () => {
  it('recognises a reference the insurer issues on submission', () => {
    // It does not exist while the sale is happening, so searching a call for it
    // is not a check that can pass.
    for (const label of [
      'Policy number', 'Policy No.', 'Plan number', 'Application number',
      'Quote reference', 'Agency number', 'Date of application', 'Date of issue',
    ]) {
      expect(isInsurerGenerated(label)).toBe(true);
    }
  });

  it('leaves alone every field a customer actually states', () => {
    // The narrowness is the point: almost everything on a summary sheet IS
    // said out loud, and excluding it would throw away the identity check.
    for (const label of [
      'Name', 'Address', 'Email', 'Day tel no', 'DOB', 'Marital status',
      'Employment status', 'Occupation', 'UK Residency', 'No. of Units',
      'Monthly premium', 'Preferred Direct Debit date',
      'How many units of alcohol do you drink in a typical week?',
    ]) {
      expect(isInsurerGenerated(label)).toBe(false);
    }
  });

  it('does not fire on a question that merely mentions a policy', () => {
    expect(isInsurerGenerated('Do you have any existing policy numbers with another insurer?')).toBe(false);
  });
});

describe('isBankAccountDetail — values a recording cannot verify', () => {
  it('recognises the account identifiers, however the insurer labels them', () => {
    for (const label of [
      'Account Number', 'Account No.', 'Account no', 'Bank account number',
      'A/C number', 'Sort Code', 'Account Sort Code', 'Sort-code',
      'Bank sort code', 'IBAN', 'Roll number', 'Building society roll number',
    ]) {
      expect(isBankAccountDetail(label)).toBe(true);
    }
  });

  it('leaves alone the direct debit questions that ARE asked out loud', () => {
    // The distinction the whole change turns on. "Is that account in your name?"
    // and "do we have your permission to take it from there?" are put to the
    // customer verbatim — one Trust Point transcript has the adviser saying "for
    // the direct debit, the sort code and account number, is that in your name?"
    // — so they stay checkable. Only the digits themselves are exempt.
    for (const label of [
      'Bank account held in payers name', 'Direct Debit allowed from account',
      'Preferred Direct Debit date', 'Account holder name', 'Bank name',
      'Monthly premium', 'Guaranteed Sum Assured', 'Term', 'No. of Units',
    ]) {
      expect(isBankAccountDetail(label)).toBe(false);
    }
  });

  it('does not fire on a question that merely mentions an account', () => {
    expect(
      isBankAccountDetail('Have you ever had an account refused by a bank or building society?')
    ).toBe(false);
  });
});

describe('defaultCheckMode', () => {
  it('exempts an insurer-generated reference from checking entirely', () => {
    expect(defaultCheckMode('Policy number')).toBe('none');
    expect(defaultCheckMode('Date of issue')).toBe('none');
  });

  it('checks bank identifiers for completion rather than against the call', () => {
    expect(defaultCheckMode('Account Number')).toBe('presence');
    expect(defaultCheckMode('Sort Code')).toBe('presence');
  });

  it('reconciles everything else, including the rest of the payment section', () => {
    // The default must stay 'reconcile' for anything unrecognised: a mode that
    // fell open would switch off checks on questions nobody has considered.
    for (const label of [
      'Bank account held in payers name', 'Direct Debit allowed from account',
      'Monthly premium', 'Occupation', 'Child Cover',
      'Have you smoked in the last 12 months?',
      'Some label no heuristic has ever seen',
    ]) {
      expect(defaultCheckMode(label)).toBe('reconcile');
    }
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

  it('does not let one figure being a substring of another pass as a paraphrase', () => {
    // The containment rule exists for phrases like "raised blood pressure"
    // being a paraphrase of a longer sentence — it must not also catch
    // "£15,000" sitting inside the digits of "£150,000", which is a firm
    // misreading the sum assured, not the customer restating it.
    expect(compareAnswers('£150,000', '£15,000')).toBe('mismatch');
    expect(compareAnswers('£250,000', '£50,000')).toBe('mismatch');
    expect(compareAnswers('£45.60', '£145.60')).toBe('mismatch');
    expect(compareAnswers('5 cigarettes a day', '15 cigarettes a day')).toBe('mismatch');
    expect(compareAnswers('10 units a week', '110 units a week')).toBe('mismatch');
  });

  it('reads a date given as elapsed time against the year on the form', () => {
    // From a real sale: "When did your treatment cease?" recorded as 2019, the
    // customer saying "7 years ago" on a call in 2026. The same fact in two
    // units — reported as a mismatch, which is an allegation against the
    // adviser who wrote down exactly what they were told.
    const callDate = new Date('2026-08-10T00:00:00Z');
    expect(compareAnswers('2019', '7 years ago', callDate)).toBe('match');
    expect(compareAnswers('2019', 'about 7 yrs ago', callDate)).toBe('match');
    // Speech rounds. Treatment ending late in 2019 is six and a half years
    // ago, and nobody says that.
    expect(compareAnswers('2019', '6 years ago', callDate)).toBe('match');
  });

  it('still catches a date that genuinely disagrees', () => {
    const callDate = new Date('2026-08-10T00:00:00Z');
    expect(compareAnswers('2019', '2 years ago', callDate)).toBe('mismatch');
    expect(compareAnswers('2010', '3 years back', callDate)).toBe('mismatch');
  });

  it('refuses to judge elapsed time with no date to count back from', () => {
    expect(compareAnswers('2019', '7 years ago')).toBe('unclear');
  });

  it('will not judge an age against an elapsed time', () => {
    // From a real sale: "How old were you when you were diagnosed with asthma?"
    // recorded as 51, the customer saying "about 13 years ago". The same fact
    // told from the other end — a conversion the adviser makes without noticing
    // — and settling it needs a date of birth we do not have and which may
    // itself be redacted. Reported as a mismatch it reads as the adviser having
    // invented an age.
    const callDate = new Date('2026-08-10T00:00:00Z');
    expect(compareAnswers('51', 'About 13 years ago', callDate)).toBe('unclear');
    expect(compareAnswers('13 years ago', '51', callDate)).toBe('unclear');
    // And with no date available either, for the same reason.
    expect(compareAnswers('51', 'About 13 years ago')).toBe('unclear');
  });

  it('never calls a year against a plain count a mismatch', () => {
    // Two different kinds of quantity. A year against a number of episodes, or
    // an age, is a unit confusion of ours — not a mis-keying of theirs.
    expect(compareAnswers('2019', '7')).toBe('unclear');
    expect(compareAnswers('3', '2015')).toBe('unclear');
  });

  it('does the stone-to-kilogram arithmetic instead of comparing bare numbers', () => {
    // From a real sale, at 0.95 confidence: form 107.95 kg, customer "17
    // stone". 17 × 6.35029 = 107.955 — the adviser converted correctly and the
    // bare-number rule declared them a contradiction anyway.
    expect(compareAnswers('107.95 kg', '17 stone')).toBe('match');
    expect(compareAnswers('17 stone', '107.95 kg')).toBe('match');
    expect(compareAnswers('111.1kg', '17 stone 7 pounds')).toBe('match');
    expect(compareAnswers('82 kg', '13 stone')).toBe('match');
  });

  it('reads a form weight that states no unit against one that does', () => {
    // From a real sale, at 0.95 confidence: form "127.0058636", customer "20
    // stone". That is the conversion, carried out and stored to a precision no
    // human typed — and the arithmetic above never ran, because the form omits
    // the unit and weightInKg needs one. Landing within a kilogram of the
    // conversion is not coincidence, so it is agreement.
    expect(compareAnswers('127.0058636', '20 stone')).toBe('match');
    // The same number could be the stone figure itself, or pounds.
    expect(compareAnswers('20', '20 stone')).toBe('match');
    expect(compareAnswers('17 stone', '107.95')).toBe('match');
    // Two numbers on the bare side is not a reading we can pick between.
    expect(compareAnswers('17 7', '20 stone')).toBe('unclear');
  });

  it('reads a weight spoken as a fraction, and never treats one as unit-less', () => {
    // David Carter, a live sale: form "105kg or 16 stone 7 pounds", customer
    // "About 16 and a half stone". 16st 7lb IS 16.5 stone — the same weight,
    // written two ways. weightInKg could not see the figure at all, because the
    // digits are not adjacent to the unit, so the bare-number reading took the
    // 16 for a unit-less number, called it 16 stone, and made the missing half
    // stone into an accusation.
    expect(compareAnswers('105kg or 16 stone 7 pounds', 'About 16 and a half stone')).toBe('match');
    expect(weightInKg('16 and a half stone')).toBeCloseTo(104.78, 1);
    expect(weightInKg('17 and a quarter stone')).toBeCloseTo(109.54, 1);

    // The backstop, for any other phrasing that beats the parser. A side naming
    // a unit is never treated as one that omitted it — and this must say
    // 'unclear' rather than decline, or the bare-number rule below compares 105
    // against 16 as plain quantities and reaches the same accusation anyway.
    expect(compareAnswers('105 kg', '16 and a third stone')).toBe('unclear');
  });

  it('still catches a weight that genuinely disagrees', () => {
    // 20 stone is 127 kg. A form saying 108 against a customer saying 20 stone
    // is the mis-keying this comparison exists for.
    expect(compareAnswers('107.95 kg', '20 stone')).toBe('mismatch');
  });

  it('will not read pints against units of alcohol as a numeric disagreement', () => {
    // Also real, also 0.95: form "4" (units), customer "2 pints a week". Two
    // pints IS roughly four units — the adviser converting is doing their job,
    // and the strength assumption underneath the conversion is not ours to
    // second-guess. Not a match either: we cannot verify it, so unclear.
    expect(compareAnswers('4', '2 pints a week')).toBe('unclear');
    expect(compareAnswers('14', 'couple of glasses of wine a night')).toBe('unclear');
    // Same measure on both sides compares as ordinary numbers.
    expect(compareAnswers('2 pints', '2 pints a week')).toBe('match');
  });

  it('escalates rather than guesses on compound or unit-converted answers', () => {
    // The application carries both forms; the customer said neither exactly.
    expect(compareAnswers('111.1kg or 17 stone 7 pounds', 'about seventeen and a half stone')).toBe('unclear');
  });

  // Was 'unclear' until heightCandidatesCm existed, and that was the honest
  // answer while nothing could read imperial. It is decidable arithmetic, not a
  // guess: "five nine" and "5 feet 9 inches" are both 175.26cm, which is also
  // what the application's own 1.75m rounds to.
  it('resolves a height the two sides stated in different units', () => {
    expect(compareAnswers('1.75m or 5 feet 9 inches', 'five nine')).toBe('match');
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

  it('treats an absent checkMode as reconcile, so nothing changes by omission', () => {
    expect(classifyItem({ ...base, checkMode: undefined })).toBe('match');
    expect(classifyItem({ ...base, checkMode: 'reconcile' })).toBe('match');
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

  it('does not accuse on weak terms just because the transcript is unredacted', () => {
    // This test previously asserted the opposite — "nothing was removed, so
    // absence really is absence" — and that assumption is what broke the
    // moment a tenant was permitted 'phi'. Health placeholders vanished from
    // their transcripts, redactedTranscript went false everywhere, and the
    // safety rule stopped firing: "Uk Resident" and "Telephone" were both
    // reported as never asked on a live sale, within a day of the setting
    // changing.
    //
    // Redaction was never the whole reason absence proves nothing. An adviser
    // asking "do you live in the UK" or "what's your number" says neither
    // "resident" nor "telephone", so those terms are absent from a call where
    // the question WAS put. absenceMeaningful is the judgement that covers
    // both, and it is now the only thing consulted.
    expect(
      classifyItem({
        ...base,
        evidenceFound: false,
        absenceMeaningful: false,
        redactedTranscript: false,
      })
    ).toBe('undetermined');
  });

  it('cannot be turned into an accusation by changing a tenant\'s redaction settings', () => {
    // The same question, the same call, judged either side of permitting
    // health data. Turning redaction off must not convert "we could not tell"
    // into "the adviser never asked" — nothing about the sale changed.
    const question = { ...base, evidenceFound: false, absenceMeaningful: false };
    expect(classifyItem({ ...question, redactedTranscript: true })).toBe('undetermined');
    expect(classifyItem({ ...question, redactedTranscript: false })).toBe('undetermined');
  });

  it('still says not_asked where the terms genuinely vouch for their own absence', () => {
    // The signal has to survive, or the module stops finding the thing it
    // exists to find. A question whose terms would have been spoken and would
    // have survived storage, absent from the call, is a real finding.
    expect(
      classifyItem({
        ...base,
        evidenceFound: false,
        absenceMeaningful: true,
        redactedTranscript: false,
      })
    ).toBe('not_asked');
    expect(
      classifyItem({
        ...base,
        evidenceFound: false,
        absenceMeaningful: true,
        redactedTranscript: true,
      })
    ).toBe('not_asked');
  });

  it('reports asked_no_answer only when the customer demonstrably did not answer', () => {
    expect(
      classifyItem({ ...base, callAnswer: null, customerDidNotAnswer: true })
    ).toBe('asked_no_answer');
  });

  it('says undetermined when no answer could be read, rather than accusing anyone', () => {
    // The real case this comes from. "Are you working 16 hours or more a week?"
    // was answered — the customer said they were full time — but the passage we
    // read cut off mid-sentence, so nothing could be extracted. Reported as
    // asked_no_answer, that is an allegation the adviser recorded an answer
    // nobody gave. It was one of 252 such items on a single tenant.
    expect(classifyItem({ ...base, callAnswer: null })).toBe('undetermined');
    expect(
      classifyItem({ ...base, callAnswer: null, customerDidNotAnswer: false })
    ).toBe('undetermined');
  });

  it('does not accuse anyone when the value pass failed outright', () => {
    // No extraction at all leaves the flag undefined for every question on the
    // sale. Defaulting that to "they never answered" would turn one API failure
    // into a full sale's worth of findings.
    expect(
      classifyItem({ ...base, callAnswer: null, customerDidNotAnswer: undefined })
    ).toBe('undetermined');
  });

  it('still prefers redaction as the explanation where that is what happened', () => {
    expect(
      classifyItem({
        ...base,
        callAnswer: null,
        callAnswerRedacted: true,
        customerDidNotAnswer: true,
      })
    ).toBe('undetermined');
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

  describe("checkMode 'presence' — checked for completion, never against the call", () => {
    it('reports a completed field as recorded, not as a match', () => {
      // Not 'match'. Nothing was compared, and letting it count would inflate
      // the match rate with fields nobody verified.
      expect(
        classifyItem({ ...base, checkMode: 'presence', applicationAnswer: 'XXXXX-388' })
      ).toBe('recorded');
    });

    it('reports a blank field as a finding', () => {
      expect(
        classifyItem({ ...base, checkMode: 'presence', applicationAnswer: null })
      ).toBe('missing_from_application');
      expect(
        classifyItem({ ...base, checkMode: 'presence', applicationAnswer: '   ' })
      ).toBe('missing_from_application');
    });

    it('ignores the call entirely, whatever the evidence says', () => {
      // The whole point: no configuration of call evidence may produce an
      // accusation on a field that cannot be verified from a recording. This is
      // the case that was generating eight false findings on one sale — a
      // masked sort code matching a stray "38" somewhere in the transcript.
      for (const evidence of [
        { evidenceFound: false, absenceMeaningful: true },
        { evidenceFound: true, callAnswer: null, customerDidNotAnswer: true },
        { evidenceFound: true, callAnswer: 'something else entirely' },
      ]) {
        expect(
          classifyItem({
            ...base,
            ...evidence,
            checkMode: 'presence',
            applicationAnswer: 'XX-XX-38',
          })
        ).toBe('recorded');
      }
    });
  });

  describe("checkMode 'none' — on the record, never a finding", () => {
    it('reports a value that did not exist during the call as recorded, not undetermined', () => {
      // 'undetermined' means "we tried and could not establish this". Deciding
      // not to check a policy number is not the same as failing to check it, and
      // a reviewer reading the unresolved pile must not find it padded with
      // fields nobody ever intended to look at.
      expect(
        classifyItem({ ...base, checkMode: 'none', applicationAnswer: 'POL-99123' })
      ).toBe('recorded');
    });

    it('does NOT make a blank a finding, unlike presence mode', () => {
      // Nothing here is required of the adviser, so an empty policy number is
      // the insurer's business and not a compliance flag.
      expect(classifyItem({ ...base, checkMode: 'none', applicationAnswer: null })).toBe(
        'no_application_answer'
      );
    });

    it('never accuses, whatever the call evidence', () => {
      expect(
        classifyItem({
          ...base,
          checkMode: 'none',
          evidenceFound: false,
          absenceMeaningful: true,
          applicationAnswer: 'POL-99123',
        })
      ).toBe('recorded');
    });
  });
});

describe('compareAnswers — a polar answer carrying its detail', () => {
  it('compares a qualified affirmative instead of giving up on it', () => {
    // The regression this exists for. Exact whole-string matching meant only a
    // bare "Yes" ever compared, so the module lost the finding precisely when
    // the customer was specific — and being specific is what a disclosure IS.
    // On a real sale the model read "Yes - £50,000 for daughter" against an
    // application recording "No", and it resolved to "could not verify".
    expect(compareAnswers('No', 'Yes - £50,000 for daughter', null)).toBe('mismatch');
    expect(compareAnswers('No', 'Yes — father, bowel cancer at 58', null)).toBe('mismatch');
    expect(compareAnswers('No', 'Yes, inhaler as a child', null)).toBe('mismatch');
    expect(compareAnswers('Yes', 'No - never smoked', null)).toBe('mismatch');
  });

  it('refuses an answer that takes itself back', () => {
    // "No, but I did have asthma" leads with a negative and means the opposite.
    // Reading its first word would invent a mismatch against a form that
    // correctly says Yes, so it stays unreadable — silence over a false
    // allegation.
    expect(compareAnswers('Yes', 'No, but I did have asthma as a child', null)).toBe('unclear');
    expect(compareAnswers('No', 'Yes, although only briefly', null)).toBe('unclear');
    expect(compareAnswers('Yes', 'No, except for one episode', null)).toBe('unclear');
  });

  it('does not read a field value that merely begins with a polar word', () => {
    // MetLife records "No Premium details" as a value, not as someone saying
    // no. A delimiter is required, which is what separates the two.
    expect(compareAnswers('No Premium details', 'No', null)).toBe('match');
    expect(compareAnswers('None of the above', 'No', null)).toBe('match');
    expect(compareAnswers('No', 'None of these', null)).toBe('match');
  });

  it('leaves non-polar answers exactly as they were', () => {
    expect(compareAnswers('Employed', 'Ambulance driver', null)).toBe('unclear');
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

  it('surfaces a required field left blank on the form', () => {
    expect(isActionable('missing_from_application')).toBe(true);
  });

  it('does not surface undetermined as a finding', () => {
    // It means we could not tell. Presenting it as a finding would bury the real
    // flags under noise our own redaction created.
    expect(isActionable('undetermined')).toBe(false);
    expect(isActionable('match')).toBe(false);
    expect(isActionable('no_application_answer')).toBe(false);
  });

  it('does not surface a recorded presence field', () => {
    // Nothing was verified about it, so it is neither a pass nor a flag.
    expect(isActionable('recorded')).toBe(false);
  });
});

describe('deriveChoiceTerms — the substance of a list-selection question', () => {
  it('takes the content of the options the adviser reads out', () => {
    const terms = deriveChoiceTerms([
      'Depression',
      'Anxiety',
      'Stress',
      'Any other mental health issue',
      'None of these',
    ]);
    expect(terms).toContain('depression');
    expect(terms).toContain('anxiety');
    expect(terms).toContain('stress');
    expect(terms).toContain('mental');
  });

  it('drops the options that are answers rather than content', () => {
    // Every list ends with one of these, and they are the words least worth
    // searching for: "no" and "none" appear in every call ever recorded.
    expect(deriveChoiceTerms(['No'])).toEqual([]);
    expect(deriveChoiceTerms(['None of these'])).toEqual([]);
    expect(deriveChoiceTerms(['Neither of these'])).toEqual([]);
    expect(deriveChoiceTerms(['Yes', 'No'])).toEqual([]);
  });

  it('says nothing where a question offered no options', () => {
    expect(deriveChoiceTerms(undefined)).toEqual([]);
    expect(deriveChoiceTerms([])).toEqual([]);
  });

  it('rescues a question whose own wording carries nothing to search for', () => {
    // "Have you ever:" is the whole question. Without its options there is
    // nothing distinctive to look for and the call can never be checked.
    expect(deriveSearchTerms('Have you ever:')).toEqual([]);
    expect(
      deriveChoiceTerms(['Been declined for insurance', 'Had special terms applied']).length
    ).toBeGreaterThan(0);
  });

  it('cannot make an absence meaningful on its own', () => {
    // The guarantee that keeps this from creating accusations: an adviser may
    // put a long list in their own words, so no option appearing verbatim is
    // not proof the question went unasked. absenceIsMeaningful sees only the
    // question's own wording, and these terms never reach it.
    const choiceTerms = deriveChoiceTerms(['Cancer', 'Leukaemia', 'Hodgkin\'s disease']);
    expect(choiceTerms.length).toBeGreaterThan(0);
    expect(absenceIsMeaningful(deriveSearchTerms('Have you ever:'))).toBe(false);
  });
});

describe('evidenceExcerpts — which passages get looked at', () => {
  // A topic raised four times across a long call. Only the third mention holds
  // the exchange; the others are the adviser trailing it and referring back.
  const build = () => {
    const filler = (n: number) => ` ${'and so on. '.repeat(n)}`;
    const parts = [
      'Agent: We will come to your bowels in a moment.',
      filler(70),
      'Agent: Right, bowels again, nearly there.',
      filler(70),
      'Agent: When did you first suffer from this bowel condition, and what tests and treatment did you have? Customer: 2022, a blood test, and I am fully recovered.',
      filler(70),
      'Agent: That is your bowels done.',
    ];
    return parts.join('');
  };

  it('prefers the passage matching most of the question, not the earliest', () => {
    const transcript = build();
    const terms = ['bowel', 'suffer', 'test', 'treatment', 'recover'];
    const excerpts = evidenceExcerpts(transcript, findEvidence(terms, transcript), 2);
    expect(excerpts.join(' ')).toContain('blood test');
    expect(excerpts.join(' ')).toContain('fully recovered');
  });

  it('returns the chosen passages in the order the call had them', () => {
    const transcript = build();
    const terms = ['bowel', 'suffer', 'test', 'treatment', 'recover'];
    const excerpts = evidenceExcerpts(transcript, findEvidence(terms, transcript), 3);
    const positions = excerpts.map((e) => transcript.indexOf(e.slice(0, 30)));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('is unchanged where every passage matches the search equally', () => {
    // A single-term search — an identity field, the common case — has nothing to
    // rank on, so the earliest passages win exactly as they always did.
    const transcript = `first mention of smoking.${' filler. '.repeat(90)}second smoking.${' filler. '.repeat(90)}third smoking.`;
    const excerpts = evidenceExcerpts(transcript, findEvidence(['smok'], transcript), 2);
    expect(excerpts[0]).toContain('first mention');
    expect(excerpts[1]).toContain('second');
  });

  it('never returns more than it was asked for', () => {
    const transcript = `smoking.${' filler. '.repeat(90)}smoking.${' filler. '.repeat(90)}smoking.${' filler. '.repeat(90)}smoking.`;
    expect(evidenceExcerpts(transcript, findEvidence(['smok'], transcript), 3)).toHaveLength(3);
  });
});

describe('an elapsed time spoken with a fraction', () => {
  const REF = new Date('2026-08-13T00:00:00Z');
  const compare = (app: string, call: string) => compareAnswers(app, call, REF);

  it('reads "3.5 years ago" as three and a half, not five', () => {
    // Live false accusation. The pattern required whole digits immediately
    // before "years", so it skipped the "3." and captured the 5 — resolving to
    // 2021 against a form recording 2023, and reporting the adviser as having
    // written down a year the customer never gave. The customer said 3.5 years
    // ago and the agent said "About 2023" back to them in the same breath.
    expect(compare('2023', '3.5 years ago')).toBe('match');
  });

  it('reads the same figure written with the half spelled out', () => {
    expect(compare('2023', '3 and a half years ago')).toBe('match');
  });

  it('declines rather than accuses where the number itself is a word', () => {
    // "three and a half" is not folded — the helper works on digits, and the
    // transcripts write numerals. Worth pinning that the result is 'unclear'
    // and not 'mismatch': unresolved is a gap, an accusation is a harm.
    expect(compare('2023', 'three and a half years ago')).toBe('unclear');
  });

  it('still disagrees where the years genuinely differ', () => {
    // The other side of it: loosening this must not stop the check working.
    expect(compare('2019', '3.5 years ago')).toBe('mismatch');
    expect(compare('2023', '7 years ago')).toBe('mismatch');
  });

  it('still matches a whole number of years', () => {
    expect(compare('2019', '7 years ago')).toBe('match');
    expect(compare('2020', '6 yrs back')).toBe('match');
  });
});

describe('a large figure the customer rounded when they said it', () => {
  it('does not accuse over £250 on an income the customer approximated', () => {
    // Live false accusation, at 0.95 confidence. The customer said "About
    // £48,000, I believe it is"; the adviser wrote what the payslip said.
    expect(compareAnswers('48250', '£48,000')).toBe('match');
  });

  it('still catches a figure that is genuinely different', () => {
    expect(compareAnswers('50000', '£45,000')).toBe('mismatch');
    expect(compareAnswers('100000', '£150,000')).toBe('mismatch');
  });

  it('leaves small numbers strict, which is where mis-keying shows up', () => {
    // The rule exists to catch 50 cigarettes keyed as 5, and a premium of £22
    // recorded against £36 spoken. A percentage of a small number would decide
    // neither.
    expect(compareAnswers('5', '50')).toBe('mismatch');
    expect(compareAnswers('22', '36')).toBe('mismatch');
    expect(compareAnswers('2', '3')).toBe('mismatch');
  });

  it('holds the line just outside the tolerance', () => {
    expect(compareAnswers('100000', '101000')).toBe('match');
    expect(compareAnswers('100000', '102000')).toBe('mismatch');
  });
});

describe('isFormDeclaration — a tickbox, not a question', () => {
  // The one observed live: it produced an 'asked_no_answer' against an adviser on
  // a Legal & General application, for not putting a portal instruction to the
  // customer aloud.
  it('claims the tickbox instructions', () => {
    for (const label of [
      'Please confirm you have read this statement by clicking this box.',
      'Confirm by ticking the box below',
      'I agree by checking this box',
      'Tick this box to confirm',
    ]) {
      expect(isFormDeclaration(label)).toBe(true);
    }
  });

  // Anchored on the box, not on "confirm" — these are spoken and must stay
  // comparable, several of them producing real findings.
  it('does not claim a spoken confirmation', () => {
    for (const label of [
      'Can I just confirm your date of birth',
      'Confirmed happy with cover, premium and everything applied for',
      'Please confirm you are a UK resident',
      'Bank account held in payers name',
    ]) {
      expect(isFormDeclaration(label)).toBe(false);
    }
  });

  it("resolves to 'none' — a ticked box says nothing either way", () => {
    expect(defaultCheckMode('Please confirm you have read this statement by clicking this box.')).toBe('none');
  });
});

describe('dateCandidates', () => {
  it('keeps both readings of an ambiguous numeric date', () => {
    expect(dateCandidates('03/04/1957').sort()).toEqual(
      [Date.UTC(1957, 3, 3), Date.UTC(1957, 2, 4)].sort()
    );
  });

  it('yields one reading when the day cannot be a month', () => {
    expect(dateCandidates('20/10/1962')).toEqual([Date.UTC(1962, 9, 20)]);
    expect(dateCandidates('05/20/1995')).toEqual([Date.UTC(1995, 4, 20)]);
  });

  it('reads a written month in either order', () => {
    expect(dateCandidates('20 October 1962')).toEqual([Date.UTC(1962, 9, 20)]);
    expect(dateCandidates('August 26, 2005')).toEqual([Date.UTC(2005, 7, 26)]);
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(dateCandidates('31/02/1990')).toEqual([]);
  });

  it('returns nothing for absent or unparseable values', () => {
    expect(dateCandidates(null)).toEqual([]);
    expect(dateCandidates('')).toEqual([]);
    expect(dateCandidates('some time in the eighties')).toEqual([]);
  });
});

describe('heightCandidatesCm', () => {
  it('reads a stated unit', () => {
    expect(heightCandidatesCm('1.83m')).toEqual([183]);
    expect(heightCandidatesCm('183cm')).toEqual([183]);
    expect(heightCandidatesCm('6 foot')).toEqual([182.88]);
    expect(heightCandidatesCm("5'7\"")).toEqual([170.18]);
    expect(heightCandidatesCm('6 feet 4 inches')).toEqual([193.04]);
  });

  it('reads a height spoken in words', () => {
    expect(heightCandidatesCm('Five foot six')).toEqual([167.64]);
    expect(heightCandidatesCm('five foot ten')).toEqual([177.8]);
  });

  // How a height comes back when the unit was said once and the transcript kept
  // only the figures. Observed on four sales.
  it('reads two bare numbers as feet and inches', () => {
    expect(heightCandidatesCm('5 7')).toEqual([170.18]);
    expect(heightCandidatesCm('5 3')).toEqual([160.02]);
  });

  // The application side is usually a bare number. Every unit it could be is
  // tried and the implausible readings dropped, which is what makes "6" six foot
  // and "183" a hundred and eighty-three centimetres without a rule about it.
  it('keeps only plausible readings of a bare number', () => {
    expect(heightCandidatesCm('1.83')).toEqual([183]);
    expect(heightCandidatesCm('183')).toEqual([183]);
    expect(heightCandidatesCm('6')).toEqual([182.88]);
  });

  it('returns nothing where there is no height to read', () => {
    expect(heightCandidatesCm('')).toEqual([]);
    expect(heightCandidatesCm('No')).toEqual([]);
    expect(heightCandidatesCm('99')).toEqual([]); // no human is 99cm or 99m
  });
});

describe('compareAnswers — heights', () => {
  // Every one of these was reported 'undetermined' or 'mismatch' on a live
  // tenant. The three that were mismatches are the same height in two units, and
  // one of them carried the model's own reasoning ending "so this matches".
  it('matches metric against imperial', () => {
    const observed: Array<[string, string]> = [
      ['1.83', '6 foot'],
      ['183cm', 'Just under 6 foot'],
      ['1.7', '5 7'],
      ['1.65', '5 5'],
      ['1.6', '5 3'],
      ['1.93', '6 foot 4'],
      ['1.68', 'Five foot six'],
      ['1.75', "5'9\""],
      ['1.73', '5 foot 8'],
      ['1.57', "5'2\""],
      ['1.8', "5'11\""],
      ['1.65m or 5 feet 5 inches', '5 foot 5'],
    ];
    for (const [app, call] of observed) {
      expect(compareAnswers(app, call), `${app} vs ${call}`).toBe('match');
    }
  });

  // Speech rounds to the nearest inch; a form field carries two decimals. 1.68m
  // against "5 foot 5" is 2.9cm apart and the same person.
  it('tolerates rounding to the nearest inch', () => {
    expect(compareAnswers('1.68', '5 foot 5')).toBe('match');
  });

  // The tolerance must not swallow a real mis-keying, which moves a height by a
  // decimetre or more.
  it('still reports a genuine height discrepancy', () => {
    expect(compareAnswers('1.83', '5 foot 4')).toBe('mismatch');
    expect(compareAnswers('1.63', '6 foot')).toBe('mismatch');
  });
});

describe('compareAnswers — dates', () => {
  // 22 of 51 date-of-birth comparisons went unresolved on a live tenant, most of
  // them one date written two ways.
  it('matches the same date in a different field order', () => {
    for (const [app, call] of [
      ['20/05/1995', '05/20/1995'],
      ['25/04/2002', '04/25/2002'],
      ['08/11/1999', '11/08/1999'],
      ['17/08/2003', '08/17/2003'],
    ] as Array<[string, string]>) {
      expect(compareAnswers(app, call), `${app} vs ${call}`).toBe('match');
    }
  });

  it('matches a written month against a numeric one', () => {
    expect(compareAnswers('20/10/1962', '20 October 1962')).toBe('match');
    expect(compareAnswers('10/2025', 'October 2025')).toBe('match');
  });

  // The three that were hidden inside the unresolved pile. A differing day or
  // year is a real discrepancy whatever order the fields are in.
  it('reports a date that genuinely differs', () => {
    expect(compareAnswers('09/04/1997', '19/04/1997')).toBe('mismatch');
    expect(compareAnswers('20/04/1968', '04/20/1969')).toBe('mismatch');
    expect(compareAnswers('20/10/1962', '04/05/1973')).toBe('mismatch');
  });
});

describe('coincidentalEvidence', () => {
  // Measured across 18 MetLife sales: "No. of Units" derives the single term
  // "unit" and matches a median of four times per call, because the adviser also
  // asks about units of alcohol. Four of that format's five findings came from
  // it, one reading a drinking answer against a cover-units field.
  it('flags one generic term matching all over the call', () => {
    expect(coincidentalEvidence(['unit'], 4)).toBe(true);
    expect(coincidentalEvidence(['unit'], 3)).toBe(true);
  });

  // Two hits could be the same exchange mentioned twice.
  it('accepts one term matching once or twice', () => {
    expect(coincidentalEvidence(['unit'], 1)).toBe(false);
    expect(coincidentalEvidence(['unit'], 2)).toBe(false);
  });

  // A single term matching nothing is not coincidental — it resolves
  // undetermined through the ordinary path. "UK Residency" does this on every
  // sale, and treating it as coincidental would say something different and
  // wrong about it.
  it('is not about absence', () => {
    expect(coincidentalEvidence(['residency'], 0)).toBe(false);
    expect(coincidentalEvidence([], 0)).toBe(false);
  });

  // A well-identified question mentioned often is fine — that is a question the
  // call genuinely returns to, not a word that happens to recur.
  it('accepts a well-identified question however often it matches', () => {
    expect(coincidentalEvidence(['monthly', 'premium'], 6)).toBe(false);
    expect(coincidentalEvidence(['active', 'lifestyle', 'cover'], 12)).toBe(false);
  });
});

describe('classifyItem — coincidental evidence', () => {
  const base = {
    applicationAnswer: '2',
    callAnswer: '5',
    callAnswerRedacted: false,
    evidenceFound: true,
    absenceMeaningful: false,
    redactedTranscript: false,
  };

  it('refuses to found a mismatch on a passage located by chance', () => {
    expect(classifyItem({ ...base, evidenceCoincidental: true })).toBe('undetermined');
  });

  // Including a match. If the passage is about something else, a value from it is
  // not this question's answer whether or not it happens to agree.
  it('refuses to found a match on it either', () => {
    expect(
      classifyItem({ ...base, callAnswer: '2', evidenceCoincidental: true })
    ).toBe('undetermined');
  });

  it('refuses to found an asked_no_answer on it', () => {
    expect(
      classifyItem({
        ...base,
        callAnswer: null,
        customerDidNotAnswer: true,
        evidenceCoincidental: true,
      })
    ).toBe('undetermined');
  });

  it('changes nothing when the evidence was properly located', () => {
    expect(classifyItem({ ...base, evidenceCoincidental: false })).toBe('mismatch');
    expect(classifyItem(base)).toBe('mismatch');
  });

  // The presence and none modes never consult call evidence, so the flag must
  // not disturb them.
  it('does not disturb the non-comparing modes', () => {
    expect(classifyItem({ ...base, checkMode: 'presence', evidenceCoincidental: true })).toBe('recorded');
    expect(classifyItem({ ...base, checkMode: 'none', evidenceCoincidental: true })).toBe('recorded');
  });
});

describe('checklistCovers — a category against the thing the customer named', () => {
  // All from live sales, all previously 'undetermined' at 0.85–0.95 confidence on
  // the question class that matters most.
  it('covers an instance named under a category', () => {
    expect(
      checklistCovers(
        "Cancer, cancer-in-situ, leukaemia, Hodgkin's disease or any other tumour",
        'Bladder cancer'
      )
    ).toBe(true);
    expect(
      checklistCovers('Arthritis, gout or anything else affecting your bones, joints', 'Arthritis in lower spine/back')
    ).toBe(true);
    expect(
      checklistCovers(
        'Kidney stones, urinary infection or anything else affecting your kidneys, prostate, bladder or urine',
        'Enlarged prostate'
      )
    ).toBe(true);
  });

  it('covers a paraphrase of the option itself', () => {
    expect(checklistCovers('Anxiety, Depression', 'Anxiety and depression')).toBe(true);
    expect(
      checklistCovers('Bleeding from the bowel or a change in bowel habit', 'Changing bowel habit')
    ).toBe(true);
    // "heart beat" written one way on the form and the other on the call.
    expect(
      checklistCovers('Heart attack, irregular heart beat, cardiomyopathy', 'Irregular heartbeat')
    ).toBe(true);
  });

  it('covers every item when the customer named several and all are on the list', () => {
    expect(
      checklistCovers(
        'Raised blood pressure, cholesterol or chest pain, Diabetes, borderline diabetes, A growth, lump or cyst',
        'Raised blood pressure, Raised cholesterol, Diabetes'
      )
    ).toBe(true);
  });

  // A checklist is multi-select, so "named three, recorded two" is a finding, not
  // a paraphrase. Reporting a match on partial coverage would paper over exactly
  // the under-recording this module exists to catch.
  it('refuses partial coverage', () => {
    expect(
      checklistCovers(
        'Raised blood pressure, raised cholesterol or chest pain',
        'Chest pain, Fibromyalgia'
      )
    ).toBe(false);
  });

  // A shared modifier must not decide anything. Both sides carry "raised"; only
  // one carries cholesterol.
  it('refuses a match resting on a shared modifier', () => {
    expect(checklistCovers('Raised blood pressure', 'Raised cholesterol')).toBe(false);
  });

  it('refuses an unrelated condition', () => {
    expect(
      checklistCovers('Impaired, blurred or double vision, optic neuritis', 'Hearing loss')
    ).toBe(false);
  });

  // Beyond a literal option list — "cataracts" is a disorder of the eye, but
  // nothing in the text says so. Left undetermined, which is honest.
  it('does not attempt semantic knowledge it does not have', () => {
    expect(
      checklistCovers(
        'Impaired, blurred or double vision, optic neuritis or anything else affecting your eyes',
        'Cataracts'
      )
    ).toBe(false);
  });

  // The class this must never touch: the application denies and the customer
  // disclosed. Those are potential non-disclosures and belong to a person.
  it('never covers a negative application answer', () => {
    expect(checklistCovers('No', 'Prescription medication, I use sertraline')).toBe(false);
    expect(checklistCovers('None of these', "I'm currently off work")).toBe(false);
    expect(checklistCovers('None of these', 'Smart Insurance')).toBe(false);
  });

  it('leaves an ordinary single-value comparison alone', () => {
    expect(checklistCovers('No', 'No')).toBe(false);
    expect(checklistCovers('2', '5')).toBe(false);
  });
});

describe('compareAnswers — two bare numbers one conversion reconciles', () => {
  // "How much do you weigh?" answered 65 on the form and 145 on the call. 65 kg
  // is 143 lb: the same person, two units, neither written down. It was being
  // reported as a mismatch — an accusation on a health field.
  it('refuses to accuse where a unit conversion reconciles the figures', () => {
    expect(compareAnswers('65', '145')).toBe('unclear');
  });

  // Deliberately not 'match'. Nothing establishes that they agree; what is
  // established is that a finding cannot rest on them.
  it('does not claim a match either', () => {
    expect(compareAnswers('65', '145')).not.toBe('match');
  });

  // A real mis-keying survives, because no conversion reconciles it.
  it('still reports a genuine discrepancy', () => {
    expect(compareAnswers('80', '120 to 130 kilograms')).toBe('mismatch');
    expect(compareAnswers('65', '95')).toBe('mismatch');
  });

  // Only plausible human weights, so two unrelated small numbers cannot
  // reconcile by arithmetic accident.
  it('does not reconcile numbers no person could weigh', () => {
    expect(compareAnswers('2', '5')).toBe('mismatch');
    expect(compareAnswers('1', '2')).toBe('mismatch');
  });

  // A stated unit means compareBareWeight's rules apply instead.
  it('leaves a stated unit to the weight rules', () => {
    expect(compareAnswers('76.2', '12 stone')).toBe('match');
  });
});
