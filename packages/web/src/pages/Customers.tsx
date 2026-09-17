import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { hasFeature } from '@callguard/shared';
import type {
  CustomerListResponse,
  CustomerListRow,
  CustomerListSort,
  CustomerListTab,
  CustomerScoringMode,
} from '@callguard/shared';
import { formatPhone } from '../lib/format';
import { JourneyStatusBadge } from '../components/JourneyStatusBadge';
import { FeedbackStatusBadge } from '../components/FeedbackStatusBadge';
import { ItemResultBadge } from '../components/ItemResultBadge';
import { SeverityBadge } from '../components/BreachBadges';

const PAGE_SIZE = 50;

const TAB_LABELS: Record<CustomerListTab, string> = {
  all: 'All',
  scored: 'Scored sale',
  assessed: 'Assessed',
  open_findings: 'Open findings',
  not_fed_back: 'Not fed back',
  no_sale: 'No sale yet',
  not_assessed: 'Not yet assessed',
};

// Said when a tab has nobody in it and no search is narrowing it — so an empty
// "Open findings" tab never reads like a broken page.
const EMPTY_TAB: Record<CustomerListTab, string> = {
  all: 'No customers yet. They appear when calls with a customer phone number come in.',
  scored: 'No customer has a scored sale yet.',
  assessed: 'No customer has an assessed call yet.',
  open_findings: 'No customer has an open finding.',
  not_fed_back: 'Nobody is waiting for feedback on their latest scored result.',
  no_sale: 'Every customer has a sale.',
  not_assessed: 'Every customer has at least one assessed call.',
};

const SORTS: Array<{ value: CustomerListSort; label: string; needsResults?: boolean }> = [
  { value: 'last_contact', label: 'Last contact' },
  { value: 'most_calls', label: 'Most calls' },
  { value: 'lowest_score', label: 'Lowest latest score', needsResults: true },
];

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const nf = (n: number) => n.toLocaleString('en-GB');
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

const shimmer = {
  backgroundImage:
    'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
};

/**
 * Everyone the firm has spoken to, and what came of it.
 *
 * It used to say "3,391 customers tracked" over a table where nine rows in ten
 * read "Awaiting sale", with no way to find the people who needed something
 * done. Now the tabs are the questions a reviewer asks (who has a scored sale,
 * who has open findings, who hasn't been fed back), each row carries its latest
 * result and open findings, and the list's state lives in the address so Back
 * from a profile returns to the same place.
 */
