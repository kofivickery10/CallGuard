import { describe, it, expect } from 'vitest';
import {
  stripPostcodeSuffix,
  isLikelyCompanyName,
  permissionsDictToArray,
  joinAddressLines,
  pickFcaStatus,
  parseSimpleCsv,
  normalizeInputRows,
  classifyPositionalArg,
  parseArgs,
  checkFcaCredentials,
  isDeadStatus,
  isIntroducerStatus,
  isExcludedStatus,
  isKnownGoodStatus,
  toDiscoveryCandidates,
  dedupeByFrn,
  decideLimitAction,
  parseDiscoverArgs,
  type FcaSearchResultItem,
} from './enrich-prospects-fca.js';

describe('stripPostcodeSuffix', () => {
  it('strips the trailing "(Postcode: ...)" the Register appends to Search results', () => {
    expect(stripPostcodeSuffix('Clever Financial Solutions Limited (Postcode: SG14 1AJ)')).toBe(
      'Clever Financial Solutions Limited'
    );
  });

  it('strips a "(Postcode: N/A)" suffix the same way', () => {
    expect(stripPostcodeSuffix('Barclays Wealth Management (Postcode: N/A)')).toBe('Barclays Wealth Management');
  });

  it('leaves a name with no postcode suffix untouched', () => {
    expect(stripPostcodeSuffix('Barclays Bank Plc')).toBe('Barclays Bank Plc');
  });

  it('is case-insensitive on the "Postcode:" marker', () => {
    expect(stripPostcodeSuffix('Acme Ltd (postcode: AB1 2CD)')).toBe('Acme Ltd');
  });
});

describe('isLikelyCompanyName', () => {
  it('treats a name with a corporate suffix as a company', () => {
    expect(isLikelyCompanyName('Clever Financial Solutions Limited')).toBe(true);
    expect(isLikelyCompanyName('Ashbury Lloyd Group Ltd')).toBe(true);
    expect(isLikelyCompanyName('Trusted Mortgage Advice Ltd')).toBe(true);
  });

  it('treats a bare personal name as an individual', () => {
    expect(isLikelyCompanyName('Anna Woodvine')).toBe(false);
    expect(isLikelyCompanyName('Craig Taylor')).toBe(false);
  });

  it('treats "&" as a corporate marker', () => {
    expect(isLikelyCompanyName('Smith & Jones')).toBe(true);
  });

  it('is case-insensitive and matches whole words only', () => {
    expect(isLikelyCompanyName('acme FINANCIAL services')).toBe(true);
    // "captain" contains "capital"-ish substring risk if this weren't a
    // whole-word match — make sure a marker word only matches as a word.
    expect(isLikelyCompanyName('Captain Jones')).toBe(false);
  });
});

describe('permissionsDictToArray', () => {
  it('turns the Permissions dict into its key list', () => {
    const data = {
      'Credit Broking': [{ some: 'limitation' }],
      'Making arrangements with a view to regulated mortgage contracts': [],
      'Debt Adjusting': [{}],
    };
    expect(permissionsDictToArray(data)).toEqual([
      'Credit Broking',
      'Making arrangements with a view to regulated mortgage contracts',
      'Debt Adjusting',
    ]);
  });

  it('returns an empty array for null/undefined/non-object input', () => {
    expect(permissionsDictToArray(null)).toEqual([]);
    expect(permissionsDictToArray(undefined)).toEqual([]);
  });
});

