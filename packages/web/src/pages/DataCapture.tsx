import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { CaptureRunStatus } from '@callguard/shared';

interface RunRow {
  id: string;
  journey_id: string | null;
  call_id: string | null;
  status: CaptureRunStatus;
  error_message: string | null;
  completed_at: string | null;
  created_at: string;
  form_name: string;
  context_label: string | null;
  customer_name: string | null;
  missed_required: number;
  needs_review: number;
}

interface CoverageRow {
  form_id: string;
  form_name: string;
  field_id: string;
  label: string;
  required: boolean;
  total: string;
  asked: string;
  missed: string;
  manual_review: string;
}

const RUN_STATUS_STYLES: Record<CaptureRunStatus, { label: string; className: string }> = {
  completed: { label: 'Completed', className: 'bg-pass-bg text-pass' },
  running: { label: 'Running', className: 'bg-processing-bg text-processing' },
  pending: { label: 'Queued', className: 'bg-processing-bg text-processing' },
  needs_form: { label: 'Needs form', className: 'bg-review-bg text-review' },
  failed: { label: 'Failed', className: 'bg-fail-bg text-fail' },
};

const DAY_OPTIONS = [7, 30, 90];

// Data Capture overview: sales needing attention (missed answers, unresolved
// forms, failures) and per-question coverage — which questions agents skip.
export function DataCapture() {
  const [days, setDays] = useState(30);

  const { data: runsData, isLoading: runsLoading, isError: runsError } = useQuery({
    queryKey: ['capture-runs'],
    queryFn: () => api.get<{ data: RunRow[] }>('/capture/runs?limit=100'),
  });

  const { data: coverageData, isLoading: covLoading } = useQuery({
    queryKey: ['capture-coverage', days],
    queryFn: () => api.get<{ days: number; data: CoverageRow[] }>(`/capture/coverage?days=${days}`),
  });

  const runs = runsData?.data ?? [];
  const attention = runs.filter(
    (r) => r.status === 'needs_form' || r.status === 'failed' || r.missed_required > 0 || r.needs_review > 0
  );
  const coverage = coverageData?.data ?? [];

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Data Capture</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          Every answer the customer gave, captured per sale — and the questions your agents are missing.
        </p>
      </div>

      {runsError && (
        <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell mb-4 inline-block">
          Could not load capture runs.
        </div>
      )}

      {/* Needs attention */}
      <div className="bg-card border border-border rounded-card overflow-hidden mb-5">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-section-title text-text-primary">Needs attention ({attention.length})</h3>
          <p className="text-xs text-text-subtle mt-0.5">
            Sales with missed required answers, answers awaiting review, unmatched forms, or failed runs.
          </p>
        </div>
        {runsLoading ? (
          <div className="px-5 py-8 flex items-center justify-center text-text-muted text-table-cell">
            <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mr-3" />
            Loading…
          </div>
        ) : attention.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            Nothing needs attention — all captured sales are complete.
          </p>
        ) : (
          <div>
            {attention.map((r) => (
              <Link
                key={r.id}
                to={r.journey_id ? `/journeys/${r.journey_id}` : r.call_id ? `/calls/${r.call_id}` : '#'}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-border-light last:border-0 hover:bg-table-header transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-table-cell text-text-primary font-medium">
                    {r.customer_name ?? 'Unknown customer'}
                    <span className="text-text-muted font-normal"> — {r.form_name}</span>
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {new Date(r.created_at).toLocaleDateString('en-GB')}
                    {r.status === 'failed' && r.error_message ? ` · ${r.error_message}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {r.missed_required > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-fail-bg text-fail">
                      {r.missed_required} missed
                    </span>
                  )}
                  {r.needs_review > 0 && (
                    <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-review-bg text-review">
                      {r.needs_review} review
                    </span>
                  )}
                  <span className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${RUN_STATUS_STYLES[r.status].className}`}>
                    {RUN_STATUS_STYLES[r.status].label}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Coverage */}
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-section-title text-text-primary">Question coverage</h3>
            <p className="text-xs text-text-subtle mt-0.5">
              How often each question was asked across completed captures — spot the ones agents skip.
            </p>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Coverage period">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`px-2.5 py-1 rounded-btn text-badge font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  days === d
                    ? 'bg-primary text-white'
                    : 'text-text-secondary hover:bg-table-header'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        {covLoading ? (
          <div className="px-5 py-8 flex items-center justify-center text-text-muted text-table-cell">
            <div className="w-6 h-6 border-2 border-border border-t-primary rounded-full animate-spin mr-3" />
            Loading…
          </div>
        ) : coverage.length === 0 ? (
          <p className="px-5 py-8 text-center text-text-muted text-table-cell">
            No completed captures in the last {days} days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-table-header text-left">
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Question</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider">Form</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">Sales</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">Asked</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">Missed</th>
                  <th className="px-5 py-3 text-table-header text-text-muted uppercase tracking-wider text-right">Review</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((row) => {
                  const total = parseInt(row.total, 10) || 0;
                  const asked = parseInt(row.asked, 10) || 0;
                  const missed = parseInt(row.missed, 10) || 0;
                  const review = parseInt(row.manual_review, 10) || 0;
                  const askedPct = total > 0 ? Math.round((asked / total) * 100) : 0;
                  return (
                    <tr key={row.field_id} className="border-t border-border-light">
                      <td className="px-5 py-3 text-table-cell text-text-primary">
                        {row.label}
                        {row.required && <span className="sr-only"> (required)</span>}
                        {!row.required && <span className="text-text-muted"> (optional)</span>}
                      </td>
                      <td className="px-5 py-3 text-table-cell text-text-muted">{row.form_name}</td>
                      <td className="px-5 py-3 text-table-cell text-text-secondary text-right">{total}</td>
                      <td className={`px-5 py-3 text-table-cell text-right font-semibold ${askedPct < 90 && row.required ? 'text-fail' : 'text-text-secondary'}`}>
                        {askedPct}%
                      </td>
                      <td className={`px-5 py-3 text-table-cell text-right ${missed > 0 ? 'text-fail font-semibold' : 'text-text-muted'}`}>
                        {missed}
                      </td>
                      <td className={`px-5 py-3 text-table-cell text-right ${review > 0 ? 'text-review font-semibold' : 'text-text-muted'}`}>
                        {review}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
