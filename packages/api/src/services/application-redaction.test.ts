import { describe, it, expect } from 'vitest';
import {
  answerCategoryOf,
  categoryIsReadable,
  maskApplicationAnswer,
  redactionCheckMode,
  scrubEmbeddedPii,
} from './application-redaction.js';

// The first deploying firm's DPIA: phi, numbers and dob permitted for disclosure
// checking, nothing else. Name, email and address are redacted from the call, so
// they cannot be compared and must not be kept on the application side either.
const TRUST_POINT = ['phi', 'numbers', 'dob'];
// A tenant with no exemption at all.
const NOTHING_PERMITTED: string[] = [];

describe('answerCategoryOf', () => {
  it('claims the identity fields', () => {
    expect(answerCategoryOf('Name')).toBe('name');
    expect(answerCategoryOf('Full name')).toBe('name');
    expect(answerCategoryOf("Account holder's name")).toBe('name');
    expect(answerCategoryOf('Email Address')).toBe('email_address');
    expect(answerCategoryOf('Address')).toBe('location_address');
    expect(answerCategoryOf('Postcode')).toBe('location_address');
    expect(answerCategoryOf('Day tel no')).toBe('numbers');
    expect(answerCategoryOf('DOB')).toBe('dob');
    expect(answerCategoryOf('Date of birth')).toBe('dob');
  });

  // The whole point of anchoring. These contain the trigger words and are
  // ordinary reconcilable questions — claiming them would switch off real checks.
  it('does not claim a question that merely contains the word', () => {
    expect(answerCategoryOf('Name of the medical condition or illness')).toBeNull();
    expect(answerCategoryOf('Please name this condition:')).toBeNull();
    expect(answerCategoryOf('What is your job?')).toBeNull();
    expect(answerCategoryOf('Is this address outside of England, Scotland, Wales or Northern Ireland?')).toBeNull();
    expect(answerCategoryOf('How many units of alcohol do you drink in a typical week?')).toBeNull();
  });

  // Deliberately untouched: asked out loud, and it produced a real mismatch on a
  // live sale ("is that in your name?" / "Oh, somebody else, of course").
  it('does not claim the spoken bank-ownership question', () => {
    expect(answerCategoryOf('Bank account held in payers name')).toBeNull();
    expect(answerCategoryOf('Direct Debit allowed from account')).toBeNull();
  });
});

describe('categoryIsReadable', () => {
  it('reads a category the tenant permits', () => {
    expect(categoryIsReadable('numbers', TRUST_POINT)).toBe(true);
    expect(categoryIsReadable('dob', TRUST_POINT)).toBe(true);
  });

  it('refuses a category the tenant redacts', () => {
    expect(categoryIsReadable('name', TRUST_POINT)).toBe(false);
    expect(categoryIsReadable('email_address', TRUST_POINT)).toBe(false);
    expect(categoryIsReadable('location_address', TRUST_POINT)).toBe(false);
  });

  // A name arrives as three Deepgram entities and an address as several. Permit
  // only some and the value does not survive whole, so it still cannot be
  // compared — partial permission must not read as readable.
  it('requires every part of a multi-entity category', () => {
    expect(categoryIsReadable('name', ['name'])).toBe(false);
    expect(categoryIsReadable('name', ['name', 'name_given'])).toBe(false);
    expect(categoryIsReadable('name', ['name', 'name_given', 'name_family'])).toBe(true);
    expect(categoryIsReadable('location_address', ['location_address', 'location_city'])).toBe(false);
  });

  it('refuses everything for a tenant with no exemption', () => {
    for (const c of ['name', 'email_address', 'location_address', 'dob', 'numbers'] as const) {
      expect(categoryIsReadable(c, NOTHING_PERMITTED)).toBe(false);
    }
  });
});

