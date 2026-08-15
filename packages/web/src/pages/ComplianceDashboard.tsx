import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { api } from '../api/client';
import { CountUp } from '../components/CountUp';
import { useChartColors, TOOLTIP_STYLE, TOOLTIP_LABEL_STYLE } from '../lib/chartColors';
import type {
  ReconciliationDashboardSummary,
  ReconciliationTrendPoint,
  ReconciliationInsurerRow,
  ReconciliationFlaggedQuestion,
  ReconciliationAdviserRow,
  UncoveredSale,
  ReconciliationRunStatus,
} from '@callguard/shared';

// Mirrors the attention queue's labels so the two pages never describe the same
// run differently. Kept in step with DataForms.tsx by hand — a run status is a
// product decision, not a rendering detail.
const RUN_STATUS: Record<ReconciliationRunStatus, { label: string; className: string }> = {
  completed: { label: 'Checked', className: 'bg-pass-bg text-pass' },
  running: { label: 'Running', className: 'bg-processing-bg text-processing' },
  pending: { label: 'Queued', className: 'bg-processing-bg text-processing' },
  needs_document: { label: 'Waiting for document', className: 'bg-review-bg text-review' },
  needs_profile: { label: 'Needs review', className: 'bg-review-bg text-review' },
  summary_only: { label: 'No questions', className: 'bg-table-header text-text-secondary' },
  failed: { label: 'Failed', className: 'bg-fail-bg text-fail' },
  abandoned: { label: 'Never checked', className: 'bg-table-header text-text-secondary' },
};

interface RunRow {
  id: string;
  journey_id: string;
  status: ReconciliationRunStatus;
  created_at: string;
  customer_name: string | null;
  insurer: string | null;
  mismatches: number;
  not_asked: number;
  no_answer: number;
  missing: number;
  withdrawn: number;
  total_questions: number;
}

const DAY_OPTIONS = [7, 30, 90] as const;
const TREND_WEEKS = 12;

// ============================================================
// Small shared pieces
// ============================================================

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded bg-[length:800px_100%] animate-skeleton-shimmer ${className}`}
      style={{
        backgroundImage:
          'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
      }}
    />
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell inline-block">
      {children}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-section-title text-text-primary">{title}</h3>
          {subtitle && <p className="text-xs text-text-subtle mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-card p-5">
      <div className="mb-4">
        <h4 className="text-section-title text-text-primary">{title}</h4>
        <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="h-[220px] flex items-center justify-center text-table-cell text-text-muted text-center px-4">
      {message}
    </div>
  );
}

/** A count with its own label, so a number is never read by colour alone. */
function CountPill({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone: 'fail' | 'review';
}) {
  if (n <= 0) return null;
  return (
    <span
      className={`px-2.5 py-[3px] rounded-full text-badge font-semibold whitespace-nowrap ${
        tone === 'fail' ? 'bg-fail-bg text-fail' : 'bg-review-bg text-review'
      }`}
    >
      {n} {label}
    </span>
  );
}

type Tone = 'default' | 'review' | 'fail';

function StatCard({
  label,
  value,
  suffix,
  note,
  tone = 'default',
  loading,
  to,
}: {
  label: string;
  value: number | null;
  suffix?: string;
  note?: string;
  tone?: Tone;
  loading: boolean;
  /** Where this figure can be acted on. Omit for tiles that lead nowhere. */
  to?: string;
}) {
  const valueColor =
    tone === 'fail' ? 'text-fail' : tone === 'review' ? 'text-review' : 'text-text-primary';
  const body = (
    <>
      <span className="text-card-label uppercase text-text-muted">{label}</span>
      <div className={`text-card-value mt-2.5 ${valueColor}`}>
        {loading ? (
          <Skeleton className="h-7 w-16" />
        ) : value == null ? (
          <span className="text-text-muted">--</span>
        ) : (
          <CountUp value={value} suffix={suffix} />
        )}
      </div>
      {!loading && note && <div className="text-xs mt-1 text-text-muted">{note}</div>}
    </>
  );

  const base = 'bg-card border border-border rounded-card p-5';
  // A tile only becomes a link once it has something to point at. Linking a
  // zero would promise a list and then deliver an empty one.
  if (!to || loading || !value) return <div className={base}>{body}</div>;
  return (
    <Link
      to={to}
      className={`${base} block hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
    >
      {body}
    </Link>
  );
}

