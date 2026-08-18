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
  parseFcaDate,
  normalizeFirmName,
  isLapsedArStatus,
  isConfirmedAuthorisedStatus,
  findPlausibleLapsedArMatches,
  decideTransitionMatch,
  isPersistableTransitionMatch,
  isAuthorisedWithinMonths,
  qualifiesForTransitionsOnly,
  compareTransitionRank,
  diffFields,
  isEligibleForPrefixMatch,
  findMatchingExistingClient,
  formatStatusEffectiveDateLabel,
  type FcaSearchResultItem,
  type LapsedArCandidate,
  type ExistingProspectRow,
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
      includeClients: false,
      positional: ['Acme Ltd', '122702'],
    });
  });

  it('recognises --dry-run', () => {
    expect(parseArgs(['--dry-run', 'Acme Ltd'])).toEqual({
      file: null,
      yes: false,
      dryRun: true,
      includeClients: false,
      positional: ['Acme Ltd'],
    });
  });

  it('defaults to no file and no positional args', () => {
    expect(parseArgs([])).toEqual({ file: null, yes: false, dryRun: false, includeClients: false, positional: [] });
  });

  it('recognises --include-clients', () => {
    expect(parseArgs(['--include-clients', 'Acme Ltd']).includeClients).toBe(true);
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

  it('excludes "Contractual run-off" and "Supervised run-off" — a firm running its existing book to expiry has no new advice call to score', () => {
    expect(isDeadStatus('Contractual run-off')).toBe(true);
    expect(isDeadStatus('Supervised run-off')).toBe(true);
    expect(isDeadStatus('CONTRACTUAL RUN-OFF')).toBe(true);
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
    expect(isExcludedStatus('Contractual run-off')).toBe(true);
    expect(isExcludedStatus('Supervised run-off')).toBe(true);
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
      transitionsOnly: false,
      authorisedWithinMonths: 24,
      includeClients: false,
      verbose: false,
    });
  });

  it('reads --terms-file', () => {
    expect(parseDiscoverArgs(['--discover', '--terms-file', 'terms.txt', '--dry-run'])).toEqual({
      terms: [],
      termsFile: 'terms.txt',
      limit: 250,
      yes: false,
      dryRun: true,
      transitionsOnly: false,
      authorisedWithinMonths: 24,
      includeClients: false,
      verbose: false,
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

  it('reads --transitions-only and --authorised-within-months', () => {
    expect(
      parseDiscoverArgs(['--discover', 'mortgage', '--transitions-only', '--authorised-within-months', '12'])
    ).toEqual({
      terms: ['mortgage'],
      termsFile: null,
      limit: 250,
      yes: false,
      dryRun: false,
      transitionsOnly: true,
      authorisedWithinMonths: 12,
      includeClients: false,
      verbose: false,
    });
  });

  it('defaults transitionsOnly to false and authorisedWithinMonths to 24 when not given', () => {
    const args = parseDiscoverArgs(['--discover', 'mortgage']);
    expect(args.transitionsOnly).toBe(false);
    expect(args.authorisedWithinMonths).toBe(24);
  });

  it('ignores a non-numeric or non-positive --authorised-within-months and keeps the default', () => {
    expect(parseDiscoverArgs(['--discover', '--authorised-within-months', 'abc']).authorisedWithinMonths).toBe(24);
    expect(parseDiscoverArgs(['--discover', '--authorised-within-months', '0']).authorisedWithinMonths).toBe(24);
    expect(parseDiscoverArgs(['--discover', '--authorised-within-months', '-3']).authorisedWithinMonths).toBe(24);
  });

  it('reads --include-clients and --verbose', () => {
    const args = parseDiscoverArgs(['--discover', 'mortgage', '--include-clients', '--verbose']);
    expect(args.includeClients).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it('defaults --include-clients and --verbose to false when not given', () => {
    const args = parseDiscoverArgs(['--discover', 'mortgage']);
    expect(args.includeClients).toBe(false);
    expect(args.verbose).toBe(false);
  });
});

describe('parseFcaDate', () => {
  it('parses the Register\'s dd/mm/yyyy format to ISO yyyy-mm-dd — 18/12/2025 is 18 December, not 12 June or any mm/dd reading', () => {
    expect(parseFcaDate('18/12/2025')).toBe('2025-12-18');
  });

  it('parses the Trust Point acceptance-test dates', () => {
    expect(parseFcaDate('29/11/2024')).toBe('2024-11-29');
    expect(parseFcaDate('18/12/2025')).toBe('2025-12-18');
  });

  it('parses a date with single-digit day/month', () => {
    expect(parseFcaDate('3/4/2025')).toBe('2025-04-03');
  });

  it('returns null for an empty or blank value', () => {
    expect(parseFcaDate('')).toBeNull();
    expect(parseFcaDate('   ')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseFcaDate(null)).toBeNull();
    expect(parseFcaDate(undefined)).toBeNull();
  });

  it('returns null for an ISO-formatted value rather than misreading it', () => {
    expect(parseFcaDate('2025-12-18')).toBeNull();
  });

  it('returns null for a calendar-invalid date rather than rolling it over into the next month', () => {
    expect(parseFcaDate('31/04/2025')).toBeNull(); // April has 30 days
    expect(parseFcaDate('29/02/2025')).toBeNull(); // 2025 is not a leap year
  });

  it('returns null for garbage input rather than throwing', () => {
    expect(parseFcaDate('not a date')).toBeNull();
    expect(parseFcaDate('00/00/0000')).toBeNull();
  });
});

describe('normalizeFirmName', () => {
  it('folds case and strips legal-suffix noise', () => {
    expect(normalizeFirmName('TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED')).toBe(
      normalizeFirmName('Trust Point Mortgage and Protection Services Ltd')
    );
  });

  it('treats "&" the same as "and"', () => {
    expect(normalizeFirmName('Smith & Jones Ltd')).toBe(normalizeFirmName('Smith and Jones Limited'));
  });

  it('strips punctuation noise', () => {
    expect(normalizeFirmName("Acme, Financial Services Ltd.")).toBe(normalizeFirmName('Acme Financial Services Ltd'));
  });

  it('produces the same value for the two Trust Point Register records', () => {
    expect(normalizeFirmName('TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED')).toBe(
      normalizeFirmName('TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED')
    );
  });
});

describe('isLapsedArStatus', () => {
  it('recognises the lapsed-AR status', () => {
    expect(isLapsedArStatus('No longer registered as an Appointed Representative')).toBe(true);
  });

  it('does not treat an unrelated lapse as a lapsed-AR status', () => {
    expect(isLapsedArStatus('No longer authorised')).toBe(false);
  });

  it('does not treat a live AR as lapsed', () => {
    expect(isLapsedArStatus('Appointed representative')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isLapsedArStatus(null)).toBe(false);
    expect(isLapsedArStatus(undefined)).toBe(false);
    expect(isLapsedArStatus('')).toBe(false);
  });
});

describe('isConfirmedAuthorisedStatus', () => {
  it('is true only for the exact "Authorised" status, case-insensitively', () => {
    expect(isConfirmedAuthorisedStatus('Authorised')).toBe(true);
    expect(isConfirmedAuthorisedStatus('authorised')).toBe(true);
    expect(isConfirmedAuthorisedStatus('  Authorised  ')).toBe(true);
  });

  it('is false for a broader authorised-adjacent variant', () => {
    expect(isConfirmedAuthorisedStatus('EEA Authorised')).toBe(false);
  });

  it('is false for an Appointed Representative', () => {
    expect(isConfirmedAuthorisedStatus('Appointed representative')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isConfirmedAuthorisedStatus(null)).toBe(false);
    expect(isConfirmedAuthorisedStatus(undefined)).toBe(false);
    expect(isConfirmedAuthorisedStatus('')).toBe(false);
  });
});

describe('findPlausibleLapsedArMatches', () => {
  const lapsed: LapsedArCandidate[] = [
    { frn: '1021037', name: 'TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED', status: 'No longer registered as an Appointed Representative' },
    { frn: '999999', name: 'Some Unrelated Firm Ltd', status: 'No longer registered as an Appointed Representative' },
  ];

  it('matches on normalised name across case/punctuation/suffix differences', () => {
    expect(findPlausibleLapsedArMatches('Trust Point Mortgage and Protection Services Ltd', lapsed)).toEqual([
      lapsed[0],
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(findPlausibleLapsedArMatches('Totally Different Firm Ltd', lapsed)).toEqual([]);
  });

  it('returns an empty array for a blank firm name', () => {
    expect(findPlausibleLapsedArMatches('', lapsed)).toEqual([]);
  });
});

describe('decideTransitionMatch', () => {
  it('confirms the match when both Companies House numbers are known and equal', () => {
    expect(decideTransitionMatch('15993274', '15993274')).toBe('ch_number');
  });

  it('vetoes the match when both Companies House numbers are known and differ — false former_ar is worse than a missed one', () => {
    expect(decideTransitionMatch('15993274', '00000001')).toBe('none');
  });

  it('falls back to the name match when the current CH number is unknown', () => {
    expect(decideTransitionMatch(null, '15993274')).toBe('name');
  });

  it('falls back to the name match when the lapsed CH number is unknown', () => {
    expect(decideTransitionMatch('15993274', null)).toBe('name');
  });

  it('falls back to the name match when neither CH number is known', () => {
    expect(decideTransitionMatch(null, null)).toBe('name');
  });
});

describe('isPersistableTransitionMatch', () => {
  it('is true only for a confirmed Companies House number match', () => {
    expect(isPersistableTransitionMatch('ch_number')).toBe(true);
  });

  it('is false for a name-only match — never persisted on name alone', () => {
    expect(isPersistableTransitionMatch('name')).toBe(false);
  });

  it('is false for a vetoed match', () => {
    expect(isPersistableTransitionMatch('none')).toBe(false);
  });
});

describe('isAuthorisedWithinMonths', () => {
  const now = new Date('2026-08-17T00:00:00Z');

  it('is true for a date within the window', () => {
    expect(isAuthorisedWithinMonths('2025-12-18', 24, now)).toBe(true);
  });

  it('is true exactly at the window boundary', () => {
    expect(isAuthorisedWithinMonths('2024-08-17', 24, now)).toBe(true);
  });

  it('is false for a date outside the window', () => {
    expect(isAuthorisedWithinMonths('2020-01-01', 24, now)).toBe(false);
  });

  it('is false when there is no date', () => {
    expect(isAuthorisedWithinMonths(null, 24, now)).toBe(false);
  });
});

describe('qualifiesForTransitionsOnly', () => {
  const now = new Date('2026-08-17T00:00:00Z');

  it('qualifies a confirmed former AR regardless of how long ago it was authorised', () => {
    expect(qualifiesForTransitionsOnly('Authorised', true, '2015-01-01', 24, now)).toBe(true);
  });

  it('qualifies a recent authorisation with no former-AR evidence', () => {
    expect(qualifiesForTransitionsOnly('Authorised', false, '2025-12-18', 24, now)).toBe(true);
  });

  it('does not qualify an old authorisation with no former-AR evidence', () => {
    expect(qualifiesForTransitionsOnly('Authorised', false, '2020-01-01', 24, now)).toBe(false);
  });

  it('does not qualify a firm that is not Authorised, even if it is a former AR', () => {
    expect(qualifiesForTransitionsOnly('Appointed representative', true, '2015-01-01', 24, now)).toBe(false);
  });

  it('respects the months window override', () => {
    expect(qualifiesForTransitionsOnly('Authorised', false, '2025-01-01', 6, now)).toBe(false);
    expect(qualifiesForTransitionsOnly('Authorised', false, '2026-06-01', 6, now)).toBe(true);
  });
});

describe('compareTransitionRank', () => {
  it('ranks a former AR ahead of a merely-recent authorisation', () => {
    const formerAr = { formerAr: true, authorisedSince: '2020-01-01', firmName: 'Zeta Ltd' };
    const recent = { formerAr: false, authorisedSince: '2026-01-01', firmName: 'Alpha Ltd' };
    expect(compareTransitionRank(formerAr, recent)).toBeLessThan(0);
  });

  it('within the same formerAr bucket, ranks the most recently authorised first', () => {
    const older = { formerAr: true, authorisedSince: '2020-01-01', firmName: 'A Ltd' };
    const newer = { formerAr: true, authorisedSince: '2025-01-01', firmName: 'B Ltd' };
    expect(compareTransitionRank(newer, older)).toBeLessThan(0);
  });

  it('falls back to name when dates are equal', () => {
    const a = { formerAr: true, authorisedSince: '2020-01-01', firmName: 'Alpha Ltd' };
    const b = { formerAr: true, authorisedSince: '2020-01-01', firmName: 'Beta Ltd' };
    expect(compareTransitionRank(a, b)).toBeLessThan(0);
  });

  it('sorts a missing authorisedSince to the back within its formerAr bucket', () => {
    const dated = { formerAr: false, authorisedSince: '2025-01-01', firmName: 'Alpha Ltd' };
    const undated = { formerAr: false, authorisedSince: null, firmName: 'Zeta Ltd' };
    expect(compareTransitionRank(dated, undated)).toBeLessThan(0);
  });
});

describe('diffFields', () => {
  const baseExisting: ExistingProspectRow = {
    id: '11111111-1111-1111-1111-111111111111',
    firm_name: 'Trust Point Mortgage & Protection Services Limited',
    frn: '1044052',
    fca_status: 'Authorised',
    permissions: ['Advising on regulated mortgage contracts'],
    website: null,
    main_phone: null,
    registered_address: null,
    companies_house_number: '15993274',
    authorised_since: '2025-12-18',
    former_ar: true,
    ar_ceased_on: '2024-11-29',
  };

  it('regression: a DATE column read back as a JS Date does not report a spurious diff against the same date as a "yyyy-mm-dd" string', () => {
    // node-postgres returns DATE columns as JS Date objects, not the
    // "yyyy-mm-dd" strings this script writes/compares — left unhandled,
    // this compared not-equal on every single re-run of an unchanged row.
    const existingFromDb: ExistingProspectRow = {
      ...baseExisting,
      authorised_since: new Date('2025-12-18T00:00:00.000Z') as unknown as string,
      ar_ceased_on: new Date('2024-11-29T00:00:00.000Z') as unknown as string,
    };
    const diffs = diffFields(existingFromDb, {
      authorised_since: '2025-12-18',
      ar_ceased_on: '2024-11-29',
    });
    expect(diffs).toEqual([]);
  });

  it('still reports a genuine date change, Date-object side vs string side', () => {
    const existingFromDb: ExistingProspectRow = {
      ...baseExisting,
      authorised_since: new Date('2019-05-16T00:00:00.000Z') as unknown as string,
    };
    const diffs = diffFields(existingFromDb, { authorised_since: '2019-05-17' });
    expect(diffs).toEqual(['authorised_since: "2019-05-16" -> "2019-05-17"']);
  });

  it('reports no diff when nothing changed', () => {
    expect(diffFields(baseExisting, { fca_status: 'Authorised', former_ar: true })).toEqual([]);
  });

  it('reports a diff for an ordinary changed field', () => {
    expect(diffFields(baseExisting, { fca_status: 'Appointed representative' })).toEqual([
      'fca_status: "Authorised" -> "Appointed representative"',
    ]);
  });

  it('treats permissions as an unordered set, not order-sensitive', () => {
    const existing: ExistingProspectRow = { ...baseExisting, permissions: ['A', 'B'] };
    expect(diffFields(existing, { permissions: ['B', 'A'] })).toEqual([]);
  });
});

describe('isEligibleForPrefixMatch', () => {
  it('is eligible for a normalised name with 2+ tokens and 8+ characters', () => {
    expect(isEligibleForPrefixMatch('trust point')).toBe(true);
  });

  it('rejects a single-token name, however long', () => {
    expect(isEligibleForPrefixMatch('switcheroo')).toBe(false);
  });

  it('rejects a name under 8 characters, even with 2 tokens', () => {
    expect(isEligibleForPrefixMatch('a b')).toBe(false);
  });

  it('accepts a name at exactly the 8-character boundary', () => {
    expect('ab cdefg'.length).toBe(8);
    expect(isEligibleForPrefixMatch('ab cdefg')).toBe(true);
  });

  it('rejects a name one character under the 8-character boundary', () => {
    expect('ab cdef'.length).toBe(7);
    expect(isEligibleForPrefixMatch('ab cdef')).toBe(false);
  });
});

describe('findMatchingExistingClient', () => {
  it('matches on an exact normalised name', () => {
    expect(findMatchingExistingClient('Trust Point', ['Some Other Org', 'Trust Point'])).toBe('Trust Point');
  });

  it('matches by prefix — a short tenant name against the FCA Register\'s longer registered name', () => {
    expect(
      findMatchingExistingClient('TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED', ['Trust Point'])
    ).toBe('Trust Point');
  });

  it('does not prefix-match a 1-token organisation name', () => {
    expect(findMatchingExistingClient('Switcheroo Financial Services Ltd', ['Switcheroo'])).toBeNull();
  });

  it('does not prefix-match an organisation name under 8 characters', () => {
    expect(findMatchingExistingClient('AB Financial Services Ltd', ['A B'])).toBeNull();
  });

  it('does not match an unrelated firm', () => {
    expect(
      findMatchingExistingClient('Clever Financial Solutions Limited', ['Trust Point'])
    ).toBeNull();
  });

  it('returns null when the org list is empty', () => {
    expect(findMatchingExistingClient('Trust Point', [])).toBeNull();
  });
});

describe('formatStatusEffectiveDateLabel', () => {
  it('labels an Appointed Representative\'s date as "AR since", not "authorised"', () => {
    expect(formatStatusEffectiveDateLabel('Appointed representative', '2017-12-11')).toBe('AR since 2017-12-11');
  });

  it('is case-insensitive on the "Appointed representative" status', () => {
    expect(formatStatusEffectiveDateLabel('APPOINTED REPRESENTATIVE', '2017-12-11')).toBe('AR since 2017-12-11');
  });

  it('labels a genuinely Authorised firm\'s date as "authorised"', () => {
    expect(formatStatusEffectiveDateLabel('Authorised', '2025-12-18')).toBe('authorised 2025-12-18');
  });

  it('labels an authorised-adjacent variant as "authorised" too', () => {
    expect(formatStatusEffectiveDateLabel('EEA Authorised', '2025-12-18')).toBe('authorised 2025-12-18');
  });

  it('returns null when there is no date to print', () => {
    expect(formatStatusEffectiveDateLabel('Appointed representative', null)).toBeNull();
    expect(formatStatusEffectiveDateLabel('Authorised', null)).toBeNull();
  });
});

describe('findMatchingExistingClient — word-boundary prefix', () => {
  it('matches the real Trust Point pair', () => {
    expect(
      findMatchingExistingClient(
        'TRUST POINT MORTGAGE & PROTECTION SERVICES LIMITED',
        ['Trust Point']
      )
    ).toBe('Trust Point');
  });

  it('does NOT match an unrelated firm that merely starts with the same letters', () => {
    // "trust pointer financial services" literally starts with "trust point",
    // so a bare startsWith() would wrongly skip it as an existing client.
    expect(
      findMatchingExistingClient('Trust Pointer Financial Services Ltd', ['Trust Point'])
    ).toBeNull();
  });
});
