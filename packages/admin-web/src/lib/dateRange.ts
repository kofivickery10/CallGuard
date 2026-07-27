/*
 * Reporting ranges for the superadmin reports. A range is either a rolling day
 * count or an explicit pair of dates; both resolve to inclusive Europe/London
 * calendar days, matching how the API buckets the data (see resolveWindow in
 * routes/superadmin.ts). Keeping the same arithmetic on both sides means the
 * dates shown in the picker are the dates the numbers were computed over.
 */

export type DateRange = { days: number } | { from: string; to: string };

export const isCustomRange = (r: DateRange): r is { from: string; to: string } =>
  'from' in r;

/** Today in London as YYYY-MM-DD (en-CA formats ISO-style). */
export const londonToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** Shift a YYYY-MM-DD date by whole days — UTC arithmetic, so no DST drift. */
export function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

export function daysInRange(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  ) + 1;
}

/** The concrete dates a range covers. */
export function resolveRange(r: DateRange): { from: string; to: string; days: number } {
  if (isCustomRange(r)) return { from: r.from, to: r.to, days: daysInRange(r.from, r.to) };
  const to = londonToday();
  return { from: shiftDate(to, -(r.days - 1)), to, days: r.days };
}

/** Query string the API expects for this range. */
export function rangeQuery(r: DateRange): string {
  return isCustomRange(r)
    ? `from=${r.from}&to=${r.to}`
    : `days=${r.days}`;
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

export const formatDay = (iso: string): string => DAY_FMT.format(new Date(`${iso}T00:00:00Z`));

/** "1 Jul – 27 Jul 2026", or a single date when the range is one day. */
export function formatRange(from: string, to: string): string {
  if (from === to) return formatDay(from);
  return `${formatDay(from)} – ${formatDay(to)}`;
}