/** Inline magnitude bar — a match rate read at a glance beside its own number. */
function RateBar({ rate }: { rate: number | null }) {
  const { primary, review, fail } = useChartColors();
  if (rate == null) return <span className="text-text-muted text-table-cell">--</span>;
  const pct = Math.max(0, Math.min(100, rate));
  return (
    <div className="flex items-center gap-2">
      <div className="w-[50px] h-[5px] bg-border rounded-[3px] flex-shrink-0">
        <div
          className="h-full rounded-[3px]"
          style={{ width: `${pct}%`, background: pct >= 90 ? primary : pct >= 75 ? review : fail }}
        />
      </div>
      <span className="text-table-cell font-mono font-semibold text-text-cell">
        {Math.round(rate)}%
      </span>
    </div>
  );
}

const TH = 'text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border';

// ============================================================
// Page
// ============================================================

/**
 * The compliance section's dashboard. Today it is fed entirely by the Data
 * Forms reconciliation record; it is named for its place in the nav rather than
 * its current source so Data Capture or breach content can join it later
 * without the page having to be renamed.
 *
 * The attention queue on /data-forms answers "what do I action next". This page
 * answers the two questions a compliance lead has to answer to someone else —
 * is the checking actually running, and where are the findings concentrated.
 *
 * "Could not verify" is given its own tile rather than being folded into the
 * findings. A large undetermined share is a fact about our checking (usually
 * redaction removing the words that identify a question), not about the
 * advisers, and burying it would let the match rate look better than it is.
 */
