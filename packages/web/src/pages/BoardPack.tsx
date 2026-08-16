import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { SeverityBadge, StatusBadge } from '../components/BreachBadges';
import { RiskLevelBadge } from '../components/RiskLevelBadge';
import type { BoardPackResponse, BreachStatus, Product } from '@callguard/shared';

// ============================================================
// Small shared pieces (mirrors ComplianceDashboard.tsx's local helpers —
// there's no shared Skeleton/Panel/ErrorBanner component yet, see
// DESIGN_SYSTEM.md §9).
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
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-card overflow-hidden print:break-inside-avoid print:border-black/20">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-section-title text-text-primary">{title}</h3>
        {subtitle && <p className="text-xs text-text-subtle mt-0.5 leading-relaxed">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function StatTile({
  label,
  value,
  note,
  tone = 'default',
  loading,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'default' | 'fail' | 'review' | 'pass';
  loading: boolean;
}) {
  const valueColor =
    tone === 'fail' ? 'text-fail' : tone === 'review' ? 'text-review' : tone === 'pass' ? 'text-pass' : 'text-text-primary';
  return (
    <div className="bg-card border border-border rounded-card p-5 print:break-inside-avoid print:border-black/20">
      <span className="text-card-label uppercase text-text-muted">{label}</span>
      <div className={`text-card-value mt-2.5 ${valueColor}`}>
        {loading ? <Skeleton className="h-7 w-16" /> : value}
      </div>
      {!loading && note && <div className="text-xs mt-1 text-text-muted">{note}</div>}
    </div>
  );
}

const TH = 'text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border';
const TD = 'px-5 py-3.5 text-table-cell text-text-cell';
const ROW = 'border-b border-border-light last:border-0 print:break-inside-avoid';

function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-8 text-center text-text-muted text-table-cell">
        {children}
      </td>
    </tr>
  );
}

function fmtScore(n: number | null): string {
  return n == null ? '--' : `${n.toFixed(1)}%`;
}

function fmtPct(n: number | null): string {
  return n == null ? '--' : `${Math.round(n)}%`;
}

