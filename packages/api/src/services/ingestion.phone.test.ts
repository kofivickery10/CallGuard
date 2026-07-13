import { describe, it, expect } from 'vitest';
import { normalizePhone } from './ingestion.js';

// Journey matching keys off normalizePhone: CloudTalk and Zoho must map the
// same customer to the same E.164 value or a sale's journey is never scored.
describe('normalizePhone', () => {
  it('normalises every common UK format to the same value', () => {
    const expected = '+447911123456';
    for (const input of [
      '+44 (0)7911 123456',
      '00447911123456',
      '0044 (0)7911123456',
      '07911 123456',
      '+447911123456',
      '447911123456',
    ]) {
      expect(normalizePhone(input)).toBe(expected);
    }
  });

  it('returns null for empty / non-numeric input', () => {
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('keeps a genuine international number intact', () => {
    expect(normalizePhone('+1 (212) 555-0100')).toBe('+12125550100');
  });

  it('treats a bare 10-digit number as a UK subscriber number', () => {
    expect(normalizePhone('7911123456')).toBe('+447911123456');
  });
});