export function ComplianceDashboard() {
  const [days, setDays] = useState<number>(30);
  /** Which flagged question has its sales open, if any. */
  const [expanded, setExpanded] = useState<string | null>(null);

  const summaryQ = useQuery({
    queryKey: ['dataforms-dashboard', 'summary', days],
    queryFn: () =>
      api.get<ReconciliationDashboardSummary>(`/reconciliation/dashboard/summary?days=${days}`),
  });

  const trendsQ = useQuery({
    queryKey: ['dataforms-dashboard', 'trends'],
    queryFn: () =>
      api.get<{ data: ReconciliationTrendPoint[] }>(
        `/reconciliation/dashboard/trends?weeks=${TREND_WEEKS}`
      ),
  });

  const insurersQ = useQuery({
    queryKey: ['dataforms-dashboard', 'by-insurer', days],
    queryFn: () =>
      api.get<{ data: ReconciliationInsurerRow[] }>(
        `/reconciliation/dashboard/by-insurer?days=${days}`
      ),
  });

  const questionsQ = useQuery({
    queryKey: ['dataforms-dashboard', 'flagged-questions', days],
    queryFn: () =>
      api.get<{ data: ReconciliationFlaggedQuestion[] }>(
        `/reconciliation/dashboard/flagged-questions?days=${days}&limit=10`
      ),
  });

  const recentQ = useQuery({
    queryKey: ['dataforms-dashboard', 'recent'],
    queryFn: () => api.get<{ data: RunRow[] }>('/reconciliation/runs?limit=8'),
  });

  const advisersQ = useQuery({
    queryKey: ['dataforms-dashboard', 'by-adviser', days],
    queryFn: () =>
      api.get<{ data: ReconciliationAdviserRow[] }>(
        `/reconciliation/dashboard/by-adviser?days=${days}`
      ),
  });

  const s = summaryQ.data;
  const loading = summaryQ.isLoading;

  // Only fetched when the coverage tile is actually non-zero — there is no list
  // to show otherwise, and asking for one would be a wasted round trip.
  const uncoveredQ = useQuery({
    queryKey: ['dataforms-dashboard', 'uncovered', days],
    queryFn: () =>
      api.get<{ data: UncoveredSale[] }>(
        `/reconciliation/dashboard/uncovered-sales?days=${days}&limit=20`
      ),
    enabled: !!s && s.missing_a_run > 0,
  });

  // Nothing has ever happened here, as opposed to "nothing in this window" —
  // worth saying plainly rather than showing eight zeroes and two empty charts.
  const neverRun =
    !!s &&
    s.sales_checked === 0 &&
    s.parked === 0 &&
    s.failed === 0 &&
    s.awaiting_confirmation === 0 &&
    // Sales owed a check but lacking one are a coverage problem, not an empty
    // module — show the tiles so the gap is visible rather than hiding it
    // behind a friendly "nothing here yet".
    s.sales_due === 0 &&
    (recentQ.data?.data.length ?? 0) === 0;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Compliance Dashboard</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Data Forms: how the application checks are running across every sale, and where the
            findings sit.
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Reporting period">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={`px-2.5 py-1 rounded-btn text-badge font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                days === d ? 'bg-primary text-white' : 'text-text-secondary hover:bg-table-header'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {summaryQ.isError && (
        <div className="mb-5">
          <ErrorBanner>Could not load the Data Forms figures.</ErrorBanner>
        </div>
      )}

      {neverRun ? (
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <p className="text-table-cell text-text-secondary">
            No sales have been checked yet.
          </p>
          <p className="text-xs text-text-muted mt-2 max-w-lg mx-auto leading-relaxed">
            Checks start on their own once a sale is scored and its application document is on the
            CRM record. The first document from an insurer needs its question set confirmed before
            anything is judged against it.
          </p>
          <Link
            to="/data-forms"
            className="inline-block mt-4 px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Go to Data Forms
          </Link>
        </div>
      ) : (
        <>
          {/* Tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-7">
            <StatCard
              label="Sales checked"
              value={s?.sales_checked ?? null}
              note={
                s && s.summary_only > 0
                  ? `${s.summary_only} more carried no questions`
                  : `Last ${days} days`
              }
              loading={loading}
            />
            <StatCard
              label="Never checked"
              value={s?.missing_a_run ?? null}
              tone={s && s.missing_a_run > 0 ? 'review' : 'default'}
              note={
                s
                  ? s.missing_a_run > 0
                    ? `Of ${s.sales_due} sale${s.sales_due === 1 ? '' : 's'} owed a check`
                    : `All ${s.sales_due} sale${s.sales_due === 1 ? '' : 's'} owed a check have one`
                  : undefined
              }
              loading={loading}
            />
            <StatCard
              label="Questions compared"
              value={s?.questions_compared ?? null}
              note={s ? `Across ${s.sales_checked} checked sale${s.sales_checked === 1 ? '' : 's'}` : undefined}
              loading={loading}
            />
            <StatCard
              label="Match rate"
              value={s?.match_rate != null ? Math.round(s.match_rate) : null}
              suffix="%"
              note={
                s && s.model_read > 0
                  ? `${s.model_read} model-read sale${s.model_read === 1 ? '' : 's'} excluded as provisional`
                  : 'Of questions we could conclude on'
              }
              loading={loading}
            />
            <StatCard
              label="Could not verify"
              value={s?.undetermined ?? null}
              note={
                s && s.recorded > 0
                  ? `Plus ${s.recorded} recorded, never compared`
                  : 'Excluded from the match rate'
              }
              loading={loading}
            />
            <StatCard
              label="Findings"
              value={s?.findings ?? null}
              to="/data-forms#attention"
              tone={s && s.findings > 0 ? 'fail' : 'default'}
              note={
                s && s.missing_from_application > 0
                  ? `Including ${s.missing_from_application} left blank on the application`
                  : 'Mismatched, not asked, unanswered, withdrawn'
              }
              loading={loading}
            />
            <StatCard
              label="Sales with findings"
              value={s?.sales_with_findings ?? null}
              to="/data-forms#attention"
              tone={s && s.sales_with_findings > 0 ? 'fail' : 'default'}
              note={
                s && s.sales_checked > 0
                  ? `${Math.round((s.sales_with_findings / s.sales_checked) * 100)}% of checked sales`
                  : undefined
              }
              loading={loading}
            />
            <StatCard
              label="Waiting"
              value={s?.parked ?? null}
              // Amber only once something has been waiting long enough to be at
              // risk: 'needs_document' gives up at 7 days, and nothing recovers
              // on its own after that.
              tone={s && s.oldest_waiting_days != null && s.oldest_waiting_days >= 7 ? 'review' : 'default'}
              note={
                s && s.oldest_waiting_days != null
                  ? `Oldest waiting ${s.oldest_waiting_days} day${s.oldest_waiting_days === 1 ? '' : 's'}`
                  : 'On a document, a format, or the queue'
              }
              loading={loading}
            />
            <StatCard
              label="Failed or abandoned"
              value={s?.failed ?? null}
              tone={s && s.failed > 0 ? 'fail' : 'default'}
              note="These never retry on their own"
              loading={loading}
            />
            <StatCard
              label="Sets to confirm"
              value={s?.awaiting_confirmation ?? null}
              to="/data-forms#awaiting"
              tone={s && s.awaiting_confirmation > 0 ? 'review' : 'default'}
              note="Question sets awaiting a person"
              loading={loading}
            />
          </div>

          {/* Coverage gap — an alarm, so it sits directly under the tile that
              raises it rather than below the charts. */}
          {!!s && s.missing_a_run > 0 && (
            <div className="bg-card border border-review rounded-card overflow-hidden mb-7">
              <div className="px-5 py-4 border-b border-border">
                <h3 className="text-section-title text-text-primary">
                  Sales never checked ({s.missing_a_run})
                </h3>
                <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">
                  Scored, with a CRM record, and no application check was ever created. Nothing on
                  this page counts these — they are missing rather than failing — so they will not
                  appear in any figure above. Oldest first.
                </p>
              </div>
              {uncoveredQ.isError ? (
                <div className="px-5 py-4">
                  <ErrorBanner>Could not load the uncovered sales.</ErrorBanner>
                </div>
              ) : uncoveredQ.isLoading ? (
                <TableSkeleton cols={2} />
              ) : (
                <>
                  {uncoveredQ.data?.data.map((u) => (
                    <Link
                      key={u.journey_id}
                      to={`/journeys/${u.journey_id}`}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-border-light last:border-0 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span className="text-table-cell text-text-primary font-medium">
                        {u.customer_name ?? 'Unknown customer'}
                      </span>
                      <span className="text-xs text-text-muted">
                        Scored {new Date(u.scored_at).toLocaleDateString('en-GB')}
                      </span>
                    </Link>
                  ))}
                  {s.missing_a_run > (uncoveredQ.data?.data.length ?? 0) && (
                    <p className="px-5 py-3 text-xs text-text-muted border-t border-border-light">
                      Showing the {uncoveredQ.data?.data.length} oldest of {s.missing_a_run}.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Trends */}
          <h3 className="font-heading text-heading-md text-text-primary mb-4">Trends</h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-7">
            <ChecksPerWeekChart
              points={trendsQ.data?.data}
              loading={trendsQ.isLoading}
              error={trendsQ.isError}
            />
            <MatchRateChart
              points={trendsQ.data?.data}
              loading={trendsQ.isLoading}
              error={trendsQ.isError}
            />
          </div>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
            <Panel
              title="By insurer"
              subtitle={`Checked sales and findings per question set, last ${days} days. A match rate needs a stored format, so the model-read row shows none.`}
            >
              {insurersQ.isError ? (
                <div className="px-5 py-4">
                  <ErrorBanner>Could not load the insurer breakdown.</ErrorBanner>
                </div>
              ) : insurersQ.isLoading ? (
                <TableSkeleton cols={4} />
              ) : !insurersQ.data?.data.length ? (
                <p className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No sales were checked in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px]">
                    <thead>
                      <tr>
                        <th className={TH}>Insurer</th>
                        <th className={TH}>Sales</th>
                        <th className={TH}>Match rate</th>
                        <th className={TH}>Findings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insurersQ.data.data.map((row) => (
                        <tr
                          key={`${row.profile_id ?? 'none'}-${row.insurer}-${row.product ?? ''}`}
                          className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors"
                        >
                          <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">
                            {row.profile_id ? (
                              <Link
                                to={`/data-forms/profiles/${row.profile_id}`}
                                className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
                              >
                                {row.insurer}
                              </Link>
                            ) : (
                              row.insurer
                            )}
                            {row.product && (
                              <span className="text-text-muted font-normal"> — {row.product}</span>
                            )}
                            <div className="text-xs text-text-muted mt-0.5">
                              {row.questions} question{row.questions === 1 ? '' : 's'} compared
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-table-cell text-text-cell font-mono">
                            {row.sales}
                          </td>
                          <td className="px-5 py-3.5">
                            <RateBar rate={row.match_rate} />
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex flex-wrap gap-1.5">
                              <CountPill n={row.mismatches} label="do not match" tone="fail" />
                              <CountPill n={row.not_asked} label="not asked" tone="fail" />
                              <CountPill n={row.missing} label="left blank" tone="fail" />
                              <CountPill n={row.withdrawn} label="withdrawn" tone="fail" />
                              <CountPill n={row.no_answer} label="no answer" tone="review" />
                              {row.mismatches +
                                row.not_asked +
                                row.missing +
                                row.withdrawn +
                                row.no_answer ===
                                0 && (
                                <span className="text-table-cell text-text-muted">None</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel
              title="Most flagged questions"
              subtitle="One question flagged on most sales is more often a parsing artefact than a whole team erring — check it before acting on it."
            >
              {questionsQ.isError ? (
                <div className="px-5 py-4">
                  <ErrorBanner>Could not load the flagged questions.</ErrorBanner>
                </div>
              ) : questionsQ.isLoading ? (
                <TableSkeleton cols={3} />
              ) : !questionsQ.data?.data.length ? (
                <p className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No question was flagged in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px]">
                    <thead>
                      <tr>
                        <th className={TH}>Question</th>
                        <th className={TH}>Flagged</th>
                        <th className={TH}>Breakdown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {questionsQ.data.data.map((q, i) => {
                        const key = `${q.insurer ?? 'none'}-${i}`;
                        const open = expanded === key;
                        return (
                          <Fragment key={key}>
                            <tr className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors">
                              <td className="px-5 py-3.5 text-table-cell text-text-cell max-w-[320px]">
                                <span className="line-clamp-2" title={q.question}>
                                  {q.question}
                                </span>
                                {q.insurer && (
                                  <div className="text-xs text-text-muted mt-0.5">{q.insurer}</div>
                                )}
                              </td>
                              <td className="px-5 py-3.5 text-table-cell font-mono whitespace-nowrap">
                                {q.sales.length > 0 ? (
                                  <button
                                    onClick={() => setExpanded(open ? null : key)}
                                    aria-expanded={open}
                                    className="inline-flex items-center gap-1 rounded-btn hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                  >
                                    <span className="text-fail font-semibold">{q.flagged}</span>
                                    <span className="text-text-muted">/ {q.compared}</span>
                                    <svg
                                      viewBox="0 0 24 24"
                                      className={`w-4 h-4 stroke-icon-muted transition-transform ${open ? 'rotate-180' : ''}`}
                                      fill="none"
                                      strokeWidth="1.8"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      aria-hidden="true"
                                    >
                                      <path d="M6 9l6 6 6-6" />
                                    </svg>
                                  </button>
                                ) : (
                                  <>
                                    <span className="text-fail font-semibold">{q.flagged}</span>
                                    <span className="text-text-muted"> / {q.compared}</span>
                                  </>
                                )}
                              </td>
                              <td className="px-5 py-3.5">
                                <div className="flex flex-wrap gap-1.5">
                                  <CountPill n={q.mismatches} label="do not match" tone="fail" />
                                  <CountPill n={q.not_asked} label="not asked" tone="fail" />
                                  <CountPill n={q.missing} label="left blank" tone="fail" />
                                  <CountPill n={q.no_answer} label="no answer" tone="review" />
                                </div>
                              </td>
                            </tr>
                            {open && (
                              <tr className="border-b border-border-light last:border-0">
                                <td colSpan={3} className="px-5 py-3 bg-table-header">
                                  <div className="text-xs text-text-muted mb-2">
                                    Flagged on{' '}
                                    {q.flagged > q.sales.length
                                      ? `these ${q.sales.length} of ${q.flagged} sales`
                                      : q.flagged === 1
                                        ? 'this sale'
                                        : 'these sales'}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    {q.sales.map((sale) => (
                                      <Link
                                        key={sale.journey_id}
                                        to={`/journeys/${sale.journey_id}`}
                                        className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-card border border-border text-text-cell hover:border-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                      >
                                        {sale.customer_name ?? 'Unknown customer'}
                                      </Link>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          {/* By adviser */}
          <div className="mb-5">
            <Panel
              title="By adviser"
              subtitle={`Sales closed in the last ${days} days, from checks read with a stored format only — a provisional reading should never be what someone is confronted with. Ordered by volume, not by findings.`}
            >
              {advisersQ.isError ? (
                <div className="px-5 py-4">
                  <ErrorBanner>Could not load the adviser breakdown.</ErrorBanner>
                </div>
              ) : advisersQ.isLoading ? (
                <TableSkeleton cols={4} />
              ) : !advisersQ.data?.data.length ? (
                <p className="px-5 py-12 text-center text-text-muted text-table-cell">
                  No sales were checked against a stored format in this period.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr>
                        <th className={TH}>Adviser</th>
                        <th className={TH}>Sales</th>
                        <th className={TH}>Match rate</th>
                        <th className={TH}>Findings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {advisersQ.data.data.map((a) => (
                        <tr
                          key={a.adviser_id}
                          className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors"
                        >
                          <td className="px-5 py-3.5 text-table-cell text-text-primary font-medium">
                            {a.adviser_name}
                            <div className="text-xs text-text-muted mt-0.5">
                              {a.questions} question{a.questions === 1 ? '' : 's'} compared
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-table-cell text-text-cell font-mono">
                            {a.sales}
                          </td>
                          <td className="px-5 py-3.5">
                            <RateBar rate={a.match_rate} />
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex flex-wrap gap-1.5">
                              <CountPill n={a.mismatches} label="do not match" tone="fail" />
                              <CountPill n={a.not_asked} label="not asked" tone="fail" />
                              <CountPill n={a.missing} label="left blank" tone="fail" />
                              <CountPill n={a.withdrawn} label="withdrawn" tone="fail" />
                              <CountPill n={a.no_answer} label="no answer" tone="review" />
                              {a.findings === 0 && (
                                <span className="text-table-cell text-text-muted">None</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          {/* Recent checks */}
          <Panel
            title="Recent checks"
            action={
              <Link
                to="/data-forms"
                className="text-table-cell text-primary font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
              >
                View all
              </Link>
            }
          >
            {recentQ.isError ? (
              <div className="px-5 py-4">
                <ErrorBanner>Could not load recent checks.</ErrorBanner>
              </div>
            ) : recentQ.isLoading ? (
              <TableSkeleton cols={4} />
            ) : !recentQ.data?.data.length ? (
              <p className="px-5 py-12 text-center text-text-muted text-table-cell">
                No sales have been checked yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr>
                      <th className={TH}>Sale</th>
                      <th className={TH}>Insurer</th>
                      <th className={TH}>Findings</th>
                      <th className={TH}>Status</th>
                      <th className={TH}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentQ.data.data.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors"
                      >
                        <td className="px-5 py-3.5">
                          <Link
                            to={`/journeys/${r.journey_id}`}
                            className="text-primary font-semibold text-table-cell hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn"
                          >
                            {r.customer_name ?? 'Unknown customer'}
                          </Link>
                          {r.total_questions > 0 && (
                            <div className="text-xs text-text-muted mt-0.5">
                              {r.total_questions} question{r.total_questions === 1 ? '' : 's'}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell">
                          {r.insurer ?? '--'}
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="flex flex-wrap gap-1.5">
                            <CountPill n={r.mismatches} label="do not match" tone="fail" />
                            <CountPill n={r.not_asked} label="not asked" tone="fail" />
                            <CountPill n={r.missing} label="left blank" tone="fail" />
                            <CountPill n={r.withdrawn} label="withdrawn" tone="fail" />
                            <CountPill n={r.no_answer} label="no answer" tone="review" />
                            {r.mismatches + r.not_asked + r.missing + r.withdrawn + r.no_answer ===
                              0 && (
                              <span className="text-table-cell text-text-muted">None</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className={`px-2.5 py-[3px] rounded-full text-badge font-semibold whitespace-nowrap ${RUN_STATUS[r.status].className}`}
                          >
                            {RUN_STATUS[r.status].label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell whitespace-nowrap">
                          {new Date(r.created_at).toLocaleDateString('en-GB')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <div className="px-5 py-4 space-y-3">
      {Array.from({ length: 4 }).map((_, r) => (
        <div key={r} className="flex gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? 'flex-[2]' : 'flex-1'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Charts
// ============================================================

const weekLabel = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

/**
 * Checking volume per week, split by whether the check actually landed.
 *
 * Stacked rather than two bars because the total is the meaningful quantity —
 * "sales that should have been checked" — and the split says how much of it we
 * got to. Only two segments, and the pair separates for every form of colour
 * blindness, so the legend plus the tooltip carry it without a third hue.
 */
function ChecksPerWeekChart({
  points,
  loading,
  error,
}: {
  points?: ReconciliationTrendPoint[];
  loading: boolean;
  error: boolean;
}) {
  const { grid, tick, primary, neutral } = useChartColors();
  const hasData = points?.some((p) => p.checked + p.unchecked > 0);

  return (
    <ChartCard title="Checks Per Week" subtitle={`Last ${TREND_WEEKS} weeks · completed highlighted`}>
      {error ? (
        <div className="h-[220px] flex items-center justify-center">
          <ErrorBanner>Could not load the trend.</ErrorBanner>
        </div>
      ) : loading ? (
        <Skeleton className="h-[220px] w-full" />
      ) : !hasData ? (
        <ChartEmpty message={`No sales reached a check in the last ${TREND_WEEKS} weeks`} />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
            <XAxis dataKey="week_start" tick={{ fontSize: 11, fill: tick }} tickFormatter={weekLabel} />
            <YAxis tick={{ fontSize: 11, fill: tick }} allowDecimals={false} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB')}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="checked" stackId="a" fill={primary} name="Checked" />
            {/* Covers parked, failed and summary_only alike — everything that
                did not end in a comparison, without claiming why. */}
            <Bar dataKey="unchecked" stackId="a" fill={neutral} name="Not checked" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}

/**
 * Match rate per week — a single series, so no legend: the title names it.
 *
 * Weeks with nothing conclusive come back null and Recharts breaks the line
 * there rather than drawing through the gap, which would invent a trend across
 * a week where nothing was checked.
 */
function MatchRateChart({
  points,
  loading,
  error,
}: {
  points?: ReconciliationTrendPoint[];
  loading: boolean;
  error: boolean;
}) {
  const { grid, tick, primary } = useChartColors();
  const hasData = points?.some((p) => p.match_rate != null);

  return (
    <ChartCard
      title="Match Rate Over Time"
      subtitle={`Weekly, over questions we could conclude on · stored formats only (last ${TREND_WEEKS} weeks)`}
    >
      {error ? (
        <div className="h-[220px] flex items-center justify-center">
          <ErrorBanner>Could not load the trend.</ErrorBanner>
        </div>
      ) : loading ? (
        <Skeleton className="h-[220px] w-full" />
      ) : !hasData ? (
        <ChartEmpty message="Not enough checked sales yet to show a rate" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} vertical={false} />
            <XAxis dataKey="week_start" tick={{ fontSize: 11, fill: tick }} tickFormatter={weekLabel} />
            <YAxis
              tick={{ fontSize: 11, fill: tick }}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              labelStyle={TOOLTIP_LABEL_STYLE}
              labelFormatter={(v) => `Week of ${new Date(v).toLocaleDateString('en-GB')}`}
              formatter={(val) => [`${Math.round(Number(val))}%`, 'Match rate']}
            />
            <Line
              type="monotone"
              dataKey="match_rate"
              stroke={primary}
              strokeWidth={2}
              dot={{ r: 3 }}
              connectNulls={false}
              name="Match rate"
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  );
}