function fmtDelta(current: number | null, previous: number | null, suffix: string): { text: string; tone: 'pass' | 'fail' | 'default' } {
  if (current == null || previous == null) return { text: 'No prior-period figure to compare', tone: 'default' };
  const diff = current - previous;
  if (Math.abs(diff) < 0.05) return { text: `Flat vs previous period`, tone: 'default' };
  const sign = diff > 0 ? '+' : '';
  return {
    text: `${sign}${diff.toFixed(1)}${suffix} vs previous period`,
    tone: diff > 0 ? 'pass' : 'fail',
  };
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// Default window: the trailing 30 days, matching the app's other "last N
// days" defaults (dashboard summary, ComplianceDashboard).
function defaultPeriod(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

// ============================================================
// Page
// ============================================================

/**
 * A Consumer Duty board pack: evidence for a compliance committee or board to
 * sign off that the firm delivers good customer outcomes, for a chosen period
 * (and optionally one product). Reached from the Breaches and Compliance
 * Dashboard pages rather than the main nav — the nav's Compliance and Quality
 * sections are both already full (see commit history on Layout.tsx).
 *
 * Print/PDF treatment lives on this page itself (see the print-only header
 * below and the print: utility classes throughout) rather than as a separate
 * server-rendered document, because a board pack has to be filtered to a
 * period and product BEFORE it's printed — something a static HTML report
 * route can't do.
 */
export function BoardPack() {
  const { user } = useAuth();
  const [period, setPeriod] = useState(defaultPeriod);
  const [productId, setProductId] = useState('');

  const productsQ = useQuery({
    queryKey: ['board-pack-products'],
    queryFn: () => api.get<{ data: Product[] }>('/products'),
  });

  const params = new URLSearchParams({ from: period.from, to: period.to });
  if (productId) params.set('product', productId);

  const packQ = useQuery({
    queryKey: ['board-pack', period.from, period.to, productId],
    queryFn: () => api.get<BoardPackResponse>(`/board-pack?${params.toString()}`),
    enabled: !!period.from && !!period.to,
  });

  const p = packQ.data;
  const loading = packQ.isLoading;

  const handlePrint = () => window.print();

  return (
    <div>
      {/* ── Print-only header: firm name, period, generated date, confidentiality
          framing — visible only when this page is printed / saved as PDF, so
          the on-screen chrome above (controls, nav) never appears in the PDF. */}
      <div className="hidden print:block mb-6 pb-4 border-b-2 border-black/60 text-center">
        <div className="text-2xl font-bold text-text-primary">{p?.organization_name ?? user?.organization_name}</div>
        <div className="text-sm text-text-secondary mt-1">CallGuard AI — Consumer Duty Board Pack</div>
        <div className="text-sm text-text-secondary">
          {p ? `${p.period.from} to ${p.period.to}` : `${period.from} to ${period.to}`}
          {p?.product ? ` — ${p.product.name}` : ''}
        </div>
        <div className="inline-block mt-3 px-3 py-1 border border-black/40 text-xs font-semibold uppercase tracking-wider">
          Confidential — board / compliance committee use
        </div>
        <div className="text-xs text-text-muted mt-2">
          Generated {p ? new Date(p.generated_at).toLocaleString('en-GB') : new Date().toLocaleString('en-GB')}
        </div>
      </div>

      {/* ── Screen header + controls (hidden on print) ─────────────────── */}
      <div className="print:hidden flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <h2 className="text-page-title text-text-primary">Board Pack</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Consumer Duty evidence for a board or compliance committee sign-off, for a chosen period.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            <span className="text-xs font-medium text-text-muted mb-1">From</span>
            <input
              type="date"
              value={period.from}
              max={period.to}
              onChange={(e) => setPeriod((prev) => ({ ...prev, from: e.target.value }))}
              aria-label="Period start date"
              className="border border-border rounded-btn px-3 py-[7px] text-table-cell text-text-primary bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs font-medium text-text-muted mb-1">To</span>
            <input
              type="date"
              value={period.to}
              min={period.from}
              onChange={(e) => setPeriod((prev) => ({ ...prev, to: e.target.value }))}
              aria-label="Period end date"
              className="border border-border rounded-btn px-3 py-[7px] text-table-cell text-text-primary bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>
          {!!productsQ.data?.data.length && (
            <label className="flex flex-col">
              <span className="text-xs font-medium text-text-muted mb-1">Product</span>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                aria-label="Filter by product"
                className="border border-border rounded-btn px-3 py-[7px] text-table-cell text-text-primary bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <option value="">All products</option>
                {productsQ.data.data.map((prod) => (
                  <option key={prod.id} value={prod.id}>{prod.name}</option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={handlePrint}
            disabled={!p}
            className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary text-white hover:bg-primary-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      {packQ.isError && (
        <div className="print:hidden mb-5">
          <ErrorBanner>Could not load the board pack for this period.</ErrorBanner>
        </div>
      )}

      {p?.product_scope_note && (
        <div className="mb-6 bg-review-bg text-review px-4 py-3 rounded-card text-xs leading-relaxed print:break-inside-avoid">
          {p.product_scope_note}
        </div>
      )}

      {/* ── KPI tiles ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-7">
        <StatTile
          label="Calls ingested"
          value={loading ? '' : String(p?.coverage.calls_ingested ?? 0)}
          note="In this period"
          loading={loading}
        />
        <StatTile
          label="Calls scored"
          value={loading ? '' : String(p?.coverage.calls_scored ?? 0)}
          note={
            p && p.coverage.calls_ingested > 0
              ? `${Math.round((p.coverage.calls_scored / p.coverage.calls_ingested) * 100)}% of calls ingested`
              : undefined
          }
          tone={p && p.coverage.calls_ingested > p.coverage.calls_scored ? 'review' : 'pass'}
          loading={loading}
        />
        <StatTile
          label="Sales scored"
          value={loading ? '' : String(p?.coverage.sales_scored ?? 0)}
          note="In this period"
          loading={loading}
        />
        <StatTile
          label="Average score"
          value={loading ? '' : fmtScore(p?.outcomes.current.average_score ?? null)}
          note={p ? fmtDelta(p.outcomes.current.average_score, p.outcomes.previous.average_score, ' pts').text : undefined}
          tone={p ? fmtDelta(p.outcomes.current.average_score, p.outcomes.previous.average_score, ' pts').tone : 'default'}
          loading={loading}
        />
        <StatTile
          label="Pass rate"
          value={loading ? '' : fmtPct(p?.outcomes.current.pass_rate ?? null)}
          note={p ? fmtDelta(p.outcomes.current.pass_rate, p.outcomes.previous.pass_rate, ' pts').text : undefined}
          tone={p ? fmtDelta(p.outcomes.current.pass_rate, p.outcomes.previous.pass_rate, ' pts').tone : 'default'}
          loading={loading}
        />
        <StatTile
          label="Findings"
          value={loading ? '' : String(p?.findings_by_severity.reduce((sum, s) => sum + s.count, 0) ?? 0)}
          note="All severities, this period"
          tone={p && p.findings_by_severity.some((s) => s.severity === 'critical' && s.count > 0) ? 'fail' : 'default'}
          loading={loading}
        />
        <StatTile
          label="Confirmed by a human"
          value={loading ? '' : String(p?.human_oversight.breaches_confirmed_by_human ?? 0)}
          note="Findings a reviewer agreed are real"
          loading={loading}
        />
        <StatTile
          label="Advisers needing attention"
          value={loading ? '' : String(p?.advisers_needing_attention.length ?? 0)}
          note="Not compliant-rated"
          tone={p && p.advisers_needing_attention.length > 0 ? 'review' : 'pass'}
          loading={loading}
        />
      </div>

      <div className="space-y-6">
        {/* ── 1. Monitoring coverage ──────────────────────────────────── */}
        <Panel
          title="Monitoring coverage"
          subtitle="Evidence for the claim that every call and sale is reviewed — including what has not yet been scored."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border-light">
            <div>
              <div className="px-5 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wide">Calls</div>
              {loading ? (
                <div className="px-5 pb-4"><Skeleton className="h-16 w-full" /></div>
              ) : (
                <div className="px-5 pb-4 text-table-cell text-text-cell">
                  <div>{p?.coverage.calls_ingested ?? 0} ingested, {p?.coverage.calls_scored ?? 0} scored.</div>
                  {(p?.coverage.calls_not_scored_by_status.length ?? 0) > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-text-muted">
                      {p?.coverage.calls_not_scored_by_status.map((row) => (
                        <li key={row.status}>{row.count} {humanizeStatus(row.status)}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-2 text-xs text-pass">Nothing ingested in this period is unscored.</div>
                  )}
                </div>
              )}
            </div>
            <div>
              <div className="px-5 py-3 text-xs font-semibold text-text-secondary uppercase tracking-wide">Sales</div>
              {loading ? (
                <div className="px-5 pb-4"><Skeleton className="h-16 w-full" /></div>
              ) : (
                <div className="px-5 pb-4 text-table-cell text-text-cell">
                  <div>{p?.coverage.sales_scored ?? 0} scored.</div>
                  {(p?.coverage.sales_not_scored_by_status.length ?? 0) > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-text-muted">
                      {p?.coverage.sales_not_scored_by_status.map((row) => (
                        <li key={row.status}>{row.count} {humanizeStatus(row.status)}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-2 text-xs text-pass">No sale dated into this period is unscored.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* ── 2. Outcomes ──────────────────────────────────────────────── */}
        <Panel title="Outcomes" subtitle="Average score and pass rate, against the immediately preceding period of equal length.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr>
                  <th className={TH}>Period</th>
                  <th className={TH}>Scored units</th>
                  <th className={TH}>Average score</th>
                  <th className={TH}>Pass rate</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                ) : (
                  <>
                    <tr className={ROW}>
                      <td className={TD}>
                        <span className="font-semibold text-text-primary">This period</span>
                        <div className="text-xs text-text-muted">{p?.outcomes.current.period.from} to {p?.outcomes.current.period.to}</div>
                      </td>
                      <td className={`${TD} font-mono`}>{p?.outcomes.current.total_scored ?? 0}</td>
                      <td className={`${TD} font-mono`}>{fmtScore(p?.outcomes.current.average_score ?? null)}</td>
                      <td className={`${TD} font-mono`}>{fmtPct(p?.outcomes.current.pass_rate ?? null)}</td>
                    </tr>
                    <tr className={ROW}>
                      <td className={TD}>
                        <span className="text-text-secondary">Previous period</span>
                        <div className="text-xs text-text-muted">{p?.outcomes.previous.period.from} to {p?.outcomes.previous.period.to}</div>
                      </td>
                      <td className={`${TD} font-mono`}>{p?.outcomes.previous.total_scored ?? 0}</td>
                      <td className={`${TD} font-mono`}>{fmtScore(p?.outcomes.previous.average_score ?? null)}</td>
                      <td className={`${TD} font-mono`}>{fmtPct(p?.outcomes.previous.pass_rate ?? null)}</td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-4 border-t border-border">
            <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Score distribution, this period</div>
            {loading ? (
              <Skeleton className="h-8 w-full" />
            ) : !p?.outcomes.distribution.some((b) => b.count > 0) ? (
              <div className="text-table-cell text-text-muted">Nothing scored in this period.</div>
            ) : (
              <div className="grid grid-cols-5 gap-3">
                {p.outcomes.distribution.map((b) => (
                  <div key={b.band} className="text-center">
                    <div className="text-card-value text-text-primary font-mono">{b.count}</div>
                    <div className="text-xs text-text-muted mt-0.5">{b.band}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        {/* ── 3 & 4. Findings ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="Findings by severity">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr><th className={TH}>Severity</th><th className={TH}>Count</th></tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={2} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                  ) : !p?.findings_by_severity.length ? (
                    <EmptyRow colSpan={2}>No findings in this period.</EmptyRow>
                  ) : (
                    p.findings_by_severity.map((row) => (
                      <tr key={row.severity} className={ROW}>
                        <td className={TD}><SeverityBadge severity={row.severity} /></td>
                        <td className={`${TD} font-mono`}>{row.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Findings by theme"
            subtitle={p?.findings_by_theme.note ?? "Grouped by this firm's own scorecard sections, not an FCA or Consumer Duty outcomes taxonomy."}
          >
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr><th className={TH}>Section</th><th className={TH}>Count</th></tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={2} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                  ) : !p?.findings_by_theme.sections.length ? (
                    <EmptyRow colSpan={2}>No findings in this period.</EmptyRow>
                  ) : (
                    p.findings_by_theme.sections.map((row) => (
                      <tr key={row.section ?? 'none'} className={ROW}>
                        <td className={TD}>{row.section ?? <span className="text-text-muted">No section set</span>}</td>
                        <td className={`${TD} font-mono`}>{row.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>

        {/* ── 5. Human oversight ───────────────────────────────────────── */}
        <Panel title="Human oversight" subtitle="Where the AI declined to decide and a person did, and where a person overturned a confident AI verdict.">
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border-light">
                <div className="px-5 py-4">
                  <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Sales</div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <div className="text-card-value text-text-primary font-mono">{p?.human_oversight.journeys.total_resolved ?? 0}</div>
                      <div className="text-xs text-text-muted mt-0.5">Resolved</div>
                    </div>
                    <div>
                      <div className="text-card-value text-text-primary font-mono">{p?.human_oversight.journeys.ai_declined ?? 0}</div>
                      <div className="text-xs text-text-muted mt-0.5">AI declined to decide</div>
                    </div>
                    <div>
                      <div className="text-card-value text-text-primary font-mono">{p?.human_oversight.journeys.human_overturned ?? 0}</div>
                      <div className="text-xs text-text-muted mt-0.5">Human overturned AI</div>
                    </div>
                  </div>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Calls</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-card-value text-text-primary font-mono">{p?.human_oversight.calls.ai_declined_resolved ?? 0}</div>
                      <div className="text-xs text-text-muted mt-0.5">AI declined, resolved</div>
                    </div>
                    <div>
                      <div className="text-card-value text-text-primary font-mono">{p?.human_oversight.calls.human_overturned ?? 0}</div>
                      <div className="text-xs text-text-muted mt-0.5">Human overturned AI</div>
                    </div>
                  </div>
                  <p className="text-xs text-text-muted mt-3 leading-relaxed">{p?.human_oversight.calls.note}</p>
                </div>
              </div>
              <div className="px-5 py-4 border-t border-border flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-table-cell text-text-primary font-semibold">{p?.human_oversight.breaches_confirmed_by_human ?? 0}</span>
                  <span className="text-table-cell text-text-secondary"> breaches confirmed by a human reviewer this period</span>
                </div>
              </div>
              <div className="px-5 py-3 border-t border-border bg-review-bg text-review text-xs leading-relaxed">
                {p?.human_oversight.asymmetry_note}
              </div>
            </>
          )}
        </Panel>

        {/* ── 6. Advisers needing attention ────────────────────────────── */}
        <Panel title="Advisers needing attention" subtitle="Reuses the same risk classification as the Adviser Risk page, for this period only.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className={TH}>Adviser</th>
                  <th className={TH}>Critical</th>
                  <th className={TH}>High</th>
                  <th className={TH}>Medium</th>
                  <th className={TH}>Risk level</th>
                  <th className={TH}>Recommended action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="px-5 py-8"><Skeleton className="h-10 w-full" /></td></tr>
                ) : !p?.advisers_needing_attention.length ? (
                  <EmptyRow colSpan={6}>No adviser is rated above &ldquo;Compliant&rdquo; for this period.</EmptyRow>
                ) : (
                  p.advisers_needing_attention.map((row) => (
                    <tr key={row.agent_id} className={ROW}>
                      <td className={TD}>
                        <div className="font-medium text-text-primary">{row.agent_name}</div>
                        <div className="text-xs text-text-muted">{row.email}</div>
                      </td>
                      <td className={`${TD} font-mono`}>{row.critical}</td>
                      <td className={`${TD} font-mono`}>{row.high}</td>
                      <td className={`${TD} font-mono`}>{row.medium}</td>
                      <td className={TD}><RiskLevelBadge level={row.risk_level} /></td>
                      <td className={TD}>{row.recommended_action}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ── 7. Action taken ──────────────────────────────────────────── */}
        <Panel title="Action taken" subtitle="Where findings currently sit, and how long resolution has taken for those resolved in the period.">
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border-light">
            <div className="px-5 py-4">
              <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">By status</div>
              {loading ? (
                <Skeleton className="h-16 w-full" />
              ) : !p?.action_taken.by_status.length ? (
                <div className="text-table-cell text-text-muted">No findings in this period.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {p.action_taken.by_status.map((row) => (
                    <div key={row.status} className="flex items-center gap-1.5">
                      <StatusBadge status={row.status as BreachStatus} />
                      <span className="text-table-cell font-mono text-text-cell">{row.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="px-5 py-4">
              <div className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">Resolution time</div>
              {loading ? (
                <Skeleton className="h-16 w-full" />
              ) : !p?.action_taken.resolution_time.n ? (
                <div className="text-table-cell text-text-muted">Nothing was resolved in this period.</div>
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-card-value text-text-primary font-mono">{Math.round(p.action_taken.resolution_time.median_hours ?? 0)}h</div>
                    <div className="text-xs text-text-muted mt-0.5">Median</div>
                  </div>
                  <div>
                    <div className="text-card-value text-text-primary font-mono">{Math.round(p.action_taken.resolution_time.mean_hours ?? 0)}h</div>
                    <div className="text-xs text-text-muted mt-0.5">Mean</div>
                  </div>
                  <div>
                    <div className="text-card-value text-text-primary font-mono">{p.action_taken.resolution_time.n}</div>
                    <div className="text-xs text-text-muted mt-0.5">Resolved</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* ── Methodology & limitations ────────────────────────────────── */}
        <Panel title="Methodology and limitations" subtitle="Read alongside the figures above, not as small print.">
          {loading ? (
            <div className="p-5"><Skeleton className="h-24 w-full" /></div>
          ) : (
            <ul className="px-5 py-4 space-y-3 text-table-cell text-text-cell leading-relaxed list-disc list-outside ml-4">
              {p?.methodology.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
        </Panel>
      </div>

      {/* ── Print-only footer ───────────────────────────────────────────── */}
      <div className="hidden print:block mt-8 pt-3 border-t border-black/30 text-xs text-text-muted text-center">
        Generated by CallGuard AI on {p ? new Date(p.generated_at).toLocaleString('en-GB') : new Date().toLocaleString('en-GB')}.
        This document is confidential and intended solely for authorised board / compliance committee use.
      </div>

      {/* Print layout: A4, sensible margins, and no orphaned card/row/table
          fragments across a page break. The print: utility classes above
          (break-inside-avoid) do the per-element work; this covers what
          Tailwind has no utility for. */}
      <style>{`
        @media print {
          @page { size: A4; margin: 15mm 12mm; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; }
        }
      `}</style>

      <div className="print:hidden mt-6 text-xs text-text-muted">
        <Link to="/breaches" className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-btn">
          Back to Breach Register
        </Link>
      </div>
    </div>
  );
}
