import { describe, it, expect } from 'vitest';
import { sanitiseValues, type ValueExtractionRequest } from './reconciliation-values.js';

const requests: ValueExtractionRequest[] = [
  { key: '1', question: 'Do you smoke?', applicationAnswer: 'No', excerpt: '…' },
  { key: '2', question: 'How many units of alcohol?', applicationAnswer: '1', excerpt: '…' },
];

const entry = (over: Record<string, unknown> = {}) => ({
  key: '1',
  value: 'No',
  redacted: false,
  confidence: 0.9,
  reasoning: 'Customer said no.',
  ...over,
});

describe('sanitiseValues', () => {
  it('passes a well-formed answer through', () => {
    const [v] = sanitiseValues([entry()], requests);
    expect(v).toMatchObject({ key: '1', value: 'No', redacted: false, confidence: 0.9 });
  });

  it('discards a key the model invented', () => {
    // A hallucinated key would attach an answer to the wrong question, which is
    // worse than having no answer at all.
    expect(sanitiseValues([entry({ key: '99' })], requests)).toEqual([]);
  });

  it('keeps only the first answer for a repeated key', () => {
    const out = sanitiseValues([entry({ value: 'No' }), entry({ value: 'Yes' })], requests);
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBe('No');
  });

  it('downgrades a redaction placeholder to redacted-with-no-value', () => {
    // The model returning "[CONDITION_7]" as the customer's answer must never be
    // stored as though the customer said that. We know they answered; we cannot
    // see what they said.
    for (const tag of ['[CONDITION_7]', '[DRUG_3]', '[NUMBER]', 'about [CONDITION_12] I think']) {
      const [v] = sanitiseValues([entry({ value: tag })], requests);
      expect(v!.value).toBeNull();
      expect(v!.redacted).toBe(true);
    }
  });

  it('treats an empty or whitespace value as no answer', () => {
    expect(sanitiseValues([entry({ value: '' })], requests)[0]!.value).toBeNull();
    expect(sanitiseValues([entry({ value: '   ' })], requests)[0]!.value).toBeNull();
  });

  it('defaults a missing or out-of-range confidence to the midpoint', () => {
    expect(sanitiseValues([entry({ confidence: undefined })], requests)[0]!.confidence).toBe(0.5);
    expect(sanitiseValues([entry({ confidence: 5 })], requests)[0]!.confidence).toBe(0.5);
    expect(sanitiseValues([entry({ confidence: -1 })], requests)[0]!.confidence).toBe(0.5);
  });

  it('survives malformed entries without throwing', () => {
    // The model is prompted, not guaranteed. Junk must be dropped, not crash the
    // run and lose the deterministic findings alongside it.
    const out = sanitiseValues(
      [null, 'a string', 42, {}, { key: 2 }, entry()],
      requests
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('1');
  });

  it('returns nothing for an empty payload', () => {
    expect(sanitiseValues([], requests)).toEqual([]);
  });
});
