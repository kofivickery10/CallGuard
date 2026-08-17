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
