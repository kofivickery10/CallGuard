import { describe, it, expect, vi } from 'vitest';
import { queryOne } from '../db/client.js';
import {
  checkFetchRecordingsOnSaleBody,
  getScoringSettings,
  resolveFetchRecordingsOnSale,
} from './tenant-settings.js';

// organizations.fetch_recordings_on_sale (migration 119): download a dialler
// recording only when that customer's sale arrives. Only a sales_only firm may
// have it on — a firm scoring every call needs every recording — and the
// consequence of getting it wrong in either direction is real: on by mistake
// loses recordings once the dialler deletes them; off by mistake starts storing
// audio of customers who never bought, which the firm chose not to have.

vi.mock('../db/client.js', () => ({ queryOne: vi.fn() }));

describe('checkFetchRecordingsOnSaleBody', () => {
  it('accepts a body that does not mention the flag', () => {
    expect(checkFetchRecordingsOnSaleBody({ scoring_scope: 'everything' })).toBeNull();
  });

  it('rejects anything but a boolean', () => {
    expect(checkFetchRecordingsOnSaleBody({ fetch_recordings_on_sale: 'true' })).toMatch(/true or false/);
    expect(checkFetchRecordingsOnSaleBody({ fetch_recordings_on_sale: 1 })).toMatch(/true or false/);
    expect(checkFetchRecordingsOnSaleBody({ fetch_recordings_on_sale: null })).toMatch(/true or false/);
  });

  it('rejects turning it on while moving the firm off sales_only', () => {
    expect(
      checkFetchRecordingsOnSaleBody({ scoring_scope: 'everything', fetch_recordings_on_sale: true })
    ).toMatch(/sales_only/);
  });

  it('accepts turning it on with sales_only, or off with any scope', () => {
    expect(checkFetchRecordingsOnSaleBody({ scoring_scope: 'sales_only', fetch_recordings_on_sale: true })).toBeNull();
    expect(checkFetchRecordingsOnSaleBody({ scoring_scope: 'everything', fetch_recordings_on_sale: false })).toBeNull();
    // Scope left to the stored row: resolveFetchRecordingsOnSale decides.
    expect(checkFetchRecordingsOnSaleBody({ fetch_recordings_on_sale: true })).toBeNull();
  });
});

describe('resolveFetchRecordingsOnSale', () => {
  const salesOnlyOn = { scoring_scope: 'sales_only', fetch_recordings_on_sale: true };
  const salesOnlyOff = { scoring_scope: 'sales_only', fetch_recordings_on_sale: false };
  const everything = { scoring_scope: 'everything', fetch_recordings_on_sale: false };

  it('turns it on for a firm already at sales_only', () => {
    expect(resolveFetchRecordingsOnSale(salesOnlyOff, { fetch_recordings_on_sale: true })).toEqual({ value: true });
  });

  it('refuses to turn it on for a firm stored at another scope', () => {
    expect(resolveFetchRecordingsOnSale(everything, { fetch_recordings_on_sale: true })).toHaveProperty('error');
  });

  it('allows switching scope and turning it on together', () => {
    expect(
      resolveFetchRecordingsOnSale(everything, { scoring_scope: 'sales_only', fetch_recordings_on_sale: true })
    ).toEqual({ value: true });
  });

  it('REFUSES moving a firm with it on off sales_only unless the request turns it off too', () => {
    // Not quietly switched off: that would start downloading every recording
    // without anyone having decided to.
    const result = resolveFetchRecordingsOnSale(salesOnlyOn, { scoring_scope: 'everything' });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/fetch_recordings_on_sale: false/);
  });

  it('allows that move when the request turns it off explicitly', () => {
    expect(
      resolveFetchRecordingsOnSale(salesOnlyOn, { scoring_scope: 'everything', fetch_recordings_on_sale: false })
    ).toEqual({ value: false });
  });

  it('leaves the stored flag untouched when the request does not mention it', () => {
    expect(resolveFetchRecordingsOnSale(salesOnlyOn, { scoring_scope: 'sales_only' })).toEqual({ value: undefined });
    expect(resolveFetchRecordingsOnSale(everything, { scoring_scope: 'over_threshold' })).toEqual({ value: undefined });
  });
});

describe('getScoringSettings — fetchRecordingsOnSale', () => {
  function row(scoring_scope: string, fetch_recordings_on_sale: unknown) {
    return {
      scoring_scope,
      fetch_recordings_on_sale,
      min_scoreable_seconds: 15,
      min_scoreable_words: 30,
      pass_threshold: '70',
      retention_days: 1825,
      transcription_mode: 'mono_diarize',
      mono_first_speaker: 'agent',
      deepgram_region: 'eu',
      deepgram_mip_opt_out: true,
      scoring_samples: 1,
      review_confidence_floor: '0',
      zoho_writeback_trigger: 'on_scoring',
    };
  }

  it('reads it for a sales_only firm', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row('sales_only', true) as never);
    expect((await getScoringSettings('org-1')).fetchRecordingsOnSale).toBe(true);
  });

  it('never reports it on outside sales_only, even if a row somehow says so', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(row('everything', true) as never);
    expect((await getScoringSettings('org-1')).fetchRecordingsOnSale).toBe(false);
  });

  it('downloads when the org row is missing', async () => {
    vi.mocked(queryOne).mockResolvedValueOnce(null as never);
    expect((await getScoringSettings('org-1')).fetchRecordingsOnSale).toBe(false);
  });
});