export default function Customers() {
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const navigate = useNavigate();
  const location = useLocation();
  const isAdviser = user?.role === 'adviser';
  const enabled = hasFeature(user?.organization_plan ?? null, 'customer_journey');

  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'all') as CustomerListTab;
  const q = params.get('q') ?? '';
  const sort = (params.get('sort') ?? 'last_contact') as CustomerListSort;
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Typing is local; the address (and so the request) follows once it settles.
  const [searchDraft, setSearchDraft] = useState(q);
  useEffect(() => setSearchDraft(q), [q]);
  useEffect(() => {
    if (searchDraft.trim() === q) return;
    const t = setTimeout(() => update({ q: searchDraft.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  /** Change the list's state. Anything but the page itself goes back to page 1. */
  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      const isDefault = (key === 'tab' && value === 'all') || (key === 'sort' && value === 'last_contact');
      if (value === null || value === '' || isDefault) next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    // Typing replaces the history entry rather than adding one per keystroke.
    setParams(next, { replace: 'q' in changes });
  }

  const request = useMemo(() => {
    const r = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (tab !== 'all') r.set('tab', tab);
    if (q) r.set('q', q);
    if (sort !== 'last_contact') r.set('sort', sort);
    return r.toString();
  }, [page, tab, q, sort]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['customers', request],
    queryFn: () => api.get<CustomerListResponse>(`/customers?${request}`),
    placeholderData: keepPreviousData,
    enabled,
  });

  if (!enabled) {
    return (
      <div className="bg-card border border-border rounded-card p-8 text-center max-w-md mx-auto">
        <p className="text-text-subtle text-table-cell mb-2">Customer tracking is available on the Core plan and above.</p>
        {user?.role === 'admin' && (
          <Link to="/settings/organization" className="text-primary-ink font-medium hover:underline text-table-cell focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">Upgrade plan</Link>
        )}
      </div>
    );
  }

  const mode: CustomerScoringMode | null = data?.mode ?? null;
  const tabs = data?.tabs ?? [];
  const showResults = !isAdviser;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const firstShown = data && data.total > 0 ? (page - 1) * data.limit + 1 : 0;
  const lastShown = data ? Math.min(page * data.limit, data.total) : 0;
  const rows = data?.data ?? [];

  // "3,391 people · 232 with a scored sale", under the current search.
  const people = data?.counts.all ?? 0;
  const withResult = mode === 'sales' ? data?.counts.scored : data?.counts.assessed;
  const subtitle = !data
    ? ' '
    : [
        q ? `${nf(people)} matching “${q}”` : `${nf(people)} ${people === 1 ? 'person' : 'people'}`,
        showResults && withResult !== undefined
          ? `${nf(withResult)} with ${mode === 'sales' ? 'a scored sale' : 'an assessed call'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');

  // Opening a profile carries the list's query with it, so the profile's back
  // link can restore it even when reached by a fresh load.
  const profileState = { from: location.search };
  const open = (row: CustomerListRow) => navigate(`/customers/${row.id}`, { state: profileState });

  const columns = showResults
    ? ['Customer', 'Latest result', 'Open findings', 'Feedback', 'Calls', 'Last adviser']
    : ['Customer', 'Calls', 'Last adviser'];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h2 className="text-page-title text-text-primary">Customers</h2>
          <p className="text-page-sub text-text-subtle mt-1" aria-live="polite">{subtitle}</p>
        </div>
      </div>

      {/* The questions a reviewer works along, each counted under the search.
          Same recipe as the Sales list. An adviser has only "All". */}
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Show customers">
          {tabs.map((t) => {
            const n = data?.counts[t];
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => update({ tab: t })}
                aria-pressed={active}
                className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  active ? 'bg-primary-ink text-on-solid' : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                }`}
              >
                {TAB_LABELS[t]}
                {n !== undefined && (
                  <span className={`ml-1.5 tabular-nums ${active ? 'opacity-80' : 'text-text-muted'}`}>{nf(n)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-border">
          <label className="flex items-center gap-2 flex-1 min-w-[220px] sm:max-w-sm px-3 min-h-[38px] rounded-btn border border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <svg className="w-4 h-4 text-text-secondary flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">Search by name, phone number or CRM ID</span>
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search name, phone or CRM ID"
              maxLength={100}
              className="min-w-0 flex-1 bg-transparent text-table-cell text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>

          <label className="flex items-center gap-2 text-table-cell text-text-secondary">
            Sort
            <select
              value={sort}
              onChange={(e) => update({ sort: e.target.value })}
              className="min-h-[38px] px-3 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {SORTS.filter((s) => showResults || !s.needsResults).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <span className="sm:ml-auto text-table-cell text-text-secondary tabular-nums" aria-live="polite">
            {data
              ? data.total === 0
                ? ''
                : `${nf(firstShown)}–${nf(lastShown)} of ${nf(data.total)}`
              : ''}
            {isFetching && data ? <span className="sr-only"> Updating</span> : null}
          </span>
        </div>

        {isError ? (
          <div className="px-5 py-6 flex flex-wrap items-center gap-3">
            <span className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">Couldn't load customers.</span>
            <button
              type="button"
              onClick={() => refetch()}
              className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Try again
            </button>
            {/* A saved link can carry a tab this firm doesn't have, which the
                API refuses; give a way out that doesn't need the tabs. */}
            {params.toString() !== '' && (
              <button
                type="button"
                onClick={() => {
                  setSearchDraft('');
                  setParams(new URLSearchParams());
                }}
                className="text-table-cell text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                Show all customers
              </button>
            )}
          </div>
        ) : isLoading ? (
          <div aria-busy="true" aria-label="Loading customers">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 px-5 py-4 border-b border-border-light last:border-0">
                {['26%', '16%', '12%', '12%', '10%'].map((w, j) => (
                  <div
                    key={j}
                    className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                    style={{ ...shimmer, width: w }}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 py-12 text-center text-text-muted text-table-cell">
            {q ? (
              <>
                No customers match “{q}”
                {tab !== 'all' ? ` in ${TAB_LABELS[tab]}` : ''}.{' '}
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft('');
                    update({ q: null });
                  }}
                  className="text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                >
                  Clear search
                </button>
              </>
            ) : (
              EMPTY_TAB[tab] ?? EMPTY_TAB.all
            )}
          </div>
        ) : (
          <>
            {/* Wide screens: one line per person. */}
            {/* Scrolls rather than clips on a tablet, where six columns can
                outgrow the card; `relative` keeps anything absolutely positioned
                inside it within the scroll box. */}
            <div className="hidden sm:block relative overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  {columns.map((h) => (
                    <th key={h} scope="col" className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => open(row)}
                    className="hover:bg-table-header focus-within:bg-table-header transition-colors cursor-pointer border-b border-border-light last:border-0"
                  >
                    <td className="px-5 py-3 min-w-0">
                      <Who row={row} state={profileState} />
                    </td>
                    {showResults && (
                      <>
                        <td className="px-5 py-3">
                          <LatestResult row={row} mode={mode!} scoreOnly={scoreOnly} />
                        </td>
                        <td className="px-5 py-3">
                          <OpenFindings row={row} />
                        </td>
                        <td className="px-5 py-3">
                          {row.feedback_status && <FeedbackStatusBadge status={row.feedback_status} />}
                        </td>
                      </>
                    )}
                    <td className="px-5 py-3 text-table-cell text-text-cell whitespace-nowrap tabular-nums">
                      {nf(row.call_count)}
                      {row.last_call_at && <span className="text-text-secondary"> · last {shortDate(row.last_call_at)}</span>}
                    </td>
                    <td className="px-5 py-3 text-table-cell text-text-cell">{row.last_adviser_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Phones: each person as a two-line card, no sideways scrolling. */}
            <ul className="sm:hidden">
              {rows.map((row) => (
                <li
                  key={row.id}
                  onClick={() => open(row)}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 border-b border-border-light last:border-0 cursor-pointer active:bg-table-header"
                >
                  <Who row={row} state={profileState} />
                  {showResults && (
                    <div className="self-start text-right">
                      <LatestResult row={row} mode={mode!} scoreOnly={scoreOnly} align="end" />
                    </div>
                  )}
                  <p className="col-span-2 text-xs text-text-secondary truncate tabular-nums">
                    {[
                      `${nf(row.call_count)} ${row.call_count === 1 ? 'call' : 'calls'}`,
                      row.last_call_at ? `last ${shortDate(row.last_call_at)}` : null,
                      row.last_adviser_name,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}

        {data && totalPages > 1 && (
          <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-border bg-table-header">
            <button
              type="button"
              onClick={() => update({ page: String(page - 1) })}
              disabled={page <= 1}
              className="min-h-[32px] px-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
            >
              Previous
            </button>
            <span className="text-table-cell text-text-muted tabular-nums">
              {nf(firstShown)}–{nf(lastShown)} of {nf(data.total)}
            </span>
            <button
              type="button"
              onClick={() => update({ page: String(page + 1) })}
              disabled={page >= totalPages}
              className="min-h-[32px] px-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The person: their name, or their number where no name is on file. */
function Who({ row, state }: { row: CustomerListRow; state: { from: string } }) {
  const named = Boolean(row.name?.trim());
  const phone = formatPhone(row.phone_normalized);
  return (
    <div className="min-w-0">
      <Link
        to={`/customers/${row.id}`}
        state={state}
        onClick={(e) => e.stopPropagation()}
        className="block truncate text-table-cell font-semibold text-text-primary hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        {named ? row.name : phone}
      </Link>
      {named && <span className="block truncate text-xs text-text-secondary tabular-nums">{phone}</span>}
      {row.external_crm_id && (
        <span className="block truncate text-xs text-text-muted">CRM {row.external_crm_id}</span>
      )}
    </div>
  );
}

/**
 * The latest sale (a firm that scores sales) or the latest scored call (a firm
 * that scores calls). The verdict is left out where the firm hides it.
 */
function LatestResult({
  row,
  mode,
  scoreOnly,
  align = 'start',
}: {
  row: CustomerListRow;
  mode: CustomerScoringMode;
  scoreOnly: boolean;
  align?: 'start' | 'end';
}) {
  const latest = row.latest;
  if (!latest) return <span className="text-table-cell text-text-muted">Not yet assessed</span>;
  const scored = latest.status === 'scored';
  const verdict = scored && !scoreOnly && latest.pass !== null ? (latest.pass ? 'pass' : 'fail') : null;
  return (
    <span className={`flex flex-col gap-0.5 ${align === 'end' ? 'items-end' : 'items-start'}`}>
      <span className="inline-flex items-center gap-2">
        {scored && latest.overall_score !== null && (
          <span className="text-table-cell font-semibold text-text-primary tabular-nums">
            {/* Rounded down, as on the sale page: 69.6 beside a 70% pass mark must not read "70%". */}
            {Math.floor(latest.overall_score)}%
          </span>
        )}
        {verdict ? <ItemResultBadge result={verdict} /> : !scored || latest.overall_score === null ? <JourneyStatusBadge status={latest.status} /> : null}
      </span>
      <span className="text-xs text-text-secondary whitespace-nowrap">
        {mode === 'sales' ? 'Sale' : 'Call'} {shortDate(latest.date)}
      </span>
    </span>
  );
}

function OpenFindings({ row }: { row: CustomerListRow }) {
  const counts = row.open_findings;
  const present = counts ? SEVERITIES.filter((s) => counts[s] > 0) : [];
  if (!counts || present.length === 0) return <span className="text-table-cell text-text-muted">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {present.map((s) => (
        <SeverityBadge key={s} severity={s} count={counts[s]} />
      ))}
    </span>
  );
}