describe('redactionCheckMode', () => {
  // Address resolved 2 of 22 and Email Address 0 of 5, every unresolved one with
  // its call value redacted by design. They are presence checks, not comparisons.
  it('makes a redacted-category question a presence check', () => {
    expect(redactionCheckMode('Address', TRUST_POINT)).toBe('presence');
    expect(redactionCheckMode('Email Address', TRUST_POINT)).toBe('presence');
    expect(redactionCheckMode("Account holder's name", TRUST_POINT)).toBe('presence');
  });

  // Where the tenant CAN read the value, redaction has no opinion and the
  // ordinary default applies — date of birth reconciles fine here, and its
  // failures are a date-format problem, not a redaction one.
  it('stays silent where the tenant permits the category', () => {
    expect(redactionCheckMode('Date of birth', TRUST_POINT)).toBeNull();
    expect(redactionCheckMode('Day tel no', TRUST_POINT)).toBeNull();
  });

  it('stays silent on a question that is not a PII field', () => {
    expect(redactionCheckMode('Have you ever had any of these?', TRUST_POINT)).toBeNull();
  });

  it('turns date of birth into a presence check for a tenant without the dob exemption', () => {
    expect(redactionCheckMode('Date of birth', NOTHING_PERMITTED)).toBe('presence');
  });
});

describe('maskApplicationAnswer', () => {
  it('masks a value the tenant redacts, keeping the type', () => {
    expect(
      maskApplicationAnswer('Address', '14 Templars Way Grantham Lincolnshire NG33 5PS', TRUST_POINT)
    ).toBe('[LOCATION_ADDRESS]');
    expect(maskApplicationAnswer('Name', 'Mr Mark Routledge', TRUST_POINT)).toBe('[NAME]');
    expect(maskApplicationAnswer('Email Address', 'someone@example.com', TRUST_POINT)).toBe(
      '[EMAIL_ADDRESS]'
    );
  });

  it('keeps a value the tenant permits', () => {
    expect(maskApplicationAnswer('Date of birth', '20/10/1962', TRUST_POINT)).toBe('20/10/1962');
    expect(maskApplicationAnswer('Day tel no', '07700900123', TRUST_POINT)).toBe('07700900123');
  });

  it('leaves non-PII answers alone', () => {
    expect(maskApplicationAnswer('What is your job?', 'HGV Driver', TRUST_POINT)).toBe('HGV Driver');
    expect(maskApplicationAnswer('How tall are you?', '1.83', TRUST_POINT)).toBe('1.83');
  });

  // A blank stays blank and distinguishable: masking an empty answer would
  // manufacture a value the form never carried, turning "left blank" — which is
  // a finding under presence mode — into "we are not keeping this".
  it('does not mask a blank', () => {
    expect(maskApplicationAnswer('Address', null, TRUST_POINT)).toBeNull();
    expect(maskApplicationAnswer('Address', '', TRUST_POINT)).toBe('');
    expect(maskApplicationAnswer('Address', '   ', TRUST_POINT)).toBe('   ');
  });
});

describe('scrubEmbeddedPii — a permitted field carrying a forbidden value', () => {
  // Observed on a MetLife summary sheet: the parser merged two adjacent fields,
  // so "Day tel no" arrived holding the customer's email as well. 'numbers' is
  // permitted here and 'email_address' is not, so a check on the field's own
  // category keeps the lot.
  it('strips an email out of a permitted phone field', () => {
    expect(
      maskApplicationAnswer('Day tel no', 'someone@example.com 07700900123', TRUST_POINT)
    ).toBe('[EMAIL_ADDRESS] 07700900123');
  });

  it('strips a full UK postcode out of a free-text answer', () => {
    expect(scrubEmbeddedPii('Moved from NG33 5PS last year', TRUST_POINT)).toBe(
      'Moved from [LOCATION_ZIP] last year'
    );
  });

  it('leaves a value alone when the tenant permits that category', () => {
    const permitsEmail = [...TRUST_POINT, 'email_address'];
    expect(scrubEmbeddedPii('someone@example.com', permitsEmail)).toBe('someone@example.com');
  });

  // Product and policy references share the outward-code shape. Scrubbing those
  // would damage values that compare perfectly well.
  it('does not touch an outward-code-only string', () => {
    expect(scrubEmbeddedPii('Plan M32 variant', TRUST_POINT)).toBe('Plan M32 variant');
    expect(scrubEmbeddedPii('Unit 3', TRUST_POINT)).toBe('Unit 3');
  });

  it('is idempotent — an already-scrubbed value is unchanged', () => {
    const once = scrubEmbeddedPii('a@b.com and NG33 5PS', TRUST_POINT);
    expect(scrubEmbeddedPii(once, TRUST_POINT)).toBe(once);
  });
});