describe('joinAddressLines', () => {
  it('joins address fields including the "Address LIne 3" typo key', () => {
    const addr = {
      'Address Line 1': '1 Churchill Place',
      'Address Line 2': '',
      'Address LIne 3': 'Canary Wharf',
      'Address Line 4': '',
      Town: 'London',
      County: '',
      Postcode: 'E14 5HP',
      Country: 'UNITED KINGDOM',
    };
    expect(joinAddressLines(addr)).toBe('1 Churchill Place, Canary Wharf, London, E14 5HP, UNITED KINGDOM');
  });

  it('also accepts the correctly-spelled "Address Line 3" key', () => {
    const addr = {
      'Address Line 1': '1 Churchill Place',
      'Address Line 3': 'Canary Wharf',
      Town: 'London',
    };
    expect(joinAddressLines(addr)).toBe('1 Churchill Place, Canary Wharf, London');
  });

  it('returns null when there is no address data', () => {
    expect(joinAddressLines(null)).toBeNull();
    expect(joinAddressLines(undefined)).toBeNull();
  });

  it('drops blank fields and returns null if every field is blank', () => {
    expect(joinAddressLines({ 'Address Line 1': '', Town: '' })).toBeNull();
  });
});

describe('pickFcaStatus', () => {
  it('prefers the Firm status when it is not the placeholder', () => {
    expect(pickFcaStatus('Authorised', 'Registered')).toBe('Registered');
  });

  it('falls back to the Search status when Firm status is the "See full details" placeholder', () => {
    expect(pickFcaStatus('Authorised', 'See full details')).toBe('Authorised');
  });

  it('stores the placeholder when nothing better is available', () => {
    expect(pickFcaStatus(null, 'See full details')).toBe('See full details');
  });

  it('returns null when neither status is available', () => {
    expect(pickFcaStatus(null, null)).toBeNull();
  });
});

describe('parseSimpleCsv', () => {
  it('parses a plain comma-separated file into rows', () => {
    expect(parseSimpleCsv('name,frn\nAcme Ltd,12345\n')).toEqual([
      ['name', 'frn'],
      ['Acme Ltd', '12345'],
    ]);
  });

  it('handles quoted fields containing commas', () => {
    expect(parseSimpleCsv('name\n"Smith, Jones & Co"\n')).toEqual([['name'], ['Smith, Jones & Co']]);
  });
});

describe('normalizeInputRows', () => {
  it('treats a single unlabelled column of names as one entry per row', () => {
    expect(normalizeInputRows([['Acme Financial Ltd'], ['Beta Mortgages Ltd']])).toEqual([
      { name: 'Acme Financial Ltd', frn: null },
      { name: 'Beta Mortgages Ltd', frn: null },
    ]);
  });

  it('treats a purely numeric single-column value as an FRN', () => {
    expect(normalizeInputRows([['122702']])).toEqual([{ name: null, frn: '122702' }]);
  });

  it('skips a header row of "name"', () => {
    expect(normalizeInputRows([['name'], ['Acme Ltd']])).toEqual([{ name: 'Acme Ltd', frn: null }]);
  });

  it('handles a name,frn header shape', () => {
    expect(normalizeInputRows([['name', 'frn'], ['Acme Ltd', '12345'], ['Beta Ltd', '']])).toEqual([
      { name: 'Acme Ltd', frn: '12345' },
      { name: 'Beta Ltd', frn: null },
    ]);
  });

  it('handles a headerless name,frn shape', () => {
    expect(normalizeInputRows([['Acme Ltd', '12345']])).toEqual([{ name: 'Acme Ltd', frn: '12345' }]);
  });

  it('drops fully blank rows', () => {
    expect(normalizeInputRows([['name'], ['Acme Ltd'], ['', '']])).toEqual([{ name: 'Acme Ltd', frn: null }]);
  });
});

describe('classifyPositionalArg', () => {
  it('treats a numeric argument as an FRN', () => {
    expect(classifyPositionalArg('122702')).toEqual({ name: null, frn: '122702' });
  });

  it('treats a non-numeric argument as a name', () => {
    expect(classifyPositionalArg('Clever Financial Solutions')).toEqual({
      name: 'Clever Financial Solutions',
      frn: null,
    });
  });
});

