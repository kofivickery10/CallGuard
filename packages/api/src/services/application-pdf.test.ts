import { describe, it, expect } from 'vitest';
import {
  parseApplication,
  parseQuestionAnswer,
  fingerprintQuestions,
  detectDrift,
  matchProfile,
  isolateSection,
  rankAttachmentCandidates,
} from './application-pdf.js';
import {
  ROYAL_LONDON_PACK,
  ROYAL_LONDON_CONFIG,
  METLIFE_SUMMARY,
  METLIFE_CONFIG,
  PORTAL_EXPORT,
  PORTAL_CONFIG,
} from './application-pdf.fixtures.js';

describe('question_answer strategy (Royal London pack)', () => {
  const parsed = parseApplication(ROYAL_LONDON_PACK, 'question_answer', ROYAL_LONDON_CONFIG);
  const byQuestion = (needle: string) =>
    parsed.pairs.find((p) => p.question.toLowerCase().includes(needle.toLowerCase()));

  it('extracts a question set', () => {
    expect(parsed.empty).toBe(false);
    expect(parsed.pairs.length).toBeGreaterThan(15);
  });

  it('pairs each question with its submitted answer', () => {
    expect(byQuestion('what is your height')?.answer).toBe('1.75m or 5 feet 9 inches');
    expect(byQuestion('what is your weight')?.answer).toBe('111.1kg or 17 stone 7 pounds');
    expect(byQuestion('how many units of alcohol')?.answer).toBe('1');
    expect(byQuestion('what is your current job')?.answer).toBe('HGV Driver');
  });

  it('captures conditional follow-up questions, not just the top-level ones', () => {
    // "Have you ever smoked" = Yes spawns four follow-ups. These only exist
    // because of the answer given, which is exactly why the document is a better
    // question list than any hand-authored one.
    expect(byQuestion('have you ever smoked')?.answer).toBe('Yes');
    expect(byQuestion('when did you last smoke')?.answer).toBe('1986');
    expect(byQuestion('how many cigarettes')?.answer).toBe('50');
    // Raised blood pressure = Yes spawns a whole further section.
    expect(byQuestion('currently on treatment for raised blood pressure')?.answer).toBe('Yes');
    expect(byQuestion('how many blood pressure medications')?.answer).toBe('1');
    expect(byQuestion('bigger number')?.answer).toBe('135');
    expect(byQuestion('smaller number')?.answer).toBe('80');
  });

  it('preserves the numeric answers reconciliation depends on', () => {
    // These are the answers worth comparing, and the ones Deepgram's `numbers`
    // redaction destroys on the call side.
    const numeric = ['50', '1', '135', '80', '44000'];
    for (const n of numeric) {
      expect(parsed.pairs.some((p) => p.answer === n)).toBe(true);
    }
  });

  it('records multiple-choice options offered', () => {
    const products = byQuestion('which of the following products');
    expect(products?.choices).toContain('Cigarettes');
    expect(products?.choices).toContain('Pipes');
    expect(products?.answer).toBe('Cigarettes');
  });

  it('keeps the insurer guidance, which often defines the question scope', () => {
    const everSmoked = byQuestion('have you ever smoked');
    expect(everSmoked?.guidance).toContain('occasional basis');
  });

  it('treats the insurer\'s own unanswered marker as no answer', () => {
    // Royal London prints "Unanswered" rather than leaving a value blank, so an
    // unanswered question must not read as answered-with-the-literal-word.
    const pairs = parseQuestionAnswer(
      'Do you have a second phone number?\nYour answer(s):\nUnanswered\n\nNext question?\nYour answer(s):\nYes\n',
      ROYAL_LONDON_CONFIG
    );
    expect(pairs[0]?.question).toBe('Do you have a second phone number?');
    expect(pairs[0]?.answer).toBeNull();
    expect(pairs[1]?.answer).toBe('Yes');
  });

  it('does not fold the preceding page\'s content into a question', () => {
    // The block before a question carries leftovers from the previous page —
    // adviser details, the customer's own name. Folding those in corrupts the
    // wording and makes two sales of the same product fingerprint differently.
    const first = byQuestion('do you have an existing plan');
    expect(first?.question).toBe(
      'Do you have an existing plan or application with Royal London?'
    );
    expect(JSON.stringify(parsed.pairs)).not.toContain('sample applicant');
    expect(JSON.stringify(parsed.pairs)).not.toContain('Adviser name');
  });

  it('reads only the application, not the rest of the pack', () => {
    const all = JSON.stringify(parsed.pairs);
    // Commission schedule — the firm's own earnings, no business being here.
    expect(all).not.toContain('1,158.26');
    // Underwriting quote.
    expect(all).not.toContain('46.64');
    expect(all).not.toContain('Smoker status');
    // Medical-consent form and blank confirmation form, which precede it.
    expect(all).not.toContain('ACCESS TO MEDICAL REPORTS');
    expect(all).not.toContain('Page within the application form');
  });

  it('strips page footers and document identifiers', () => {
    const all = JSON.stringify(parsed.pairs);
    expect(all).not.toContain('page 5 of 16');
    expect(all).not.toContain('EX004A');
    expect(all).not.toContain('I0R0');
  });

  it('returns nothing when the delimiter is absent rather than guessing', () => {
    expect(parseQuestionAnswer('some other document entirely', ROYAL_LONDON_CONFIG)).toEqual([]);
  });
});

