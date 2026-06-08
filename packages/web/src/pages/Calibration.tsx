import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

interface TrendPoint {
  month: string;
  scored_calls: number;
  corrections: number;
  overrides_per_100_calls: number | null;
}
interface TopItem {
  label: string;
  corrections: number;
  too_lenient: number;
  too_harsh: number;
}
interface CalibrationData {
  total_corrections: number;
  current_override_rate: number | null;
  previous_override_rate: number | null;
  trend: TrendPoint[];
  top_items: TopItem[];
}

function monthLabel(m: string): string {
  const [y, mo] = m.split('-');
  return new Date(Date.UTC(Number(y), Number(mo) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
  });
}

export function Calibration() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['calibration'],
    queryFn: () => api.get<CalibrationData>('/insights/calibration'),
  });

  const maxRate = Math.max(1, ...(data?.trend ?? []).map((t) => t.overrides_per_100_calls ?? 0));
  const cur = data?.current_override_rate;
  const prev = data?.previous_override_rate;
  const improving = cur != null && prev != null && cur < prev;
  const worsening = cur != null && prev != null && cur > prev;

  return (
    <div className="max-w-4xl">
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Calibration</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          How closely the AI matches your reviewers' judgement, and where it still needs tuning.
        </p>
      </div>

      {isLoading && <div className="text-text-muted text-table-cell">Loading…</div>}
      {isError && (
        <div className="bg-fail-bg text-fail px-4 py-3 rounded-card text-table-cell">
          Couldn't load calibration data.
        </div>
      )}

      {data && (
        <>
          {data.total_corrections === 0 ? (
            <div className="bg-white border border-border rounded-card p-6 text-table-cell text-text-secondary">
              No corrections logged yet. Each time a supervisor overrides a score, the AI learns your
              interpretation — and this page will show how its agreement with your team improves over
              time.
            </div>
          ) : (
            <>
              {/* Headline */}
              <div className="bg-white border border-border rounded-card p-5 mb-5">
                <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
                  Reviewer override rate
                </h3>
                <p className="text-[12px] text-text-subtle mb-3">
                  How often a reviewer had to override the AI, per 100 scored calls. Lower means the
                  AI is more aligned with your team.
                </p>
                <div className="flex items-end gap-3">
                  <div className="text-[34px] font-bold text-text-primary leading-none">
                    {cur != null ? cur : '—'}
                    <span className="text-[16px] text-text-muted font-semibold"> / 100 calls</span>
                  </div>
                  {prev != null && cur != null && (
                    <span
                      className={`mb-1 text-[12px] font-semibold px-2 py-0.5 rounded ${
                        improving ? 'bg-pass-bg text-pass' : worsening ? 'bg-fail-bg text-fail' : 'bg-table-header text-text-muted'
                      }`}
                    >
                      {improving ? '↓ improving' : worsening ? '↑ rising' : 'flat'} (was {prev})
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-text-muted mt-1">
                  {data.total_corrections} total corrections used to calibrate the AI to date.
                </div>
              </div>

              {/* Trend */}
              <div className="bg-white border border-border rounded-card p-5 mb-5">
                <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-3">
                  Trend (last 6 months)
                </h3>
                <div className="flex items-end gap-3 h-32">
                  {data.trend.map((t) => {
                    const rate = t.overrides_per_100_calls ?? 0;
                    const h = Math.round((rate / maxRate) * 100);
                    return (
                      <div key={t.month} className="flex-1 flex flex-col items-center justify-end h-full">
                        <div className="text-[11px] text-text-muted mb-1">
                          {t.overrides_per_100_calls != null ? t.overrides_per_100_calls : '–'}
                        </div>
                        <div
                          className="w-full bg-primary/70 rounded-t"
                          style={{ height: `${Math.max(h, t.scored_calls > 0 ? 4 : 0)}%` }}
                          title={`${t.corrections} corrections / ${t.scored_calls} scored calls`}
                        />
                        <div className="text-[11px] text-text-muted mt-1.5">{monthLabel(t.month)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Where it disagrees most */}
              {data.top_items.length > 0 && (
                <div className="bg-white border border-border rounded-card p-5">
                  <h3 className="text-[13px] uppercase tracking-wider text-text-muted font-semibold mb-1">
                    Items needing the most calibration
                  </h3>
                  <p className="text-[12px] text-text-subtle mb-3">
                    Where reviewers override the AI most — and which way it leans.
                  </p>
                  <div className="space-y-2">
                    {data.top_items.map((it) => (
                      <div key={it.label} className="flex items-center justify-between py-1.5 border-b border-border-light last:border-0">
                        <span className="text-table-cell text-text-secondary pr-4">{it.label}</span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {it.too_lenient > 0 && (
                            <span className="text-[11px] px-2 py-0.5 rounded bg-fail-bg text-fail" title="AI passed it; reviewer failed it">
                              {it.too_lenient} too lenient
                            </span>
                          )}
                          {it.too_harsh > 0 && (
                            <span className="text-[11px] px-2 py-0.5 rounded bg-review-bg text-review" title="AI failed it; reviewer passed it">
                              {it.too_harsh} too harsh
                            </span>
                          )}
                          <span className="text-[12px] text-text-muted w-10 text-right">{it.corrections}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