describe('parseArgs', () => {
  it('separates --file, --yes, --dry-run from positional args', () => {
    expect(parseArgs(['--file', 'prospects.csv', 'Acme Ltd', '--yes', '122702'])).toEqual({
      file: 'prospects.csv',
      yes: true,
      dryRun: false,
      positional: ['Acme Ltd', '122702'],
    });
  });

  it('recognises --dry-run', () => {
    expect(parseArgs(['--dry-run', 'Acme Ltd'])).toEqual({
      file: null,
      yes: false,
      dryRun: true,
      positional: ['Acme Ltd'],
    });
  });

  it('defaults to no file and no positional args', () => {
    expect(parseArgs([])).toEqual({ file: null, yes: false, dryRun: false, positional: [] });
  });
});

describe('checkFcaCredentials', () => {
  it('names both env vars when neither is set', () => {
    const result = checkFcaCredentials({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('FCA_API_EMAIL');
      expect(result.message).toContain('FCA_API_KEY');
      expect(result.message).toContain('.env.example');
    }
  });

  it('fails when only the email is set', () => {
    expect(checkFcaCredentials({ FCA_API_EMAIL: 'hello@callguardai.co.uk' }).ok).toBe(false);
  });

  it('fails when only the key is set', () => {
    expect(checkFcaCredentials({ FCA_API_KEY: 'abc123' }).ok).toBe(false);
  });

  it('succeeds and returns both values when both are set', () => {
    const result = checkFcaCredentials({ FCA_API_EMAIL: 'hello@callguardai.co.uk', FCA_API_KEY: 'abc123' });
    expect(result).toEqual({ ok: true, email: 'hello@callguardai.co.uk', key: 'abc123' });
  });
});

describe('isDeadStatus', () => {
  it('excludes each of the given dead-firm keywords, case-insensitively', () => {
    expect(isDeadStatus('No longer registered as an Appointed Representative')).toBe(true);
    expect(isDeadStatus('DEREGISTERED')).toBe(true);
    expect(isDeadStatus('Cancelled')).toBe(true);
    expect(isDeadStatus('Expired')).toBe(true);
    expect(isDeadStatus('Dissolved')).toBe(true);
    expect(isDeadStatus('no longer authorised')).toBe(true);
  });

  it('does not treat an active status as dead', () => {
    expect(isDeadStatus('Authorised')).toBe(false);
    expect(isDeadStatus('Appointed representative')).toBe(false);
  });

  it('excludes "Revoked" — FCA-revoked permission, caught live via the unrecognised-statuses safety net', () => {
    expect(isDeadStatus('Revoked')).toBe(true);
    expect(isDeadStatus('REVOKED')).toBe(true);
  });

  it('excludes "Lapsed" — authorisation lapsed, same live-caught safety-net addition', () => {
    expect(isDeadStatus('Lapsed')).toBe(true);
    expect(isDeadStatus('lapsed')).toBe(true);
  });

  it('excludes "Applied to Cancel" via its own dedicated keyword', () => {
    expect(isDeadStatus('Applied to Cancel')).toBe(true);
  });

  it('regression: "applied to cancel" is caught by its own keyword, not by an accidental match against "cancelled" — the two strings do not overlap', () => {
    // Guards the distinction the coordinator called out explicitly: "Applied
    // to Cancel" must not rely on (and does not satisfy) the "cancelled"
    // substring check above — it needs its own keyword.
    expect('applied to cancel'.includes('cancelled')).toBe(false);
    expect(isDeadStatus('Applied to Cancel')).toBe(true);
  });

  it('confirms "No longer authorised" is already excluded by the "no longer" keyword, rather than assuming it', () => {
    expect(isDeadStatus('No longer authorised')).toBe(true);
  });

  it('excludes "Registered" (CBTL — a registration regime, not an FSMA authorisation, so there is no regulated advice call to score)', () => {
    expect(isDeadStatus('Registered')).toBe(true);
    expect(isDeadStatus('REGISTERED')).toBe(true);
    expect(isDeadStatus('  registered  ')).toBe(true);
  });

  it('does not exclude a status that merely contains "registered" as a substring — "Registered" is matched exactly, not as a keyword', () => {
    // "No longer registered as an Appointed Representative" must already be
    // excluded via the "no longer" keyword, not by a "registered" substring
    // rule that would work by luck rather than by design.
    expect(isDeadStatus('No longer registered as an Appointed Representative')).toBe(true);
  });

  it('excludes "Unauthorised" exactly', () => {
    expect(isDeadStatus('Unauthorised')).toBe(true);
    expect(isDeadStatus('UNAUTHORISED')).toBe(true);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isDeadStatus(null)).toBe(false);
    expect(isDeadStatus(undefined)).toBe(false);
    expect(isDeadStatus('')).toBe(false);
  });
});