describe('label_value strategy (MetLife summary)', () => {
  const parsed = parseApplication(METLIFE_SUMMARY, 'label_value', METLIFE_CONFIG);
  const val = (label: string) =>
    parsed.pairs.find((p) => p.question === label)?.answer;

  it('extracts the summary fields', () => {
    expect(parsed.empty).toBe(false);
    expect(val('Policy number')).toBe('EPH000001');
    expect(val('Occupation')).toBe('Instructor - Other');
    expect(val('UK Residency')).toBe('Yes');
    expect(val('No. of Units')).toBe('3');
    expect(val('Child Cover')).toBe('No');
    expect(val('Monthly premium')).toBe('£33.00');
  });

  it('handles a label split across lines by two-column extraction', () => {
    // "Marital \nstatus:" and "Employment \nstatus:" are broken mid-label.
    expect(val('Marital status')).toBe('Single');
    expect(val('Employment status')).toBe('Employed');
  });

  it('handles a value on the line after its label', () => {
    expect(val('Email')).toBe('sample@example.invalid');
    expect(val('Day tel no')).toBe('07000000000');
  });

  it('stops a multi-line value at the next label', () => {
    // The address runs over four lines and must not swallow "Email:".
    expect(val('Address')).toBe('1 Sample Street Sampletown Sampleshire United Kingdom AB12 3CD');
  });

  it('does not capture the commission disclosure', () => {
    const all = JSON.stringify(parsed.pairs);
    expect(all).not.toContain('712.80');
    expect(all).not.toContain('7,194.00');
  });

  it('contains no health questions at all — the caller must report this', () => {
    // The product is underwritten on eligibility, not medically. A clean
    // reconciliation result here is NOT evidence that health answers matched.
    const all = JSON.stringify(parsed.pairs).toLowerCase();
    for (const term of ['smoke', 'cancer', 'diabetes', 'blood pressure', 'medication']) {
      expect(all).not.toContain(term);
    }
  });
});

