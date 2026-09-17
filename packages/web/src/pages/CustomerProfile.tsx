import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { ActionMenu, type ActionMenuItem } from '../components/ActionMenu';
import { ReviewSection } from '../components/ReviewSection';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { FeedbackStatusBadge } from '../components/FeedbackStatusBadge';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { SeverityBadge } from '../components/BreachBadges';
import { formatDuration, formatPhone } from '../lib/format';
import { summariseCustomerCompliance, sumSeverities, severityBreakdown } from '@callguard/shared';
import type {
  CustomerCall,
  CustomerCompliance,
  CustomerProfileResponse,
  CustomerSale,
  CustomerSalePreview,
  CustomerScoringMode,
  ReconciliationRunStatus,
  SeverityCounts,
} from '@callguard/shared';

interface IdentityResponse {
  identity_id: string | null;
  members: Array<{ id: string; phone_normalized: string; name: string | null }>;
  history: Array<{
    action: 'linked' | 'unlinked';
    customer_id: string;
    actor_name: string | null;
    reason: string | null;
    created_at: string;
  }>;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

// Same words as the Reconciliation page's run statuses.
const RECONCILIATION_LABELS: Record<ReconciliationRunStatus, string> = {
  completed: 'Checked',
  running: 'Running',
  pending: 'Queued',
  needs_document: 'Waiting for document',
  needs_profile: 'Needs review',
  summary_only: 'No questions',
  failed: 'Failed',
  abandoned: 'Never checked',
  identity_mismatch: 'Wrong customer',
};

const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
const longDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? word : many}`;

/** Whole days since an ISO timestamp, floored, as the sales list counts them. */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  return Number.isNaN(then) ? null : Math.floor((Date.now() - then) / 86_400_000);
}

const linkClass =
  'text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded';
const secondaryBtn =
  'px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const primaryBtn =
  'px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary-ink text-on-solid hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const inputClass =
  'w-full px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary disabled:opacity-60 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const shimmer = {
  backgroundImage:
    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
};

function Skeleton({ className, width }: { className?: string; width?: string }) {
  return (
    <div
      className={`rounded bg-[length:800px_100%] animate-skeleton-shimmer ${className ?? 'h-4'}`}
      style={{ ...shimmer, width }}
    />
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/**
 * One person: where they stand, and every sale and call behind it.
 *
 * It used to open on six stat cards, a score-trend chart, and a green "Clean"
 * for anyone with no breaches — including the nine customers in ten nobody had
 * assessed — with a large "Score sale" button that could group the wrong calls
 * without saying which. Now it says in one sentence where the person stands,
 * lists their sales newest first with each sale's calls, findings and feedback,
 * keeps the calls no sale includes in one place, and asks before scoring calls
 * as a sale, showing exactly which calls it would group.
 */
export default function CustomerProfile() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { user } = useAuth();
  const role = user?.role ?? '';
  const isAdviser = role === 'adviser';
  const canAction = role === 'admin' || role === 'supervisor';
  const [editing, setEditing] = useState(false);
  const [confirmingSale, setConfirmingSale] = useState(false);

  // The list's query, carried in router state when the user came from it.
  const from = (location.state as { from?: unknown } | null)?.from;
  const backTo = { pathname: '/customers', search: typeof from === 'string' ? from : '' };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<CustomerProfileResponse>(`/customers/${id}`),
    enabled: !!id,
    // Follow a sale while it is being assembled or scored, then stop.
    refetchInterval: (query) =>
      query.state.data?.sales?.some((s) => s.status === 'pending' || s.status === 'scoring') ? 4000 : false,
  });

  const identity = useQuery({
    queryKey: ['customer-identity', id],
    queryFn: () => api.get<IdentityResponse>(`/customers/${id}/identity`),
    enabled: !!id && !!user && !isAdviser,
  });

  const back = (
    <Link
      to={backTo}
      className="inline-flex items-center gap-1.5 text-table-cell text-text-secondary hover:text-text-primary mb-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
    >
      <BackIcon />
      Customers
    </Link>
  );

  if (isLoading) {
    return (
      <div aria-busy="true" aria-label="Loading customer">
        {back}
        <Skeleton className="h-6" width="16rem" />
        <Skeleton className="h-4 mt-2.5" width="22rem" />
        <div className="bg-card border border-border rounded-card p-5 mt-5 mb-5">
          <Skeleton width="70%" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4">
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="bg-card border border-border rounded-card p-5 space-y-3">
                <Skeleton width="40%" />
                <Skeleton width="65%" />
              </div>
            ))}
          </div>
          <div className="bg-card border border-border rounded-card p-5 space-y-3">
            <Skeleton width="60%" />
            <Skeleton width="80%" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div>
        {back}
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block text-table-cell">
            Couldn't load this customer. They may have been removed, or you may not have access.
          </div>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => refetch()} className={secondaryBtn}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { customer, mode, stats, compliance, sales, calls, sale_preview: preview } = data;
  const scoreOnly = data.score_only;
  const phone = formatPhone(customer.phone_normalized);
  const named = Boolean(customer.name?.trim());

  const callSpan =
    stats.first_call_at && stats.last_call_at
      ? shortDate(stats.first_call_at) === shortDate(stats.last_call_at)
        ? shortDate(stats.first_call_at)
        : `${shortDate(stats.first_call_at)} – ${shortDate(stats.last_call_at)}`
      : null;

  const menuItems: ActionMenuItem[] = [];
  if (canAction) {
    menuItems.push({
      label: 'Edit details',
      hint: 'Name and CRM ID',
      onSelect: () => setEditing(true),
    });
  }
  // Only for a firm that scores sales, and not when the latest scored sale
  // already covers every call the trigger would group — pressing it then would
  // score nothing.
  if (canAction && mode === 'sales' && preview && !preview.covered_by_sale_id) {
    menuItems.push({
      label: 'Score calls as a sale…',
      disabled: Boolean(preview.in_flight_sale_id) || preview.calls.length === 0,
      hint: preview.in_flight_sale_id
        ? 'A sale for this customer is already being scored'
        : preview.calls.length === 0
          ? `No calls in the last ${preview.window_days} days`
          : `Groups ${plural(preview.calls.length, 'call')} and scores them together`,
      onSelect: () => setConfirmingSale(true),
    });
  }

  return (
    <div>
      {back}

      <div className="flex flex-wrap justify-between items-start gap-x-6 gap-y-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-page-title text-text-primary break-words">{named ? customer.name : phone}</h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-table-cell text-text-secondary">
            {[
              named ? <span key="phone" className="tabular-nums">{phone}</span> : null,
              customer.external_crm_id ? <span key="crm">CRM {customer.external_crm_id}</span> : null,
              stats.call_count > 0 ? (
                <span key="calls">
                  {isAdviser ? `${plural(stats.call_count, 'call')} with you` : plural(stats.call_count, 'call')}
                  {callSpan ? `, ${callSpan}` : ''}
                </span>
              ) : (
                <span key="calls">No calls yet</span>
              ),
              !isAdviser && stats.adviser_count > 0 ? <span key="advisers">{plural(stats.adviser_count, 'adviser')}</span> : null,
            ]
              .filter(Boolean)
              .flatMap((node, i) => (i === 0 ? [node] : [<span key={`sep-${i}`} aria-hidden="true">·</span>, node]))}
          </div>
        </div>
        {menuItems.length > 0 && <ActionMenu items={menuItems} label="More actions for this customer" />}
      </div>

      {compliance ? (
        <StatusSummary mode={mode} compliance={compliance} sales={sales ?? []} calls={calls} stats={stats} />
      ) : (
        <p className="bg-card border border-border rounded-card px-5 py-4 mb-5 text-table-cell text-text-secondary">
          {stats.call_count > 0
            ? `Your calls with this customer since ${longDate(stats.first_call_at)}.`
            : 'You have no calls with this customer.'}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
        <div className="min-w-0 space-y-3">
          {isAdviser ? (
            <CallList title="Your calls" calls={calls} emptyText="No calls with this customer." />
          ) : mode === 'sales' ? (
            <SalesTimeline sales={sales ?? []} calls={calls} scoreOnly={scoreOnly} reconciliation={data.reconciliation_enabled} canAction={canAction} />
          ) : (
            <CallsTimeline calls={calls} scoreOnly={scoreOnly} />
          )}
        </div>

        <aside className="space-y-4" aria-label="About this customer">
          {!isAdviser && <NumbersPanel customerId={customer.id} identity={identity} />}
          <section className="bg-card border border-border rounded-card p-5">
            <h3 className="text-section-title text-text-primary mb-3">Details</h3>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-table-cell">
              <dt className="text-text-secondary">CRM ID</dt>
              <dd className="text-text-primary break-words">{customer.external_crm_id ?? <span className="text-text-muted">None</span>}</dd>
              <dt className="text-text-secondary">First contact</dt>
              <dd className="text-text-primary">{longDate(stats.first_call_at ?? customer.first_seen_at)}</dd>
              <dt className="text-text-secondary">Last contact</dt>
              <dd className="text-text-primary">{longDate(stats.last_call_at ?? customer.last_seen_at)}</dd>
            </dl>
          </section>
        </aside>
      </div>

      {editing && (
        <EditDetailsModal
          customerId={customer.id}
          name={customer.name}
          crmId={customer.external_crm_id}
          onClose={() => setEditing(false)}
        />
      )}
      {confirmingSale && preview && (
        <ScoreAsSaleModal
          customerId={customer.id}
          preview={preview}
          onClose={() => setConfirmingSale(false)}
        />
      )}
    </div>
  );
}

// ── Where the person stands ───────────────────────────────────────────────────

function findingsPhrase(c: CustomerCompliance): string {
  const open = sumSeverities(c.open);
  if (open > 0) return `${plural(open, 'open finding')} (${severityBreakdown(c.open).replace(/ · /g, ', ')})`;
  const closed = sumSeverities(c.closed);
  if (closed === 0) return 'no findings';
  const closedWords = [c.resolved > 0 ? `${c.resolved} resolved` : null, c.noted > 0 ? `${c.noted} noted` : null]
    .filter(Boolean)
    .join(', ');
  return `no open findings (${closedWords}${c.closed.critical > 0 ? `, incl. ${c.closed.critical} critical` : ''})`;
}

const TONE_CLASS = {
  neutral: 'text-text-secondary',
  pass: 'text-pass',
  review: 'text-review',
  fail: 'text-fail',
} as const;

const TONE_ICON = {
  // A circle with a dash, like the N/A result: nothing looked at yet.
  neutral: 'M12 3a9 9 0 0 1 0 18M12 21a9 9 0 0 1 0-18M8 12h8',
  pass: 'M20 6 9 17l-5-5',
  review: 'M12 8v5M12 16.5v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  fail: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
} as const;

function StatusSummary({
  mode,
  compliance,
  sales,
  calls,
  stats,
}: {
  mode: CustomerScoringMode;
  compliance: CustomerCompliance;
  sales: CustomerSale[];
  calls: CustomerCall[];
  stats: CustomerProfileResponse['stats'];
}) {
  const summary = summariseCustomerCompliance(compliance, mode);
  const tone = TONE_CLASS[summary.tone];
  // The state itself is the one part of the sentence drawn in its tone, and
  // in words: colour only ever adds to them (DESIGN_SYSTEM §7).
  let before = '';
  let lead: string;
  let rest: string[] = [];

  if (summary.state === 'not_assessed') {
    const inFlight = sales.some((s) => s.status === 'pending' || s.status === 'scoring');
    lead = 'Not yet assessed:';
    rest = [
      stats.call_count > 0
        ? `${plural(stats.call_count, 'call')} with ${plural(stats.adviser_count, 'adviser')} since ${shortDate(stats.first_call_at)}.`
        : 'no calls yet.',
      mode === 'sales'
        ? inFlight
          ? 'A sale is being scored now.'
          : 'Calls are scored together when a sale arrives.'
        : 'None has been scored yet.',
    ];
  } else {
    let facts: Array<string | null>;
    if (mode === 'sales') {
      const scored = sales.filter((s) => s.status === 'scored');
      const latest = scored[0];
      const notFedBack = scored.filter((s) => s.feedback_status === 'not_fed_back').length;
      facts = [
        scored.length > 0
          ? `${plural(scored.length, 'sale')} scored`
          : compliance.scored_calls > 0
            ? `${plural(compliance.scored_calls, 'call')} scored on ${compliance.scored_calls === 1 ? 'its' : 'their'} own`
            : null,
        latest && latest.overall_score !== null ? `latest ${Math.floor(latest.overall_score)}% on ${shortDate(latest.sale_date)}` : null,
        notFedBack > 0 ? `${notFedBack} not fed back` : null,
      ];
    } else {
      const scored = calls.filter((c) => c.score);
      const latest = scored[0];
      const notFedBack = scored.filter((c) => c.feedback_status === 'not_fed_back').length;
      facts = [
        scored.length > 0 ? `${plural(scored.length, 'call')} scored` : null,
        latest?.score && latest.score.overall_score !== null
          ? `latest ${Math.floor(latest.score.overall_score)}% on ${shortDate(latest.called_at)}`
          : null,
        notFedBack > 0 ? `${notFedBack} not fed back` : null,
      ];
    }
    // "2 sales scored · latest 83% on 25 Aug · 1 not fed back · no open
    // findings (27 resolved, incl. 7 critical)"
    const present = facts.filter((f): f is string => Boolean(f));
    lead = findingsPhrase(compliance);
    if (present.length > 0) {
      const joined = present.join(' · ');
      before = `${joined.charAt(0).toUpperCase()}${joined.slice(1)} · `;
    } else {
      lead = lead.charAt(0).toUpperCase() + lead.slice(1);
    }
  }

  return (
    <section
      aria-label="Where this customer stands"
      className="bg-card border border-border rounded-card px-5 py-4 mb-5 flex items-start gap-3"
    >
      <svg
        className={`w-5 h-5 flex-none mt-px ${tone}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={TONE_ICON[summary.tone]} />
      </svg>
      <p className="text-table-cell text-text-primary">
        {before}
        <span className={`font-semibold ${tone}`}>{lead}</span>
        {rest.length > 0 && ` ${rest.join(' ')}`}
      </p>
    </section>
  );
}

