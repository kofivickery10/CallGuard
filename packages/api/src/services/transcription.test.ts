import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOne } from '../db/client.js';
import { SORT_CODE_TAG, ACCOUNT_NUMBER_TAG } from './digit-redaction.js';
import {
  resolveRedactCategories,
  REDACTION_CATEGORIES,
  resolveTenantRedactCategories,
  redactForTenant,
} from './transcription.js';

vi.mock('../db/client.js', () => ({
  queryOne: vi.fn(),
}));

describe('resolveRedactCategories', () => {
  it('redacts everything when no category is permitted', () => {
    expect(resolveRedactCategories([]).sort()).toEqual([...REDACTION_CATEGORIES].sort());
    expect(resolveRedactCategories().sort()).toEqual([...REDACTION_CATEGORIES].sort());
  });

  it('always redacts pci, even when explicitly asked not to', () => {
    // The schema CHECK in migration 079 should make this unreachable, but the
    // floor must not depend on the database being correct.
    expect(resolveRedactCategories(['pci'])).toContain('pci');
    expect(resolveRedactCategories(['pci', 'phi'])).toContain('pci');
    expect(resolveRedactCategories([...REDACTION_CATEGORIES])).toEqual(['pci']);
  });

  it('drops only the categories permitted', () => {
    const result = resolveRedactCategories(['phi']);
    expect(result).not.toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
    expect(result).toContain('dob');
  });

  it('supports the identity-only profile (Article 6) without exposing health', () => {
    const identity = [
      'name', 'name_given', 'name_family',
      'dob',
      'email_address',
      'location_address', 'location_city', 'location_state', 'location_zip', 'location_country',
    ];
    const result = resolveRedactCategories(identity);
    // Health stays redacted — this profile deliberately does not need a DPIA.
    expect(result).toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
    for (const c of identity) expect(result).not.toContain(c);
  });

  it('ignores unknown categories rather than widening exposure', () => {
    // Fail closed: a typo or a stale category name must not drop real redaction.
    const result = resolveRedactCategories(['phhi', 'HEALTH', '']);
    expect(result.sort()).toEqual([...REDACTION_CATEGORIES].sort());
  });

  it('is unaffected by duplicates', () => {
    expect(resolveRedactCategories(['phi', 'phi', 'phi'])).toEqual(
      resolveRedactCategories(['phi'])
    );
  });
});

describe('resolveTenantRedactCategories — the one place batch and live both load policy from', () => {
  beforeEach(() => {
    vi.mocked(queryOne).mockReset();
  });

  it('resolves the org row into the redact list Deepgram is asked for', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce({ pii_unredacted_categories: ['phi'] });
    const result = await resolveTenantRedactCategories('org-1');
    expect(result).not.toContain('phi');
    expect(result).toContain('pci');
    expect(result).toContain('numbers');
  });

  it('redacts everything when the org has no row', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null);
    expect((await resolveTenantRedactCategories('org-1')).sort()).toEqual(
      [...REDACTION_CATEGORIES].sort()
    );
  });

  it('fails closed — redacts everything — when the org row load throws', async () => {
    vi.mocked(queryOne).mockRejectedValueOnce(new Error('connection reset'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await resolveTenantRedactCategories('org-1');
    expect(result.sort()).toEqual([...REDACTION_CATEGORIES].sort());
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('redactForTenant — the single entry point for the in-house bank-detail pass', () => {
  it('redacts bank details in the text', () => {
    const { text, textRedactions } = redactForTenant('Agent: sort code is 20 45 67, thanks.');
    expect(text).toContain(SORT_CODE_TAG);
    expect(text).not.toMatch(/20 45 67/);
    expect(textRedactions).toBeGreaterThan(0);
  });

  it('is inert on text with nothing to redact', () => {
    const { text, textRedactions } = redactForTenant('Agent: hello, how can I help today?');
    expect(text).toBe('Agent: hello, how can I help today?');
    expect(textRedactions).toBe(0);
  });

  it('handles the fully-empty transcript explicitly rather than throwing', () => {
    const { text, textRedactions } = redactForTenant('');
    expect(text).toBe('');
    expect(textRedactions).toBe(0);
  });

  it('redacts the raw payload too when supplied, alongside the text', () => {
    const raw = {
      results: { utterances: [{ transcript: 'account number 87654321', speaker: 0 }] },
    };
    const { raw: redactedRaw, rawRedactions } = redactForTenant('account number 87654321', raw);
    expect(rawRedactions).toBeGreaterThan(0);
    expect((redactedRaw as any).results.utterances[0].transcript).toContain(ACCOUNT_NUMBER_TAG);
  });

  it('leaves raw untouched (and reports zero raw redactions) when no raw payload is supplied', () => {
    const { raw, rawRedactions } = redactForTenant('sort code 20 45 67');
    expect(raw).toBeUndefined();
    expect(rawRedactions).toBe(0);
  });
});
