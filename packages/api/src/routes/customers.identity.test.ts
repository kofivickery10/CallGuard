import { describe, it, expect } from 'vitest';
import { validateLinkRequest } from './customers.js';

// Linking two customer numbers as one person (CG-8, migration 114).
//
// `customers` is keyed per phone NUMBER, so a customer who rings from a second
// number is a second row and their calls can never join the sale — the gap
// behind Trust Point's Lee Kidd case, where "lots of the calls are missing".
//
// That makes this a write with unusual reach: it changes which calls a
// compliance score is computed from, so it can move a score, add breaches or
// remove them, on a sale nobody has otherwise touched. These are the rules that
// stop it happening casually.

const SELF = '00000000-0000-0000-0000-0000000000c1';
const OTHER = '00000000-0000-0000-0000-0000000000c2';

describe('validateLinkRequest', () => {
  it('accepts a well-formed request', () => {
    expect(validateLinkRequest(SELF, { customer_id: OTHER, reason: 'Same person, confirmed' })).toEqual({
      customerId: OTHER,
      reason: 'Same person, confirmed',
    });
  });

  it('trims the reason', () => {
    expect(
      validateLinkRequest(SELF, { customer_id: OTHER, reason: '  Confirmed by Joey  ' }).reason
    ).toBe('Confirmed by Joey');
  });

  it('requires a customer_id', () => {
    expect(() => validateLinkRequest(SELF, { reason: 'Same person' })).toThrow('customer_id is required');
  });

  it('requires a string customer_id, not just a truthy one', () => {
    expect(() => validateLinkRequest(SELF, { customer_id: 42, reason: 'Same person' })).toThrow(
      'customer_id is required'
    );
  });

  // The reason IS the audit trail. A link with no stated basis leaves a score
  // that moved with nothing explaining why.
  it('requires a reason', () => {
    expect(() => validateLinkRequest(SELF, { customer_id: OTHER })).toThrow('reason is required');
  });

  it('rejects a whitespace-only reason rather than storing it', () => {
    expect(() => validateLinkRequest(SELF, { customer_id: OTHER, reason: '   \n ' })).toThrow(
      'reason is required'
    );
  });

  it('rejects a non-string reason', () => {
    expect(() => validateLinkRequest(SELF, { customer_id: OTHER, reason: true })).toThrow(
      'reason is required'
    );
  });

  // A group of one, and an event row asserting a link that says nothing —
  // noise in the one record that has to stay readable.
  it('rejects linking a customer to themselves', () => {
    expect(() => validateLinkRequest(SELF, { customer_id: SELF, reason: 'Same person' })).toThrow(
      'themselves'
    );
  });

  it('rejects an empty body outright', () => {
    expect(() => validateLinkRequest(SELF, {})).toThrow();
  });
});
