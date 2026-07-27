import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveWindow,
  shiftDate,
  daysBetween,
  inWindow,
  windowParams,
  MAX_WINDOW_DAYS,
} from './report-window.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze the clock at a UTC instant. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('shiftDate / daysBetween', () => {
  it('shifts across month and year boundaries', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29'); // leap year
  });

  it('is unaffected by British Summer Time starting mid-range', () => {
    // BST began 2026-03-29; a naive local-midnight + 24h walk drifts by an hour
    // and can repeat or skip a day.
    expect(shiftDate('2026-03-28', 1)).toBe('2026-03-29');
    expect(shiftDate('2026-03-29', 1)).toBe('2026-03-30');
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31);
  });

  it('counts inclusive-day ranges from the same day as zero', () => {
    expect(daysBetween('2026-07-27', '2026-07-27')).toBe(0);
  });
});

describe('resolveWindow — rolling days', () => {
  it('covers N whole London days ending today', () => {
    at('2026-07-27T12:00:00Z');
    expect(resolveWindow({ days: '7' })).toEqual({ from: '2026-07-21', to: '2026-07-27', days: 7 });
    expect(resolveWindow({ days: '1' })).toEqual({ from: '2026-07-27', to: '2026-07-27', days: 1 });
    expect(resolveWindow({ days: '30' })).toEqual({ from: '2026-06-28', to: '2026-07-27', days: 30 });
  });

  it('uses the London day, not UTC, just before midnight in summer', () => {
    // 23:30 UTC on 26 July is already 00:30 on 27 July in London (BST).
    at('2026-07-26T23:30:00Z');
    expect(resolveWindow({ days: '1' })).toEqual({ from: '2026-07-27', to: '2026-07-27', days: 1 });
  });

  it('falls back to the default for missing or junk values', () => {
    at('2026-07-27T12:00:00Z');
    expect(resolveWindow({}).days).toBe(30);
    expect(resolveWindow({}, 7).days).toBe(7);
    expect(resolveWindow({ days: 'abc' }, 7).days).toBe(7);
  });

  it('clamps to a sane span', () => {
    at('2026-07-27T12:00:00Z');
    expect(resolveWindow({ days: '0' }).days).toBe(1);
    expect(resolveWindow({ days: '-5' }).days).toBe(1);
    expect(resolveWindow({ days: '9999' }).days).toBe(MAX_WINDOW_DAYS);
  });
});

describe('resolveWindow — explicit range', () => {
  it('includes both end dates', () => {
    expect(resolveWindow({ from: '2026-07-17', to: '2026-07-20' })).toEqual({
      from: '2026-07-17', to: '2026-07-20', days: 4,
    });
    expect(resolveWindow({ from: '2026-07-20', to: '2026-07-20' }).days).toBe(1);
  });

  it('takes precedence over days', () => {
    expect(resolveWindow({ days: '90', from: '2026-07-01', to: '2026-07-02' }).days).toBe(2);
  });

  it('rejects half-specified, malformed, reversed and oversized ranges', () => {
    expect(() => resolveWindow({ from: '2026-07-01' })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveWindow({ to: '2026-07-01' })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveWindow({ from: '01/07/2026', to: '02/07/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => resolveWindow({ from: '2026-13-01', to: '2026-13-02' })).toThrow(/real calendar dates/);
    expect(() => resolveWindow({ from: '2026-07-20', to: '2026-07-17' })).toThrow(/on or before/);
    expect(() => resolveWindow({ from: '2020-01-01', to: '2026-07-27' })).toThrow(/366 days or fewer/);
  });
});

describe('inWindow / windowParams', () => {
  it('binds the window dates in order and makes the upper bound exclusive', () => {
    const w = resolveWindow({ from: '2026-07-17', to: '2026-07-20' });
    expect(windowParams(w)).toEqual(['2026-07-17', '2026-07-20']);

    const sql = inWindow('created_at');
    expect(sql).toContain('created_at >= ($1::date)');
    expect(sql).toContain('created_at < (($2::date) + 1)');
    expect(sql).toContain("AT TIME ZONE 'Europe/London'");
  });

  it('qualifies the column it is given, for joined queries', () => {
    expect(inWindow('ue.created_at')).toContain('ue.created_at >=');
  });
});
