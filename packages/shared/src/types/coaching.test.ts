import { describe, it, expect } from 'vitest';
import { parseCoaching } from './coaching.js';

const VALID = {
  summary: 'A largely compliant advised sale.',
  strengths: ['Delivered the FCA statements', 'Built rapport'],
  improvements: ['Confirm the document channel'],
  next_actions: ['Review the opening hook'],
};

describe('parseCoaching', () => {
  it('passes a well-formed brief through', () => {
    expect(parseCoaching(VALID)).toEqual(VALID);
  });

  it('returns null for nothing', () => {
    expect(parseCoaching(null)).toBeNull();
    expect(parseCoaching(undefined)).toBeNull();
    expect(parseCoaching('')).toBeNull();
    expect(parseCoaching('   ')).toBeNull();
  });

  it('parses a brief the model serialised as a string', () => {
    expect(parseCoaching(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('parses a doubly-encoded brief', () => {
    expect(parseCoaching(JSON.stringify(JSON.stringify(VALID)))).toEqual(VALID);
  });

  // The production case: a complete object followed by a stray closing brace,
  // which JSON.parse rejects outright. The brief itself is intact, so salvage it.
  it('salvages an object with trailing junk after it', () => {
    expect(parseCoaching(`${JSON.stringify(VALID)}\n}`)).toEqual(VALID);
    expect(parseCoaching(`  ${JSON.stringify(VALID)} trailing nonsense`)).toEqual(VALID);
  });

  it('is not fooled by braces inside strings', () => {
    const withBraces = { ...VALID, summary: 'Adviser said "} not the end {" mid-call.' };
    expect(parseCoaching(`${JSON.stringify(withBraces)}\n}`)).toEqual(withBraces);
  });

  it('rejects a brief missing a required list', () => {
    const { next_actions: _dropped, ...partial } = VALID;
    expect(parseCoaching(partial)).toBeNull();
    expect(parseCoaching(JSON.stringify(partial))).toBeNull();
  });

  it('rejects lists that are not arrays of strings', () => {
    expect(parseCoaching({ ...VALID, strengths: 'one thing' })).toBeNull();
    expect(parseCoaching({ ...VALID, improvements: [{ text: 'nested' }] })).toBeNull();
  });

  it('rejects a non-object shape', () => {
    expect(parseCoaching([VALID])).toBeNull();
    expect(parseCoaching(42)).toBeNull();
    expect(parseCoaching('not json at all')).toBeNull();
  });

  it('drops unexpected extra keys rather than passing them on', () => {
    const parsed = parseCoaching({ ...VALID, injected: 'should not survive' });
    expect(parsed).toEqual(VALID);
    expect(parsed).not.toHaveProperty('injected');
  });
});
