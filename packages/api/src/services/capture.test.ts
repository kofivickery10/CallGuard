import { describe, it, expect } from 'vitest';
import { sanitizeAnswers, type RawCaptureAnswer } from './capture.js';
import type { CaptureFormField } from '@callguard/shared';

// The enforcement layer between the model and the database. These rules are
// load-bearing for the product's data-protection story — a regression here
// stores personal/health data the tenant was promised we never store.

function field(overrides: Partial<CaptureFormField>): CaptureFormField {
  return {
    id: 'f1',
    form_id: 'form1',
    sort_order: 0,
    label: 'Question',
    description: null,
    answer_type: 'text',
    choices: null,
    required: true,
    pii_class: 'none',
    applies_when: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function raw(overrides: Partial<RawCaptureAnswer>): RawCaptureAnswer {
  return {
    field_id: 'f1',
    asked: true,
    answered: true,
    value: 'some answer',
    confidence: 0.9,
    evidence: '"quoted evidence"',
    reasoning: 'clear in transcript',
    ...overrides,
  };
}

describe('sanitizeAnswers — PII enforcement', () => {
  it('suppresses the value for a health field even when the model returns one', () => {
    const [a] = sanitizeAnswers(
      [field({ pii_class: 'health' })],
      [raw({ value: 'diagnosed with angina in 2019' })]
    );
    expect(a!.result).toBe('confirmed_only');
    expect(a!.captured_value).toBeNull();
    expect(a!.value_redacted).toBe(true);
  });

  it('suppresses the value for a personal field', () => {
    const [a] = sanitizeAnswers(
      [field({ pii_class: 'personal' })],
      [raw({ value: '14 Acacia Avenue' })]
    );
    expect(a!.result).toBe('confirmed_only');
    expect(a!.captured_value).toBeNull();
  });

  it('treats a bare redaction tag as confirmed-only, not a captured value', () => {
    const [a] = sanitizeAnswers([field({})], [raw({ value: '[PII_NAME_1]' })]);
    expect(a!.result).toBe('confirmed_only');
    expect(a!.captured_value).toBeNull();
    expect(a!.value_redacted).toBe(true);
  });

  it('stores the value for a non-PII field', () => {
    const [a] = sanitizeAnswers([field({})], [raw({ value: '25 year term' })]);
    expect(a!.result).toBe('captured');
    expect(a!.captured_value).toBe('25 year term');
    expect(a!.value_redacted).toBe(false);
  });
});

describe('sanitizeAnswers — result derivation', () => {
  it('marks an unanswered field as missed', () => {
    const [a] = sanitizeAnswers([field({})], [raw({ asked: false, answered: false, value: null })]);
    expect(a!.result).toBe('missed');
    expect(a!.asked).toBe(false);
  });

  it('routes a low-confidence required answer to manual_review', () => {
    const [a] = sanitizeAnswers([field({ required: true })], [raw({ confidence: 0.4 })]);
    expect(a!.result).toBe('manual_review');
    expect(a!.captured_value).toBeNull();
  });

  it('does NOT route a low-confidence optional answer to manual_review', () => {
    const [a] = sanitizeAnswers([field({ required: false })], [raw({ confidence: 0.4 })]);
    expect(a!.result).toBe('captured');
  });

  it('reports a field the model omitted as missed at zero confidence', () => {
    const answers = sanitizeAnswers(
      [field({ id: 'f1' }), field({ id: 'f2', label: 'Second question', required: false })],
      [raw({ field_id: 'f1' })]
    );
    expect(answers).toHaveLength(2);
    expect(answers[1]!.result).toBe('missed');
    expect(answers[1]!.confidence).toBe(0);
  });
});

describe('sanitizeAnswers — value coercion and evidence attribution', () => {
  it('normalises yes/no answers', () => {
    const [a] = sanitizeAnswers([field({ answer_type: 'yes_no' })], [raw({ value: 'Yeah, that is right' })]);
    expect(a!.captured_value).toBe('yes');
  });

  it('strips currency formatting to a plain number', () => {
    const [a] = sanitizeAnswers([field({ answer_type: 'currency' })], [raw({ value: '£150,000' })]);
    expect(a!.captured_value).toBe('150000');
  });

  it('matches choice answers case-insensitively to the canonical choice', () => {
    const [a] = sanitizeAnswers(
      [field({ answer_type: 'choice', choices: ['Never', 'Current', 'Former'] })],
      [raw({ value: 'former' })]
    );
    expect(a!.captured_value).toBe('Former');
  });

  it('keeps an uncoercible value verbatim rather than dropping it', () => {
    const [a] = sanitizeAnswers([field({ answer_type: 'number' })], [raw({ value: 'about thirty' })]);
    expect(a!.captured_value).toBe('about thirty');
  });

  it('parses the [Call N] evidence marker into a source call index', () => {
    const [a] = sanitizeAnswers([field({})], [raw({ evidence: '[Call 2] "I would like level term"' })]);
    expect(a!.source_call_index).toBe(2);
    expect(a!.evidence).toBe('"I would like level term"');
  });

  it('nulls out "no relevant evidence" placeholder text', () => {
    const [a] = sanitizeAnswers([field({})], [raw({ evidence: 'No relevant evidence found' })]);
    expect(a!.evidence).toBeNull();
  });
});