describe('question_marker strategy (quote-portal export)', () => {
  const parsed = parseApplication(PORTAL_EXPORT, 'question_marker', PORTAL_CONFIG);
  const byQuestion = (needle: string) =>
    parsed.pairs.find((p) => p.question.toLowerCase().includes(needle.toLowerCase()));

  it('pairs answers with the question they precede', () => {
    expect(parsed.empty).toBe(false);
    expect(byQuestion('date of birth')?.answer).toBe('18/11/1971');
    expect(byQuestion('how tall are you')?.answer).toBe('1.57m or 5 feet 2 inches');
    expect(byQuestion('how much do you weigh')?.answer).toBe('54kg or 8 stone 7 pounds');
    expect(byQuestion('what is your job')?.answer).toBe('Pupil Support Assistant');
  });

  it('leaves nothing unanswered when the document answered everything', () => {
    expect(parsed.pairs.filter((p) => p.answer === null)).toEqual([]);
  });

  it('captures the timestamp and who recorded each answer', () => {
    const dob = byQuestion('date of birth');
    expect(dob?.answeredAt).toBe('29/07/2026 11:57');
    expect(dob?.recordedBy).toBe('A Adviser');
  });

  it('rejoins an answer whose attribution wrapped onto the next line', () => {
    // Long option values push "(A Adviser)" to the following line. Left split,
    // the answer is silently dropped — this cost the smoking answer on two of
    // the three real documents.
    expect(byQuestion('which of the following describe you')?.answer).toBe(
      "I've never smoked, vaped, used e-cigarettes or other nicotine replacement products"
    );
  });

  it('treats multiple answers as an amendment, keeping the last as current', () => {
    const family = byQuestion('birth parents');
    expect(family?.answer).toBe('Any other cancer');
    expect(family?.revisions?.map((r) => r.value)).toEqual(['No']);
  });

  it('records a disclosure that was entered and then withdrawn', () => {
    // The reason revisions are worth keeping. The final answer alone reads as a
    // clean "None of these"; the trail shows Stress was disclosed and removed.
    // Whether that was a mis-click or something else is for a supervisor and the
    // call recording to settle, but it cannot be settled if it is not surfaced.
    const mental = byQuestion('last 5 years');
    expect(mental?.answer).toBe('None of these');
    expect(mental?.revisions?.map((r) => r.value)).toEqual(['None of these', 'Stress']);
  });

  it('records a numeric answer being changed', () => {
    const spirits = byQuestion('measures of spirits');
    expect(spirits?.answer).toBe('3');
    expect(spirits?.revisions?.map((r) => r.value)).toEqual(['0']);
  });

  it('captures the choices offered', () => {
    expect(byQuestion('smoking habits')?.choices).toEqual(['Non-smoker', 'Smoker']);
  });

  it('keeps the guidance', () => {
    expect(byQuestion('smoking habits')?.guidance).toContain('nicotine replacement');
  });

  it('strips page markers', () => {
    expect(JSON.stringify(parsed.pairs)).not.toContain('of 9');
  });

  it('returns nothing when the marker is absent rather than guessing', () => {
    expect(parseApplication('a plain document', 'question_marker', PORTAL_CONFIG).empty).toBe(true);
  });
});

