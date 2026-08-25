import { describe, it, expect } from 'vitest';
import {
  checkIdentity,
  forenameOf,
  forenamesContradict,
  identityRoleOf,
  type IdentityCheckInput,
} from './reconciliation-identity.js';

const dob = (applicationAnswer: string | null, callAnswer: string | null): IdentityCheckInput => ({
  role: 'dob',
  question: 'Date of birth',
  applicationAnswer,
  callAnswer,
});

const name = (applicationAnswer: string | null, callAnswer: string | null): IdentityCheckInput => ({
  role: 'name',
  question: 'Name',
  applicationAnswer,
  callAnswer,
});

describe('identityRoleOf', () => {
  it('recognises the customer identity questions', () => {
    expect(identityRoleOf('Name')).toBe('name');
    expect(identityRoleOf('Full name')).toBe('name');
    expect(identityRoleOf('Date of birth')).toBe('dob');
    expect(identityRoleOf('DOB')).toBe('dob');
    expect(identityRoleOf('Date of Birth')).toBe('dob');
  });

  // Both contain "name" and neither identifies the customer. Substring matching
  // here would abort runs on a mismatched bank account holder.
  it('does not claim questions that merely contain the word', () => {
    expect(identityRoleOf("Account holder's name")).toBeNull();
    expect(identityRoleOf('Name of the medical condition or illness')).toBeNull();
    expect(identityRoleOf('Please name this condition:')).toBeNull();
    expect(identityRoleOf('When were you diagnosed with diabetes?')).toBeNull();
  });
});

describe('forenameOf', () => {
  it('drops titles', () => {
    expect(forenameOf('Mr Mark Routledge')).toBe('mark');
    expect(forenameOf('Miss Michelle Routledge')).toBe('michelle');
  });

  // A placeholder is the absence of a name. Comparing it against a real
  // forename would contradict on every redacted transcript.
  it('treats redaction placeholders as no name at all', () => {
    expect(forenameOf('[NAME_GIVEN_1]')).toBeNull();
    expect(forenameOf('[NAME_GIVEN_3] [NAME_FAMILY_1]')).toBeNull();
  });

  it('returns null for absent values', () => {
    expect(forenameOf(null)).toBeNull();
    expect(forenameOf('   ')).toBeNull();
  });
});

describe('forenamesContradict', () => {
  it('accepts a diminutive of the same name', () => {
    expect(forenamesContradict('rob', 'robert')).toBe(false);
    expect(forenamesContradict('robert', 'rob')).toBe(false);
  });

  it('contradicts on two different names', () => {
    expect(forenamesContradict('mark', 'michelle')).toBe(true);
  });

  it('never contradicts when either side is missing', () => {
    expect(forenamesContradict('mark', null)).toBe(false);
    expect(forenamesContradict(null, 'michelle')).toBe(false);
  });
});

describe('checkIdentity', () => {
  // The case this exists for: one household member's application against
  // another's call. Ten and a half years apart, and the forenames differ.
  it('aborts when the two dates of birth are years apart', () => {
    const verdict = checkIdentity([
      name('Mr Mark Routledge', 'Michelle'),
      dob('20/10/1962', '04/05/1973'),
    ]);
    expect(verdict.aborts).toBe(true);
    expect(verdict.dobGapDays).toBeGreaterThan(3800);
    expect(verdict.message).toContain('different people');
    expect(verdict.message).toContain('first names do not match');
  });

  // The single most common shape in the tenant. Aborting on it would withhold
  // findings from most sales.
  it('does not abort on a transposed day and month', () => {
    expect(checkIdentity([dob('08/11/1999', '11/08/1999')]).aborts).toBe(false);
    expect(checkIdentity([dob('20/05/1995', '05/20/1995')]).aborts).toBe(false);
    expect(checkIdentity([dob('25/04/2002', '04/25/2002')]).aborts).toBe(false);
  });

  // Real discrepancies, but not evidence of a different person: a mishearing of
  // "ninth" for "nineteenth", and a year out with the day and month intact.
  // Both must stay ordinary findings on their own item.
  it('does not abort on a near miss', () => {
    expect(checkIdentity([dob('09/04/1997', '19/04/1997')]).aborts).toBe(false);
    expect(checkIdentity([dob('20/04/1968', '04/20/1969')]).aborts).toBe(false);
  });

  it('never aborts on absence', () => {
    expect(checkIdentity([dob('20/10/1962', null)]).aborts).toBe(false);
    expect(checkIdentity([dob(null, '04/05/1973')]).aborts).toBe(false);
    expect(checkIdentity([dob('20/10/1962', '')]).aborts).toBe(false);
    expect(checkIdentity([dob('20/10/1962', '[DATE_1]')]).aborts).toBe(false);
  });

  // Names are redacted by design and the call side is occasionally somebody
  // else mentioned in the conversation. Too weak to withhold a sale's findings.
  it('never aborts on a name alone', () => {
    const verdict = checkIdentity([name('Mr Mark Routledge', 'Michelle')]);
    expect(verdict.aborts).toBe(false);
    expect(verdict.message).toBeNull();
  });

  it('passes a run with no identity questions on it', () => {
    expect(checkIdentity([]).aborts).toBe(false);
  });

  it('reports the widest contradiction when a run carries several', () => {
    const verdict = checkIdentity([
      dob('20/10/1962', '04/05/1973'),
      dob('20/10/1962', '19/10/1962'),
    ]);
    expect(verdict.aborts).toBe(true);
    expect(verdict.dobGapDays).toBeGreaterThan(3800);
  });
});