// ── Timeline: a firm that scores sales ────────────────────────────────────────

function SalesTimeline({
  sales,
  calls,
  scoreOnly,
  reconciliation,
  canAction,
}: {
  sales: CustomerSale[];
  calls: CustomerCall[];
  scoreOnly: boolean;
  reconciliation: boolean;
  canAction: boolean;
}) {
  const unsold = calls.filter((c) => !c.in_sale);
  // Open by default when there is no sale to read first.
  const [unsoldOpen, setUnsoldOpen] = useState(sales.length === 0);

  return (
    <>
      {sales.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-5 text-table-cell text-text-secondary">
          No sale yet. A sale is scored when it arrives from your CRM
          {canAction ? ', or when you use Score calls as a sale from the More menu' : ''}.
        </div>
      ) : (
        sales.map((sale) => (
          <SaleCard key={sale.id} sale={sale} scoreOnly={scoreOnly} reconciliation={reconciliation} />
        ))
      )}

      {unsold.length > 0 && (
        <div className="bg-card border border-border rounded-card overflow-hidden">
          <ReviewSection
            id="calls-not-in-a-sale"
            title={`Calls not in a sale (${unsold.length})`}
            summary="Not scored: your firm scores calls as part of a sale."
            actionLabel="Show"
            open={unsoldOpen}
            onToggle={() => setUnsoldOpen((v) => !v)}
          >
            <CallRows calls={unsold} />
          </ReviewSection>
        </div>
      )}
    </>
  );
}

