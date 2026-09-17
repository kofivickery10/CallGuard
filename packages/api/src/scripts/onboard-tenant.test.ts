import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';

// onboard-tenant's config check: how the firm is scored must be stated in the
// config, never left to the column default (owner decision, 17 Sep 2026).
// Checked before the script reads or writes anything, dry run included.
//
// The database is mocked only because the script imports the pool; the check
// itself never touches it.
vi.mock('../db/client.js', () => ({
  pool: { end: vi.fn() },
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(),
}));

import { validateOnboardConfig } from './onboard-tenant.js';

describe('validateOnboardConfig', () => {
  it('refuses a config with no scoring section, explaining the choice', () => {
    const error = validateOnboardConfig({});
    expect(error).toMatch(/scoring\.scoring_scope is missing or invalid/);
    expect(error).toMatch(/there is no default/i);
    expect(error).toMatch(/"sales_only" scores sales/);
    expect(error).toMatch(/"everything" scores calls/);
  });

  it('refuses a scoring section without scoring_scope', () => {
    expect(validateOnboardConfig({ scoring: { pass_threshold: 70 } })).toMatch(/scoring_scope/);
  });

  it('refuses an unrecognised scoring_scope', () => {
    expect(validateOnboardConfig({ scoring: { scoring_scope: 'sales' } })).toMatch(/missing or invalid/);
  });

  it.each(['sales_only', 'over_threshold', 'everything'])('accepts %s', (scope) => {
    expect(validateOnboardConfig({ scoring: { scoring_scope: scope } })).toBeNull();
  });

  it('refuses fetching recordings on sale for a firm that scores calls', () => {
    expect(
      validateOnboardConfig({ scoring: { scoring_scope: 'everything', fetch_recordings_on_sale: true } })
    ).toMatch(/sales_only/);
  });

  it('accepts fetching recordings on sale for a firm that scores sales', () => {
    expect(
      validateOnboardConfig({ scoring: { scoring_scope: 'sales_only', fetch_recordings_on_sale: true } })
    ).toBeNull();
  });
});

describe('the onboarding configs in the repo', () => {
  const dir = path.resolve(__dirname, 'onboard');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('exist', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s states how the firm is scored', (file) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    expect(validateOnboardConfig(cfg)).toBeNull();
  });
});
