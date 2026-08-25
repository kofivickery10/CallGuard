import { describe, it, expect } from 'vitest';
import {
  auditQuestionSet,
  corruptionFlags,
  looksCorrupt,
  proposalIsUsable,
  repairFromObserved,
} from './question-quality.js';

// The four on the first deploying firm's live UnderwriteMe profile, all in the
// mental-health block.
const MANGLED = [
  'In the have you had any of these? last 5 years',
  'Have you had any of these? ever',
  'Have you : ever',
];

// Real questions from the same profile, intact.
const INTACT = [
  'In the last 5 years have you had any of these?',
  'Have you ever had any of these?',
  'Have you ever:',
  'Have your birth parents, brothers, or sisters had any of these before they were 65?',
  'What cancer or tumour have you had?',
  'Have you ever stopped taking prescribed medication without being told to do so by a doctor or nurse?',
  'In the last 5 years, who have you seen for this?',
];

describe('corruptionFlags', () => {
  it('catches every shape observed in the wild', () => {
    for (const q of MANGLED) {
      expect(looksCorrupt(q), q).toBe(true);
    }
    expect(corruptionFlags('Have you : ever').map((f) => f.name)).toContain('stranded colon');
    expect(
      corruptionFlags('In the have you had any of these? last 5 years').map((f) => f.name)
    ).toContain('interior question mark');
  });

  it('catches page furniture captured as a question', () => {
    // Five of one proposed Aviva profile's eight "questions" were these.
    expect(corruptionFlags('Page \t2 \tof \t6').length).toBeGreaterThan(0);
    expect(corruptionFlags('-- 1 of 2 --').map((f) => f.name)).toContain('page furniture');
  });

  it('catches the one real fragment by its truncated tail', () => {
    // Observed on a proposed Royal London profile.
    expect(corruptionFlags('For').map((f) => f.name)).toContain('truncated tail');
  });

  // These are real questions on a summary-sheet format, and a "too short" test
  // put two legitimate National Friendly formats over the refusal threshold.
  it('passes short field labels, which are questions on a summary sheet', () => {
    for (const q of ['Name', 'DOB', 'Age', 'Term', 'Sex', 'No. of Units']) {
      expect(looksCorrupt(q), q).toBe(false);
    }
  });

  // The tests judge shape, never wording. A long, awkward, or oddly punctuated
  // question that a real insurer printed must pass.
  it('passes intact questions, including the awkward ones', () => {
    for (const q of INTACT) {
      expect(looksCorrupt(q), q).toBe(false);
    }
    for (const q of [
      'Have you ever had, or are you waiting to have, chemotherapy or radiotherapy for this condition?',
      'In the last 5 years, how many days have you taken off work because of this? If you don’t work, on how many days have you found your normal daily tasks difficult to perform?',
      'Which of the following describe you?',
      'Bank account held in payers name',
      'No. of Units',
      'Day tel no',
    ]) {
      expect(looksCorrupt(q), q).toBe(false);
    }
  });
});

describe('auditQuestionSet', () => {
  it('reports the share that looks mangled', () => {
    const audit = auditQuestionSet([...INTACT, ...MANGLED]);
    expect(audit.total).toBe(10);
    expect(audit.corrupt).toHaveLength(3);
    expect(audit.corrupt.map((c) => c.index)).toEqual([7, 8, 9]);
    expect(audit.corruptShare).toBeCloseTo(0.3);
  });

  it('handles an empty set without dividing by zero', () => {
    expect(auditQuestionSet([]).corruptShare).toBe(0);
  });
});

describe('proposalIsUsable', () => {
  // 4 of 39 on a format that is genuinely useful. Rejecting it would lose the
  // profile doing most of the tenant's work over a fixable flaw.
  it('accepts a good format with a few rough edges', () => {
    const questions = [...Array(35).fill('Have you ever had any of these?'), ...MANGLED, 'Have you : ever'];
    expect(questions).toHaveLength(39);
    expect(proposalIsUsable(questions)).toBe(true);
  });

  // Five page footers out of eight. Offering this to a human wastes their time on
  // something they can only reject.
  it('refuses a parse that mostly failed', () => {
    expect(
      proposalIsUsable([
        'Page \t2 \tof \t6',
        'Page \t3 \tof \t6',
        'Page \t4 \tof \t6',
        'Page \t5 \tof \t6',
        'Page \t6 \tof \t6',
        'Have you ever had any of these?',
        'Have you ever:',
        'What cancer or tumour have you had?',
      ])
    ).toBe(false);
  });
});

describe('repairFromObserved', () => {
  // The corruption is span re-ordering, so the mangled and the intact text carry
  // the same words. That makes the repair derivable from evidence.
  it('recovers the intact wording', () => {
    expect(repairFromObserved('In the have you had any of these? last 5 years', INTACT)).toBe(
      'In the last 5 years have you had any of these?'
    );
    expect(repairFromObserved('Have you had any of these? ever', INTACT)).toBe(
      'Have you ever had any of these?'
    );
    expect(repairFromObserved('Have you : ever', INTACT)).toBe('Have you ever:');
  });

  it('declines when nothing observed matches', () => {
    expect(repairFromObserved('Have you : ever', ['What is your job?'])).toBeNull();
  });

  // Two candidates sharing a word multiset means the evidence does not say which
  // was meant, and rewriting a question into a different question is worse than
  // leaving it mangled.
  it('declines when the evidence is ambiguous', () => {
    expect(
      repairFromObserved('the of end year', ['end of the year', 'the year of end'])
    ).toBeNull();
  });

  it('does not offer the mangled text back as its own repair', () => {
    expect(repairFromObserved('Have you : ever', ['Have you : ever'])).toBeNull();
  });
});