function SaleCard({ sale, scoreOnly, reconciliation }: { sale: CustomerSale; scoreOnly: boolean; reconciliation: boolean }) {
  const [open, setOpen] = useState(false);
  const scored = sale.status === 'scored';
  const verdict = scored && !scoreOnly && sale.pass !== null ? (sale.pass ? 'pass' : 'fail') : null;
  const openTotal = sumSeverities(sale.open);
  const closedTotal = sumSeverities(sale.closed);
  const others = Math.max(0, sale.adviser_count - 1);
  const bodyId = `sale-${sale.id}-calls`;

  return (
    <article className="bg-card border border-border rounded-card overflow-hidden" aria-labelledby={`sale-${sale.id}-title`}>
      <div className="px-5 py-4 flex flex-wrap justify-between items-start gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1.5">
          <h3 id={`sale-${sale.id}-title`} className="text-section-title text-text-primary">
            Sale on {longDate(sale.sale_date)}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {scored && sale.overall_score !== null && (
              <span className="text-lg font-semibold text-text-primary tabular-nums">
                {/* Rounded down, as on the sale page. */}
                {Math.floor(sale.overall_score)}%
              </span>
            )}
            {verdict && <ItemResultBadge result={verdict} />}
            {!scored && <JourneyStatusBadge status={sale.status} />}
            {scored && sale.feedback_status && (
              <FeedbackStatusBadge
                status={sale.feedback_status}
                waitingDays={
                  sale.feedback_status === 'awaiting_remediation'
                    ? sale.oldest_remediation_days
                    : daysSince(sale.feedback_sent_at)
                }
              />
            )}
          </div>
          <p className="text-table-cell text-text-secondary">
            {[
              sale.closing_adviser_name
                ? `Closed by ${sale.closing_adviser_name}${others > 0 ? ` (+${others} ${others === 1 ? 'other' : 'others'})` : ''}`
                : null,
              reconciliation && sale.reconciliation_status
                ? `Reconciliation: ${RECONCILIATION_LABELS[sale.reconciliation_status] ?? sale.reconciliation_status}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {scored && (
            <div className="flex flex-wrap items-center gap-1.5 text-table-cell text-text-secondary">
              {openTotal > 0 ? (
                <>
                  {SEVERITIES.filter((s) => sale.open[s] > 0).map((s) => (
                    <SeverityBadge key={s} severity={s} count={sale.open[s]} />
                  ))}
                  <span>open</span>
                  {closedTotal > 0 && <span>· {closedTotal} closed</span>}
                </>
              ) : closedTotal > 0 ? (
                <span>
                  No open findings ({closedTotal} closed{sale.closed.critical > 0 ? `, incl. ${sale.closed.critical} critical` : ''})
                </span>
              ) : (
                <span>No findings</span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link to={`/journeys/${sale.id}`} className={linkClass}>
            Open sale
          </Link>
          {scored && (
            <Link to={`/journeys/${sale.id}/claims-defence`} className={linkClass}>
              Claims-defence pack
            </Link>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center justify-between gap-3 px-5 py-3 border-t border-border-light text-left hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <span className="text-table-cell text-text-secondary">
          {plural(sale.calls.length, 'call')} in this sale
        </span>
        <span className="inline-flex items-center gap-1 text-table-cell font-semibold text-primary-ink whitespace-nowrap">
          {open ? 'Hide' : 'Show'}
          <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-t border-border-light">
          <CallRows calls={sale.calls} />
        </div>
      )}
    </article>
  );
}

/** A plain list of calls: date, adviser, length, closing-call marker, link. */
function CallRows({
  calls,
}: {
  calls: Array<{ id: string; called_at: string; adviser_name: string | null; duration_seconds: number | null; role?: 'wrap_up' | 'context' }>;
}) {
  if (calls.length === 0) {
    return <p className="px-5 py-4 text-table-cell text-text-muted">No calls.</p>;
  }
  return (
    <ul>
      {calls.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 border-b border-border-light last:border-0">
          <span className="text-table-cell text-text-cell tabular-nums whitespace-nowrap">{longDate(c.called_at)}</span>
          <span className="text-table-cell text-text-cell">{c.adviser_name ?? 'No adviser recorded'}</span>
          <span className="text-table-cell text-text-secondary tabular-nums">{formatDuration(c.duration_seconds)}</span>
          {c.role === 'wrap_up' && (
            <span className="px-2.5 py-[3px] rounded-full text-badge font-semibold bg-table-header text-text-secondary whitespace-nowrap">
              Closing call
            </span>
          )}
          <Link to={`/calls/${c.id}`} className={`ml-auto ${linkClass}`}>
            Open call
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CallList({ title, calls, emptyText }: { title: string; calls: CustomerCall[]; emptyText: string }) {
  return (
    <section className="bg-card border border-border rounded-card overflow-hidden">
      <h3 className="px-5 py-4 border-b border-border text-section-title text-text-primary">{title}</h3>
      {calls.length === 0 ? (
        <p className="px-5 py-8 text-center text-table-cell text-text-muted">{emptyText}</p>
      ) : (
        <CallRows calls={calls} />
      )}
    </section>
  );
}

// ── Timeline: a firm that scores calls ────────────────────────────────────────

function CallsTimeline({ calls, scoreOnly }: { calls: CustomerCall[]; scoreOnly: boolean }) {
  if (calls.length === 0) {
    return (
      <div className="bg-card border border-border rounded-card p-5 text-table-cell text-text-secondary">
        No calls with this customer yet.
      </div>
    );
  }
  return (
    <>
      {calls.map((c) => (
        <CallCard key={c.id} call={c} scoreOnly={scoreOnly} />
      ))}
    </>
  );
}

function CallCard({ call, scoreOnly }: { call: CustomerCall; scoreOnly: boolean }) {
  const score = call.score;
  const verdict = score && !scoreOnly && score.pass !== null ? (score.pass ? 'pass' : 'fail') : null;
  const open = call.open ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const closedTotal = call.closed ? sumSeverities(call.closed) : 0;
  const openTotal = sumSeverities(open);

  return (
    <article className="bg-card border border-border rounded-card px-5 py-4 flex flex-wrap justify-between items-start gap-x-4 gap-y-3">
      <div className="min-w-0 space-y-1.5">
        <h3 className="text-section-title text-text-primary">Call on {longDate(call.called_at)}</h3>
        <p className="text-table-cell text-text-secondary">
          {[call.adviser_name ?? 'No adviser recorded', formatDuration(call.duration_seconds)].join(' · ')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {score ? (
            <>
              {score.overall_score !== null && (
                <span className="text-lg font-semibold text-text-primary tabular-nums">{Math.floor(score.overall_score)}%</span>
              )}
              {verdict && <ItemResultBadge result={verdict} />}
              {call.feedback_status && (
                <FeedbackStatusBadge status={call.feedback_status} waitingDays={daysSince(call.feedback_sent_at)} />
              )}
            </>
          ) : (
            <span className="text-table-cell text-text-muted">
              {call.in_sale ? 'Part of a sale, scored with it' : 'Not scored'}
            </span>
          )}
        </div>
        {score && <FindingsLine open={open} openTotal={openTotal} closedTotal={closedTotal} />}
      </div>
      <Link to={`/calls/${call.id}`} className={linkClass}>
        Open call
      </Link>
    </article>
  );
}

function FindingsLine({ open, openTotal, closedTotal }: { open: SeverityCounts; openTotal: number; closedTotal: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-table-cell text-text-secondary">
      {openTotal > 0 ? (
        <>
          {SEVERITIES.filter((s) => open[s] > 0).map((s) => (
            <SeverityBadge key={s} severity={s} count={open[s]} />
          ))}
          <span>open</span>
          {closedTotal > 0 && <span>· {closedTotal} closed</span>}
        </>
      ) : closedTotal > 0 ? (
        <span>No open findings ({closedTotal} closed)</span>
      ) : (
        <span>No findings</span>
      )}
    </div>
  );
}

// ── Side column ───────────────────────────────────────────────────────────────

function NumbersPanel({
  customerId,
  identity,
}: {
  customerId: string;
  identity: { data?: IdentityResponse; isLoading: boolean; isError: boolean };
}) {
  const members = identity.data?.members ?? [];
  const history = identity.data?.history ?? [];
  const phoneOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    return m ? formatPhone(m.phone_normalized) : 'a number';
  };

  return (
    <section className="bg-card border border-border rounded-card p-5">
      <h3 className="text-section-title text-text-primary mb-3">Numbers for this person</h3>
      {identity.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading linked numbers">
          <Skeleton width="70%" />
          <Skeleton width="50%" />
        </div>
      ) : identity.isError ? (
        <p className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">Couldn't load linked numbers.</p>
      ) : members.length <= 1 ? (
        <p className="text-table-cell text-text-secondary">No other numbers are linked to this person.</p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <li key={m.id} className="text-table-cell">
              {m.id === customerId ? (
                <span className="text-text-primary tabular-nums">
                  {formatPhone(m.phone_normalized)} <span className="text-text-muted">(this profile)</span>
                </span>
              ) : (
                <Link to={`/customers/${m.id}`} className="text-primary-ink hover:underline tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded">
                  {formatPhone(m.phone_normalized)}
                </Link>
              )}
              {m.name && m.id !== customerId && <span className="block text-xs text-text-secondary">{m.name}</span>}
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <>
          <h4 className="text-table-header uppercase text-text-muted mt-4 mb-2">Link history</h4>
          <ul className="space-y-2">
            {history.map((h, i) => (
              <li key={`${h.customer_id}-${h.created_at}-${i}`} className="text-xs text-text-secondary">
                <span className="text-text-primary">{h.actor_name ?? 'Someone'}</span>{' '}
                {h.action === 'linked' ? 'linked' : 'unlinked'} {phoneOf(h.customer_id)} on {longDate(h.created_at)}
                {h.reason ? <span className="block text-text-muted">“{h.reason}”</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-xs text-text-muted mt-4">Numbers are linked as the same person by an administrator.</p>
    </section>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────

/**
 * Overlay and centred surface (DESIGN_SYSTEM §4 modal recipe) with the
 * accessibility §7 requires: labelled dialog, focus moved in and trapped, Escape
 * and a click outside close it, and focus returned to what opened it.
 */
function Modal({ titleId, title, onClose, busy, children }: { titleId: string; title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const surface = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const auto = surface.current?.querySelector<HTMLElement>('[data-autofocus]');
    (auto ?? surface.current)?.focus();
    return () => returnTo?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!busy) close.current();
      return;
    }
    if (e.key !== 'Tab' || !surface.current) return;
    const focusable = Array.from(
      surface.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea')
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === surface.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close.current();
      }}
    >
      <div
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative bg-card border border-border rounded-card shadow-lg w-full max-w-md p-6 space-y-4 max-h-[calc(100vh-2rem)] overflow-y-auto focus-visible:outline-none"
      >
        <h3 id={titleId} className="text-lg font-semibold text-text-primary">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

function EditDetailsModal({
  customerId,
  name,
  crmId,
  onClose,
}: {
  customerId: string;
  name: string | null;
  crmId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draftName, setDraftName] = useState(name ?? '');
  const [draftCrm, setDraftCrm] = useState(crmId ?? '');

  const save = useMutation({
    // Both fields are always sent: an empty one clears it (the API reads an
    // explicit empty string as "remove").
    mutationFn: () =>
      api.put(`/customers/${customerId}`, { name: draftName.trim(), external_crm_id: draftCrm.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
  });

  return (
    <Modal titleId="edit-customer-title" title="Edit details" onClose={onClose} busy={save.isPending}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <label htmlFor="customer-name" className="block text-xs font-medium text-text-muted mb-1">
            Name
          </label>
          <input
            id="customer-name"
            data-autofocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </div>
        <div>
          <label htmlFor="customer-crm" className="block text-xs font-medium text-text-muted mb-1">
            CRM ID
          </label>
          <input
            id="customer-crm"
            value={draftCrm}
            onChange={(e) => setDraftCrm(e.target.value)}
            className={inputClass}
            autoComplete="off"
          />
        </div>
        <p className="text-xs text-text-secondary">Leave a field empty to remove it. The change is recorded in the audit log.</p>
        {save.isError && (
          <p className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell" role="alert">
            Couldn't save{save.error instanceof Error ? `: ${save.error.message}` : ''}.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={save.isPending} className={secondaryBtn}>
            Cancel
          </button>
          <button type="submit" disabled={save.isPending} className={primaryBtn}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ScoreAsSaleModal({
  customerId,
  preview,
  onClose,
}: {
  customerId: string;
  preview: CustomerSalePreview;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { notify } = useDialog();
  const inOtherSale = preview.calls.filter((c) => c.sale_id).length;
  const toFetch = preview.calls.filter((c) => c.status === 'captured').length;

  const trigger = useMutation({
    mutationFn: () => api.post<{ journey_id?: string; message?: string }>('/journeys/trigger', { customer_id: customerId }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
      // The endpoint is idempotent and says which way it went; always pass that on.
      if (res.message) void notify(res.message);
    },
  });

  return (
    <Modal titleId="score-sale-title" title="Score these calls as one sale?" onClose={onClose} busy={trigger.isPending}>
      <p className="text-table-cell text-text-secondary">
        {plural(preview.calls.length, 'call')} from the last {preview.window_days} days will be grouped into one sale
        and scored together against your scorecard.
      </p>
      <ul className="border border-border rounded-btn divide-y divide-border-light max-h-64 overflow-y-auto">
        {preview.calls.map((c) => (
          <li key={c.id} className="px-3 py-2 text-table-cell">
            <span className="flex flex-wrap gap-x-2">
              <span className="text-text-primary tabular-nums">{longDate(c.called_at)}</span>
              <span className="text-text-cell">{c.adviser_name ?? 'No adviser recorded'}</span>
              <span className="text-text-secondary tabular-nums">{formatDuration(c.duration_seconds)}</span>
            </span>
            {(c.sale_id || c.from_linked_number || c.status === 'captured') && (
              <span className="block text-xs text-text-secondary mt-0.5">
                {[
                  c.sale_id ? 'Already in a sale' : null,
                  c.from_linked_number ? 'From a linked number' : null,
                  c.status === 'captured' ? 'Recording not downloaded yet' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="text-table-cell text-text-secondary space-y-2">
        <p className="font-semibold text-text-primary">What happens next</p>
        {toFetch > 0 && (
          <p>
            {plural(toFetch, 'recording')} will be downloaded and transcribed first. The sale is scored once{' '}
            {toFetch === 1 ? 'it is' : 'they are'} ready.
          </p>
        )}
        {inOtherSale > 0 && (
          <p>
            {plural(inOtherSale, 'call')} {inOtherSale === 1 ? 'is' : 'are'} already part of a sale and will be included
            in this one too.
          </p>
        )}
        <p>Scoring runs in the background, and the new sale appears on this page when it's done. Only an administrator can re-score a sale afterwards.</p>
      </div>
      {trigger.isError && (
        <p className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell" role="alert">
          Couldn't start scoring{trigger.error instanceof Error ? `: ${trigger.error.message}` : ''}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={trigger.isPending} className={secondaryBtn} data-autofocus>
          Cancel
        </button>
        <button type="button" onClick={() => trigger.mutate()} disabled={trigger.isPending} className={primaryBtn}>
          {trigger.isPending ? 'Starting…' : 'Score as a sale'}
        </button>
      </div>
    </Modal>
  );
}
