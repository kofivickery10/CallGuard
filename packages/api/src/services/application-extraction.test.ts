import { describe, it, expect } from 'vitest';
import { verifyExtractedPairs } from './application-extraction.js';

// The fallback's entire claim to safety is that nothing the model says survives
// unless the document itself contains it. These tests are the contract for that
// claim: a fabricated answer must die here, because two steps later it becomes
// a mismatch flag against a named adviser.

const DOCUMENT = `
PERSONAL DETAILS
Have you smoked or used any tobacco or nicotine products in the last 12 months?
No
YOUR HEALTH
In the last 5 years have you had any of these?
● Cancer
● Heart attack
None of the above
Has the cancer ever spread outside of its site of
origin? e.g. to nearby organs
No
How many units of alcohol do you drink in a typical week?
14
`;

const pair = (question: string, answer: string | null, extra: Partial<Record<string, unknown>> = {}) => ({
  question,
  section: null,
  guidance: null,
  choices: [],
  answer,
  ...extra,
});

describe('verifyExtractedPairs — the hallucination guard', () => {
  it('keeps a pair the document contains, word for word', () => {
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      pair('Have you smoked or used any tobacco or nicotine products in the last 12 months?', 'No'),
    ]);
    expect(dropped).toBe(0);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.answer).toBe('No');
  });

  it('forgives the line breaks the PDF extractor introduced', () => {
    // The question wraps mid-sentence in the document. The model, reading it as
    // one line, must not lose it to a whitespace mismatch.
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      pair('Has the cancer ever spread outside of its site of origin? e.g. to nearby organs', 'No'),
    ]);
    expect(dropped).toBe(0);
    expect(pairs).toHaveLength(1);
  });

  it('drops a question the document never asked', () => {
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      pair('Do you take part in any hazardous pursuits?', 'No'),
    ]);
    expect(pairs).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('drops the whole pair when the answer is not in the document, rather than nulling it', () => {
    // Nulling would assert "the insurer recorded no answer" on the model's
    // say-so, which downstream reads as the adviser skipping the question.
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      pair('How many units of alcohol do you drink in a typical week?', '30'),
    ]);
    expect(pairs).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('drops a paraphrased question, because paraphrase cannot be verified', () => {
    const { pairs } = verifyExtractedPairs(DOCUMENT, [
      pair('Any smoking or tobacco use in the past year?', 'No'),
    ]);
    expect(pairs).toHaveLength(0);
  });

  it('accepts a genuinely unanswered question as answer: null', () => {
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      pair('In the last 5 years have you had any of these?', null),
    ]);
    expect(dropped).toBe(0);
    expect(pairs[0]!.answer).toBeNull();
  });

  it('folds the section heading into guidance, so duplicate stems stay distinguishable', () => {
    const { pairs } = verifyExtractedPairs(DOCUMENT, [
      pair('In the last 5 years have you had any of these?', 'None of the above', {
        section: 'YOUR HEALTH',
      }),
    ]);
    expect(pairs[0]!.guidance).toBe('Section: YOUR HEALTH');
  });

  it('refuses anything from the rest of the pack riding in on a verified pair', () => {
    const doc = DOCUMENT + '\nWhat commission arrangement applies?\n4% of premium\n';
    const { pairs, dropped } = verifyExtractedPairs(doc, [
      pair('What commission arrangement applies?', '4% of premium'),
    ]);
    expect(pairs).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('renumbers surviving pairs so order stays dense after drops', () => {
    const { pairs } = verifyExtractedPairs(DOCUMENT, [
      pair('An invented question that is not there?', 'Yes'),
      pair('How many units of alcohol do you drink in a typical week?', '14'),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.order).toBe(1);
  });

  it('survives junk entries without throwing', () => {
    const { pairs, dropped } = verifyExtractedPairs(DOCUMENT, [
      null,
      42,
      { question: 17, answer: 'No' },
      pair('', 'No'),
    ]);
    expect(pairs).toHaveLength(0);
    expect(dropped).toBe(4);
  });
});