describe('fingerprinting', () => {
  it('is stable across cosmetic differences', () => {
    const a = fingerprintQuestions(['What is your height?', 'What is your weight?']);
    const b = fingerprintQuestions(['what is your  HEIGHT', 'What is your weight?  ']);
    expect(a).toBe(b);
  });

  it('changes when a question is added', () => {
    const a = fingerprintQuestions(['Q1?', 'Q2?']);
    const b = fingerprintQuestions(['Q1?', 'Q2?', 'Q3?']);
    expect(a).not.toBe(b);
  });

  it('changes when questions are reordered', () => {
    expect(fingerprintQuestions(['Q1?', 'Q2?'])).not.toBe(fingerprintQuestions(['Q2?', 'Q1?']));
  });

  it('is identical for two sales of the same product', () => {
    // The whole cost argument rests on this: same product, same fingerprint,
    // so the stored profile is reused and no model pass runs.
    const first = parseApplication(ROYAL_LONDON_PACK, 'question_answer', ROYAL_LONDON_CONFIG);
    const second = parseApplication(
      ROYAL_LONDON_PACK.replace('sample applicant', 'someone else').replace('50', '20'),
      'question_answer',
      ROYAL_LONDON_CONFIG
    );
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe('drift detection', () => {
  it('reports no change for an identical question set', () => {
    const d = detectDrift(['Q1?', 'Q2?'], ['Q1?', 'Q2?']);
    expect(d.changed).toBe(false);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('names a newly added question', () => {
    // The dangerous case: a new health question nobody has the habit of asking.
    const d = detectDrift(
      ['Do you smoke?'],
      ['Do you smoke?', 'Have you used weight-loss injections?']
    );
    expect(d.changed).toBe(true);
    expect(d.added).toEqual(['Have you used weight-loss injections?']);
    expect(d.removed).toEqual([]);
  });

  it('names a removed question, which would otherwise show as missed forever', () => {
    const d = detectDrift(['Do you smoke?', 'Old question?'], ['Do you smoke?']);
    expect(d.changed).toBe(true);
    expect(d.removed).toEqual(['Old question?']);
  });

  it('distinguishes a reorder from a content change', () => {
    const d = detectDrift(['Q1?', 'Q2?'], ['Q2?', 'Q1?']);
    expect(d.changed).toBe(true);
    expect(d.reordered).toBe(true);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });
});

describe('profile matching', () => {
  const profiles = [
    { name: 'royal-london', detect_patterns: ['Personal Menu Plan', 'Your answer(s):'] },
    { name: 'metlife', detect_patterns: ['MetLife EverydayProtect', 'Summary of application details'] },
  ];

  it('identifies each document by content', () => {
    expect(matchProfile(ROYAL_LONDON_PACK, profiles)?.name).toBe('royal-london');
    expect(matchProfile(METLIFE_SUMMARY, profiles)?.name).toBe('metlife');
  });

  it('requires every pattern, so a lookalike cannot match by coincidence', () => {
    // A firm's own suitability report mentions the product but carries no
    // application answers. It must not satisfy the insurer profile.
    const suitabilityReport = 'Suitability Report — we recommend the Personal Menu Plan for you.';
    expect(matchProfile(suitabilityReport, profiles)).toBeNull();
  });

  it('returns null rather than guessing when nothing matches', () => {
    expect(matchProfile('an unrelated document', profiles)).toBeNull();
  });

  // Verbatim from `app Mr Patrick Dixon.pdf`, line break and all. The sentence
  // reads as one line on the page; the extractor returns it broken where the
  // column ran out. A raw substring test threw away a correct profile learned
  // from this exact document.
  const WRAPPED =
    'The information you have provided\n' +
    'This is the information that you have provided to us and upon which we will rely to produce your individual\n' +
    'quotation. This information will form the basis of a contract between yourself and your insurer.\n' +
    'Customer name: Patrick Dixon';

  it('finds a pattern the PDF wrapped across a line break', () => {
    const wrappedProfile = [
      {
        name: 'quote-portal',
        detect_patterns: [
          'This is the information that you have provided to us and upon which we will rely to produce your individual quotation',
          'This information will form the basis of a contract between yourself and your insurer',
        ],
      },
    ];
    expect(matchProfile(WRAPPED, wrappedProfile)?.name).toBe('quote-portal');
  });

  it('is not confused by curly quotes or non-breaking spaces', () => {
    const rendered = 'The insurer’s own record of\nwhat you told us';
    const profile = [{ name: 'typographic', detect_patterns: ["The insurer's own record of what you told us"] }];
    expect(matchProfile(rendered, profile)?.name).toBe('typographic');
  });

  it('still requires every pattern once whitespace stops mattering', () => {
    const profile = [
      {
        name: 'strict',
        detect_patterns: [
          'This is the information that you have provided to us',
          'a sentence that is nowhere in this document',
        ],
      },
    ];
    expect(matchProfile(WRAPPED, profile)).toBeNull();
  });

  it('does not join words that were never adjacent', () => {
    // Collapsing whitespace must not let "individual" and "quotation" match a
    // document where they sit in different sentences entirely.
    const unrelated = 'your individual.\nSeparately: quotation of charges.';
    const profile = [{ name: 'x', detect_patterns: ['your individual quotation'] }];
    expect(matchProfile(unrelated, profile)).toBeNull();
  });
});

describe('attachment ranking', () => {
  // The real attachment list from a Trust Point sale record.
  const real = [
    { file_name: 'Jimmy--Coyle-ss.pdf' },
    { file_name: 'Jimmy Coyle Suitability Report - Policy.zdoc.pdf' },
    { file_name: 'Jimmy Coyle Suitability Report.zdoc.pdf' },
    { file_name: 'Application Details (5).pdf' },
  ];

  it('puts the application first and the suitability reports last', () => {
    const ranked = rankAttachmentCandidates(real);
    expect(ranked[0]?.file_name).toBe('Application Details (5).pdf');
    expect(ranked[ranked.length - 1]?.file_name).toMatch(/Suitability Report/);
  });

  it('also ranks the other real naming convention first', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'Some Illustration.pdf' },
      { file_name: 'Client review for graham davies.pdf' },
    ]);
    expect(ranked[0]?.file_name).toBe('Client review for graham davies.pdf');
  });

  it('never drops a candidate on filename alone', () => {
    // No positive pattern covers both real naming conventions, so exclusion by
    // filename would eventually discard the real application. Ranking only
    // reorders; content decides.
    const ranked = rankAttachmentCandidates(real);
    expect(ranked).toHaveLength(real.length);
  });

  it('drops non-PDFs', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'notes.txt' },
      { file_name: 'Application Details.pdf' },
      { file_name: 'scan.jpg' },
    ]);
    expect(ranked.map((r) => r.file_name)).toEqual(['Application Details.pdf']);
  });

  it('prefers the most recent when scores tie, so an amended re-upload wins', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'Application Details (1).pdf', created_time: '2026-07-30T09:00:00+01:00' },
      { file_name: 'Application Details (5).pdf', created_time: '2026-07-31T14:00:00+01:00' },
    ]);
    expect(ranked[0]?.file_name).toBe('Application Details (5).pdf');
  });

  it('is stable for genuine ties', () => {
    const input = [{ file_name: 'a.pdf' }, { file_name: 'b.pdf' }, { file_name: 'c.pdf' }];
    expect(rankAttachmentCandidates(input).map((r) => r.file_name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  // The Patric Dixon pack: the application and the firm's own document differ by
  // the three letters an adviser typed. Both scored 0 before, so which one was
  // downloaded first came down to the order Zoho happened to list them in.
  it('recognises the "app" abbreviation an adviser types by hand', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'Mr Patrick Dixon.pdf' },
      { file_name: 'app Mr Patrick Dixon.pdf' },
    ]);
    expect(ranked[0]?.file_name).toBe('app Mr Patrick Dixon.pdf');
  });

  it('still puts an explicit "Application" ahead of a bare "app"', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'app Mr Patrick Dixon.pdf' },
      { file_name: 'Application Details.pdf' },
    ]);
    expect(ranked[0]?.file_name).toBe('Application Details.pdf');
  });

  it('does not fire on words that merely start with app', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'appendix.pdf' },
      { file_name: 'happy customers.pdf' },
      { file_name: 'app Mr Patrick Dixon.pdf' },
    ]);
    expect(ranked[0]?.file_name).toBe('app Mr Patrick Dixon.pdf');
    // The other two are untouched ties, so they keep their input order.
    expect(ranked.slice(1).map((r) => r.file_name)).toEqual(['appendix.pdf', 'happy customers.pdf']);
  });

  it('does not let "app" outrank the suitability-report penalty', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'app suitability report.pdf' },
      { file_name: 'Client review for graham davies.pdf' },
    ]);
    expect(ranked[0]?.file_name).toBe('Client review for graham davies.pdf');
  });
});