describe('isIntroducerStatus', () => {
  it('excludes the introducer-only Appointed Representative status', () => {
    expect(isIntroducerStatus('Appointed representative - introducer')).toBe(true);
    expect(isIntroducerStatus('INTRODUCER')).toBe(true);
  });

  it('does not treat an ordinary Appointed Representative as an introducer', () => {
    expect(isIntroducerStatus('Appointed representative')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isIntroducerStatus(null)).toBe(false);
    expect(isIntroducerStatus(undefined)).toBe(false);
    expect(isIntroducerStatus('')).toBe(false);
  });
});

describe('isExcludedStatus', () => {
  it('is true for any dead-firm or introducer status', () => {
    expect(isExcludedStatus('No longer authorised')).toBe(true);
    expect(isExcludedStatus('Appointed representative - introducer')).toBe(true);
    expect(isExcludedStatus('Revoked')).toBe(true);
    expect(isExcludedStatus('Lapsed')).toBe(true);
    expect(isExcludedStatus('Applied to Cancel')).toBe(true);
    expect(isExcludedStatus('Registered')).toBe(true);
    expect(isExcludedStatus('Unauthorised')).toBe(true);
  });

  it('is false for an active, non-introducer status', () => {
    expect(isExcludedStatus('Authorised')).toBe(false);
    expect(isExcludedStatus('Appointed representative')).toBe(false);
  });
});

describe('isKnownGoodStatus', () => {
  it('recognises the two exact Register values named in the brief', () => {
    expect(isKnownGoodStatus('Authorised')).toBe(true);
    expect(isKnownGoodStatus('Appointed representative')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKnownGoodStatus('authorised')).toBe(true);
    expect(isKnownGoodStatus('APPOINTED REPRESENTATIVE')).toBe(true);
  });

  it('treats an "authorised" variant not explicitly named as known-good (e.g. "EEA Authorised")', () => {
    expect(isKnownGoodStatus('EEA Authorised')).toBe(true);
  });

  it('is false for a status that is neither a dead-firm keyword nor an authorised variant', () => {
    // isKnownGoodStatus is exclusion-agnostic by design (it doesn't consult
    // isDeadStatus/isIntroducerStatus) — "Revoked"/"Lapsed"/"Applied to
    // Cancel" are now caught upstream by isDeadStatus before this function
    // is ever reached in the real pipeline, so a status that is genuinely
    // unrecognised-and-not-dead is used here instead.
    expect(isKnownGoodStatus('Suspended')).toBe(false);
    expect(isKnownGoodStatus('Under review')).toBe(false);
  });

  it('regression: "Unauthorised" is NOT treated as known-good, despite containing the substring "authorised"', () => {
    // The matching hazard called out explicitly: a plain
    // .includes('authorised') test would misclassify "Unauthorised" — the
    // opposite of an active status — as known-good, because the substring
    // is there. isKnownGoodStatus uses a whole-word match instead, which
    // "Unauthorised" fails (no word boundary between "un" and "authorised"),
    // so this must stay false on its own, independent of isDeadStatus.
    expect('unauthorised'.includes('authorised')).toBe(true); // the hazard is real
    expect(isKnownGoodStatus('Unauthorised')).toBe(false);
    expect(isKnownGoodStatus('UNAUTHORISED')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isKnownGoodStatus(null)).toBe(false);
    expect(isKnownGoodStatus(undefined)).toBe(false);
    expect(isKnownGoodStatus('')).toBe(false);
  });
});

