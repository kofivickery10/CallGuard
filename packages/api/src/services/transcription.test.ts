import { describe, it, expect } from 'vitest';
import { resolveRedactCategories, REDACTION_CATEGORIES } from './transcription.js';

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
