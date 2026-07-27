import { AppError } from '../middleware/errors.js';

/*
 * Reporting windows for the superadmin reports.
 *
 * A report takes either an explicit range (?from=YYYY-MM-DD&to=YYYY-MM-DD) or a
 * rolling count (?days=N). Both resolve to a pair of inclusive Europe/London
 * calendar days rather than a "now() - N days" instant, so that:
 *   - the per-day buckets in a chart add up to the totals shown beside them,
 *   - "7 days" means seven whole days to a human, either side of a clock change,
 *   - and a custom range means the days the user picked, ends included.
 */

export const LONDON = 'Europe/London';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_WINDOW_DAYS = 366;

/** Today's date in London as YYYY-MM-DD (en-CA formats ISO-style). */
export const londonToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(new Date());

/** Shift a YYYY-MM-DD date by whole days. UTC arithmetic — no DST drift. */
export function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, exclusive of `from` (same day → 0). */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  );
}

export interface ReportWindow {
  /** Inclusive first London day, YYYY-MM-DD. */
  from: string;
  /** Inclusive last London day, YYYY-MM-DD. */
  to: string;
  days: number;
}

export function resolveWindow(
  q: Record<string, unknown>,
  defaultDays = 30
): ReportWindow {
  const from = q.from == null ? '' : String(q.from);
  const to = q.to == null ? '' : String(q.to);

  if (from || to) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new AppError(400, 'from and to must both be dates in YYYY-MM-DD format');
    }
    if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
      throw new AppError(400, 'from and to must be real calendar dates');
    }
    if (from > to) throw new AppError(400, 'from must be on or before to');
    const days = daysBetween(from, to) + 1;
    if (days > MAX_WINDOW_DAYS) {
      throw new AppError(400, `range must be ${MAX_WINDOW_DAYS} days or fewer`);
    }
    return { from, to, days };
  }

  // `?? defaultDays` for absent, NaN check for junk — not `|| defaultDays`,
  // which would quietly turn days=0 into the default instead of clamping it.
  const requested = parseInt(String(q.days ?? defaultDays), 10);
  const days = Math.min(
    MAX_WINDOW_DAYS,
    Math.max(1, Number.isNaN(requested) ? defaultDays : requested)
  );
  const today = londonToday();
  return { from: shiftDate(today, -(days - 1)), to: today, days };
}

/**
 * SQL predicate for "this timestamptz column falls inside the window", with the
 * window's two dates bound as $1/$2. `to` is inclusive, so the upper bound is
 * the start of the following London day.
 */
export const inWindow = (col: string): string =>
  `${col} >= ($1::date)::timestamp AT TIME ZONE '${LONDON}'` +
  ` AND ${col} < (($2::date) + 1)::timestamp AT TIME ZONE '${LONDON}'`;

export const windowParams = (w: ReportWindow): [string, string] => [w.from, w.to];
