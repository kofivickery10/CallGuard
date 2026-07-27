import {
  type DateRange,
  isCustomRange,
  londonToday,
  resolveRange,
  shiftDate,
} from '../lib/dateRange';

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
  /** Rolling-day presets offered alongside the date inputs. */
  presets?: number[];
  /** Longest range the API will accept. */
  maxDays?: number;
}

const INPUT =
  'border border-border rounded-btn px-2.5 py-1.5 text-sm bg-card text-text-primary ' +
  'focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

export function DateRangePicker({ value, onChange, presets = [7, 30, 90], maxDays = 366 }: Props) {
  const resolved = resolveRange(value);
  const today = londonToday();
  const custom = isCustomRange(value);

  // Editing either date switches to a custom range, keeping the other end from
  // the currently resolved window so a half-finished edit is still a valid range.
  const setFrom = (from: string) => {
    if (!from) return;
    const to = resolved.to < from ? from : resolved.to;
    onChange({ from, to });
  };
  const setTo = (to: string) => {
    if (!to) return;
    const from = resolved.from > to ? to : resolved.from;
    onChange({ from, to });
  };

  const earliest = shiftDate(today, -(maxDays - 1));

  return (
    <div className="flex items-end gap-3 flex-wrap">
      <div className="flex gap-1" role="group" aria-label="Quick date ranges">
        {presets.map((d) => {
          const active = !custom && value.days === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange({ days: d })}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-btn text-sm border transition-colors ${
                active
                  ? 'border-primary bg-primary text-white font-semibold'
                  : 'border-border text-text-secondary hover:border-primary'
              } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
            >
              {d === 1 ? 'Today' : `${d}d`}
            </button>
          );
        })}
      </div>

      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">From</span>
          <input
            type="date"
            value={resolved.from}
            min={earliest}
            max={today}
            onChange={(e) => setFrom(e.target.value)}
            className={INPUT}
            aria-label="Range start date"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">To</span>
          <input
            type="date"
            value={resolved.to}
            min={resolved.from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            className={INPUT}
            aria-label="Range end date"
          />
        </label>
        {custom && (
          <button
            type="button"
            onClick={() => onChange({ days: presets[presets.length - 1] ?? 30 })}
            className="px-2.5 py-1.5 rounded-btn text-sm border border-border text-text-secondary hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