describe('section isolation', () => {
  it('returns the whole text when no markers are configured', () => {
    expect(isolateSection('abc', {})).toBe('abc');
  });

  it('is tolerant of a missing end marker', () => {
    const out = isolateSection('START keep this', { sectionStart: 'START', sectionEnd: 'NOPE' });
    expect(out.trim()).toBe('keep this');
  });
});

describe('link attachments and the real Trust Point naming', () => {
  it('drops Zoho link attachments, which can never be downloaded', () => {
    // A link reports no size. Asking Zoho for its body returns nothing and the
    // extractor then fails with "The PDF file is empty" — 14 of the first
    // tenant's attachments across 8 sales are these.
    const ranked = rankAttachmentCandidates([
      { file_name: 'Plan Details.pdf', size: null },
      { file_name: 'h+l frazer.pdf', size: 14401 },
      { file_name: 'RL Key Facts.pdf', size: 0 },
    ]);
    expect(ranked.map((r) => r.file_name)).toEqual(['h+l frazer.pdf']);
  });

  it('leaves ranking untouched when size is not supplied at all', () => {
    const ranked = rankAttachmentCandidates([{ file_name: 'Application Details.pdf' }]);
    expect(ranked).toHaveLength(1);
  });

  it('puts the health-and-lifestyle questionnaire first', () => {
    // The document reconciliation actually wants: the underwriting questions.
    const ranked = rankAttachmentCandidates([
      { file_name: 'Belinda--Wye-ss.pdf', size: 1600 },
      { file_name: 'quote belinda.pdf', size: 5000 },
      { file_name: 'h+l belinda.pdf', size: 15000 },
      { file_name: 'Belinda Wye Suitability Report.zdoc.pdf', size: 9000 },
    ]);
    expect(ranked[0]?.file_name).toBe('h+l belinda.pdf');
    expect(ranked[ranked.length - 1]?.file_name).toMatch(/Suitability/);
  });

  it('demotes the sanctions search that outranked three real applications', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'Chloe--Sonnex-ss.pdf', size: 1628 },
      { file_name: 'h+l chloe.pdf', size: 16000 },
    ]);
    expect(ranked[0]?.file_name).toBe('h+l chloe.pdf');
  });

  it('demotes trustee forms and brochures', () => {
    const ranked = rankAttachmentCandidates([
      { file_name: 'David Carter Trustee Forms.pdf', size: 38069 },
      { file_name: 'Everyday Protect Brochure.pdf', size: 9000 },
      { file_name: 'David Carter Policy.pdf', size: 12000 },
    ]);
    expect(ranked[0]?.file_name).toBe('David Carter Policy.pdf');
  });
});