function searchResult(frn: string, name: string, status: string): FcaSearchResultItem {
  return { 'Reference Number': frn, Name: name, Status: status, 'Type of business or Individual': 'Firm', URL: null };
}

describe('toDiscoveryCandidates', () => {
  it('strips the postcode suffix and carries FRN/status through', () => {
    expect(toDiscoveryCandidates([searchResult('123', 'Acme Ltd (Postcode: AB1 2CD)', 'Authorised')])).toEqual([
      { frn: '123', name: 'Acme Ltd', status: 'Authorised' },
    ]);
  });

  it('drops entries with a blank Reference Number (unauthorised clone/warning entries)', () => {
    expect(toDiscoveryCandidates([searchResult('', 'Clone of Acme Ltd', 'Unauthorised')])).toEqual([]);
  });
});

describe('dedupeByFrn', () => {
  it('keeps the first occurrence of an FRN and drops later duplicates', () => {
    const seen = new Set<string>();
    const first = dedupeByFrn(
      [
        { frn: '1', name: 'Acme Ltd', status: 'Authorised' },
        { frn: '2', name: 'Beta Ltd', status: 'Authorised' },
      ],
      seen
    );
    expect(first).toHaveLength(2);

    // A later term re-surfaces FRN "1" — it should be dropped this time.
    const second = dedupeByFrn(
      [
        { frn: '1', name: 'Acme Ltd', status: 'Authorised' },
        { frn: '3', name: 'Gamma Ltd', status: 'Authorised' },
      ],
      seen
    );
    expect(second).toEqual([{ frn: '3', name: 'Gamma Ltd', status: 'Authorised' }]);
  });

  it('dedupes within a single call too', () => {
    const seen = new Set<string>();
    const out = dedupeByFrn(
      [
        { frn: '1', name: 'Acme Ltd', status: 'Authorised' },
        { frn: '1', name: 'Acme Ltd', status: 'Authorised' },
      ],
      seen
    );
    expect(out).toEqual([{ frn: '1', name: 'Acme Ltd', status: 'Authorised' }]);
  });
});

describe('decideLimitAction', () => {
  it('always processes an already-known firm, regardless of the running new-firm count', () => {
    expect(decideLimitAction(true, 0, 5)).toBe('process-existing');
    expect(decideLimitAction(true, 100, 5)).toBe('process-existing');
  });

  it('processes a new firm while under the limit', () => {
    expect(decideLimitAction(false, 0, 5)).toBe('process-new');
    expect(decideLimitAction(false, 4, 5)).toBe('process-new');
  });

  it('skips a new firm once the limit has been reached', () => {
    expect(decideLimitAction(false, 5, 5)).toBe('skip-limit');
    expect(decideLimitAction(false, 6, 5)).toBe('skip-limit');
  });
});

describe('parseDiscoverArgs', () => {
  it('separates terms, --terms-file, --limit, --yes and --dry-run', () => {
    expect(parseDiscoverArgs(['--discover', 'mortgage', 'protection', '--limit', '100', '--yes'])).toEqual({
      terms: ['mortgage', 'protection'],
      termsFile: null,
      limit: 100,
      yes: true,
      dryRun: false,
    });
  });

  it('reads --terms-file', () => {
    expect(parseDiscoverArgs(['--discover', '--terms-file', 'terms.txt', '--dry-run'])).toEqual({
      terms: [],
      termsFile: 'terms.txt',
      limit: 250,
      yes: false,
      dryRun: true,
    });
  });

  it('defaults --limit to 250 when not given', () => {
    expect(parseDiscoverArgs(['--discover', 'mortgage']).limit).toBe(250);
  });

  it('ignores a non-numeric or non-positive --limit and keeps the default', () => {
    expect(parseDiscoverArgs(['--discover', '--limit', 'abc']).limit).toBe(250);
    expect(parseDiscoverArgs(['--discover', '--limit', '0']).limit).toBe(250);
    expect(parseDiscoverArgs(['--discover', '--limit', '-5']).limit).toBe(250);
  });
});
