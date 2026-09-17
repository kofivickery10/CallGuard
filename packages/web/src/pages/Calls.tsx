import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { AgentFilter } from '../components/AgentFilter';
import { SaleArrivalBanner } from '../components/SaleArrivalBanner';
import { formatDuration, formatPhone } from '../lib/format';
import type { CallAdviserOption, CallListResponse, CallListRow } from '@callguard/shared';

type Mode = CallListResponse['mode'];

// The tabs each kind of firm works along. A firm that scores sales has no
// per-call verdict to filter on — most of its calls never join a sale, by
// design — so its tabs ask whether a call is part of one. A firm that scores
// calls filters on the call's own result. Keys match GET /api/calls `tab`.
const TABS: Record<Mode, Array<{ key: string; label: string; verdict?: boolean }>> = {
  sales: [
    { key: 'all', label: 'All calls' },
    { key: 'in_sale', label: 'In a sale' },
    { key: 'not_in_sale', label: 'Not in a sale' },
    { key: 'processing', label: 'Processing' },
    { key: 'failed', label: "Couldn't process" },
  ],
  calls: [
    { key: 'all', label: 'All calls' },
    { key: 'attention', label: 'Needs attention' },
    { key: 'failed_checks', label: 'Failed', verdict: true },
    { key: 'passed', label: 'Passed', verdict: true },
    { key: 'processing', label: 'Processing' },
    { key: 'failed', label: "Couldn't process" },
  ],
};

const RANGES = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
] as const;

const PAGE_SIZE = 20;
const PROCESSING = new Set(['uploaded', 'transcribing', 'scoring']);

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** from/to for a range chip, as the API's inclusive calendar dates. */
function rangeDates(range: string): { from?: string; to?: string } {
  if (range === 'all') return {};
  const today = new Date();
  const from = new Date(today);
  if (range === '7') from.setDate(today.getDate() - 6);
  if (range === '30') from.setDate(today.getDate() - 29);
  return { from: isoDay(from), to: isoDay(today) };
}

/** "Today", "Yesterday", else "Mon 15 Sept 2026". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isoDay(d) === isoDay(today)) return 'Today';
  if (isoDay(d) === isoDay(yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Every call from the firm's dialler, named by who it was with and showing what
 * came of it.
 *
 * It used to be a table of dialler file names with a status dropdown. For a
 * firm that scores sales, nine calls in ten read "Awaiting sale" with no score,
 * the calls that were part of a scored sale read "Transcribed", and the
 * "Scored" filter was always empty — the page hid every compliance fact it had.
 * Now a call in a sale shows that sale's result and what failed on this call; a
 * call scored on its own shows its own. Filters live in the address, so Back
 * from a call returns to the same list.
 */
export function Calls() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const scoreOnly = useScoreOnly();
  const role = user?.role ?? '';
  const canUpload = ['admin', 'supervisor', 'adviser'].includes(role);
  // Who can act on sales not arriving — the same roles the endpoint allows.
  const canScoreSales = ['admin', 'supervisor'].includes(role);
  // Advisers only ever see their own calls, so an adviser filter means nothing to them.
  const canFilterAdviser = ['admin', 'supervisor', 'viewer'].includes(role);

  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'all';
  const q = params.get('q') ?? '';
  const adviser = params.get('adviser');
  const range = params.get('range') ?? 'all';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Typing is local; the address (and so the request) follows once it settles.
  const [searchDraft, setSearchDraft] = useState(q);
  useEffect(() => setSearchDraft(q), [q]);
  useEffect(() => {
    if (searchDraft === q) return;
    const t = setTimeout(() => update({ q: searchDraft.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  /** Change filters. Anything but the page itself sends you back to page 1. */
  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '' || (key === 'tab' && value === 'all') || (key === 'range' && value === 'all')) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: 'q' in changes });
  }

  const request = useMemo(() => {
    const r = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (tab !== 'all') r.set('tab', tab);
    if (q) r.set('q', q);
    if (adviser && canFilterAdviser) r.set('adviser', adviser);
    const { from, to } = rangeDates(range);
    if (from) r.set('from', from);
    if (to) r.set('to', to);
    return r.toString();
  }, [page, tab, q, adviser, range, canFilterAdviser]);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['calls', request],
    queryFn: () => api.get<CallListResponse>(`/calls?${request}`),
    placeholderData: keepPreviousData,
    // Follow calls that are still being processed, and stop once none are.
    refetchInterval: (query) =>
      query.state.data?.data.some((c) => PROCESSING.has(c.status)) ? 5000 : false,
  });

  const { data: advisers } = useQuery({
    queryKey: ['call-advisers'],
    queryFn: () => api.get<{ data: CallAdviserOption[] }>('/calls/advisers'),
    enabled: canFilterAdviser,
    staleTime: 5 * 60_000,
  });

  const mode: Mode | null = data?.mode ?? null;
  const tabs = mode ? TABS[mode].filter((t) => !(t.verdict && scoreOnly)) : [];
  const filtered = Boolean(q || adviser || range !== 'all');
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const firstShown = data && data.total > 0 ? (page - 1) * data.limit + 1 : 0;
  const lastShown = data ? Math.min(page * data.limit, data.total) : 0;

  // Rows grouped by the day they happened on, in the order the API sent them.
  const groups = useMemo(() => {
    const out: Array<{ day: string; rows: CallListRow[] }> = [];
    for (const row of data?.data ?? []) {
      const day = dayLabel(row.called_at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(row);
      else out.push({ day, rows: [row] });
    }
    return out;
  }, [data]);

  const open = (row: CallListRow) => navigate(`/calls/${row.id}`);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h2 className="text-page-title text-text-primary">Calls</h2>
          <p className="text-page-sub text-text-subtle mt-1 max-w-prose">
            {mode === 'sales'
              ? 'Every call from your dialler. Your firm scores sales, so a call is scored as part of the sale it belongs to.'
              : mode === 'calls'
                ? 'Every call from your dialler, each scored on its own against your scorecard.'
                : 'Every call from your dialler.'}
          </p>
        </div>
        {canUpload && (
          <Link
            to="/calls/upload"
            className="inline-flex items-center gap-2 px-[18px] py-[9px] rounded-btn border border-border bg-card text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 whitespace-nowrap"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3" />
            </svg>
            Upload a call
          </Link>
        )}
      </div>

      <SaleArrivalBanner enabled={canScoreSales} />

      {/* The axis a reviewer works along: what came of the call. Same recipe as
          the Sales list, each count under every other active filter. */}
      <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Show calls">
        {tabs.map((t) => {
          const n = data?.counts[t.key];
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => update({ tab: t.key })}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-btn text-table-cell font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                active ? 'bg-primary-ink text-on-solid' : 'border border-border text-text-secondary hover:bg-sidebar-hover'
              }`}
            >
              {t.label}
              {n !== undefined && (
                <span className={`ml-1.5 tabular-nums ${active ? 'opacity-80' : 'text-text-muted'}`}>
                  {n.toLocaleString('en-GB')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-border">
          <label className="flex items-center gap-2 flex-1 min-w-[220px] sm:max-w-sm px-3 min-h-[38px] rounded-btn border border-border focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
            <svg className="w-4 h-4 text-text-secondary flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
            <span className="sr-only">Search by customer name or phone number</span>
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search customer or phone"
              maxLength={100}
              className="min-w-0 flex-1 bg-transparent text-table-cell text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>

          {canFilterAdviser && (
            <AgentFilter
              value={adviser}
              onChange={(v) => update({ adviser: v })}
              options={advisers?.data ?? []}
            />
          )}

          <div className="inline-flex rounded-btn border border-border p-0.5" role="group" aria-label="When">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => update({ range: r.key })}
                aria-pressed={range === r.key}
                className={`min-h-[32px] px-2.5 rounded-btn text-table-cell transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  range === r.key ? 'bg-primary-light text-text-primary font-semibold' : 'text-text-secondary hover:bg-sidebar-hover'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {filtered && (
            <button
              type="button"
              onClick={() => update({ q: null, adviser: null, range: null })}
              className="min-h-[32px] px-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
            >
              Clear filters
            </button>
          )}

          <span className="sm:ml-auto text-table-cell text-text-secondary tabular-nums" aria-live="polite">
            {data
              ? data.total === 0
                ? 'No calls'
                : `${firstShown.toLocaleString('en-GB')}–${lastShown.toLocaleString('en-GB')} of ${data.total.toLocaleString('en-GB')}`
              : ''}
            {isFetching && data ? <span className="sr-only"> Updating</span> : null}
          </span>
        </div>

        {mode === 'sales' && tab === 'not_in_sale' && (
          <p className="px-5 py-3 border-b border-border bg-table-header text-table-cell text-text-secondary">
            <span className="font-semibold text-text-primary">These calls aren't part of a sale.</span> Your firm scores
            sales, so they're kept but not scored. If a sale for the customer arrives, the call joins it and is scored
            then.
          </p>
        )}

        {isError ? (
          <div className="px-5 py-6 flex flex-wrap items-center gap-3">
            <span className="bg-fail-bg text-fail px-3 py-2 rounded-btn text-table-cell">Couldn't load calls.</span>
            <button
              type="button"
              onClick={() => refetch()}
              className="px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Try again
            </button>
          </div>
        ) : isLoading ? (
          <div aria-busy="true" aria-label="Loading calls">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-6 px-5 py-4 border-b border-border-light last:border-0">
                {['30%', '15%', '10%', '18%'].map((w, j) => (
                  <div
                    key={j}
                    className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
                    style={{
                      width: w,
                      backgroundImage:
                        'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : !data || data.data.length === 0 ? (
          <div className="px-5 py-12 text-center text-text-muted text-table-cell">
            {filtered ? (
              <>
                No calls match these filters.{' '}
                <button
                  type="button"
                  onClick={() => update({ q: null, adviser: null, range: null })}
                  className="text-primary-ink font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                >
                  Clear filters
                </button>
              </>
            ) : tab === 'processing' ? (
              'Nothing is being processed right now.'
            ) : tab === 'failed' ? (
              'No call has failed to process.'
            ) : tab === 'attention' ? (
              'Nothing needs attention.'
            ) : tab !== 'all' ? (
              'No calls here yet.'
            ) : (
              <>
                No calls yet. They arrive from your dialler as they're recorded
                {canUpload && (
                  <>
                    , or you can{' '}
                    <Link to="/calls/upload" className="text-primary-ink font-semibold hover:underline">
                      upload one
                    </Link>
                  </>
                )}
                .
              </>
            )}
          </div>
        ) : (
          <>
            {/* Wide screens: a table, one line per call. */}
            <table className="hidden sm:table w-full">
              <thead>
                <tr>
                  {['Customer', 'Adviser', 'When', mode === 'sales' ? 'Sale' : 'Result'].map((h) => (
                    <th key={h} scope="col" className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <DayGroup key={g.day} day={g.day} colSpan={4}>
                    {g.rows.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => open(row)}
                        className="hover:bg-table-header focus-within:bg-table-header transition-colors cursor-pointer border-b border-border-light last:border-0"
                      >
                        <td className="px-5 py-3 min-w-0">
                          <Customer row={row} />
                        </td>
                        <td className="px-5 py-3 text-table-cell text-text-cell">{row.adviser_name ?? '—'}</td>
                        <td className="px-5 py-3 text-table-cell whitespace-nowrap">
                          <span className="block text-text-cell tabular-nums">{timeOf(row.called_at)}</span>
                          <span className="block text-xs text-text-secondary tabular-nums">{formatDuration(row.duration_seconds)}</span>
                        </td>
                        <td className="px-5 py-3">
                          <Outcome row={row} mode={mode!} scoreOnly={scoreOnly} />
                        </td>
                      </tr>
                    ))}
                  </DayGroup>
                ))}
              </tbody>
            </table>

            {/* Phones: each call as a two-line card, no sideways scrolling. */}
            <ul className="sm:hidden">
              {groups.map((g) => (
                <li key={g.day}>
                  <p className="px-4 py-2 bg-page text-xs font-semibold text-text-secondary border-b border-border-light">{g.day}</p>
                  <ul>
                    {g.rows.map((row) => (
                      <li
                        key={row.id}
                        onClick={() => open(row)}
                        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 border-b border-border-light cursor-pointer active:bg-table-header"
                      >
                        <Customer row={row} />
                        <div className="self-start text-right">
                          <Outcome row={row} mode={mode!} scoreOnly={scoreOnly} align="end" part="headline" />
                        </div>
                        <p className="col-span-2 text-xs text-text-secondary truncate tabular-nums">
                          {[row.adviser_name, timeOf(row.called_at), formatDuration(row.duration_seconds)].filter(Boolean).join(' · ')}
                        </p>
                        <div className="col-span-2 empty:hidden">
                          <Outcome row={row} mode={mode!} scoreOnly={scoreOnly} part="detail" />
                        </div>
                      </li>
                    ))}
                  </ul>
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
              Page {page.toLocaleString('en-GB')} of {totalPages.toLocaleString('en-GB')}
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

function DayGroup({ day, colSpan, children }: { day: string; colSpan: number; children: ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={colSpan} scope="colgroup" className="text-left px-5 py-2 bg-page text-xs font-semibold text-text-secondary border-b border-border-light">
          {day}
        </th>
      </tr>
      {children}
    </>
  );
}

/** Who the call was with: the customer by name where one is on file, else the number. */
function Customer({ row }: { row: CallListRow }) {
  const phone = row.customer_phone ? formatPhone(row.customer_phone) : null;
  const named = Boolean(row.customer_name?.trim());
  const title = named ? row.customer_name! : phone ?? 'Unknown caller';
  const inbound = row.direction === 'inbound';
  return (
    <div className="min-w-0">
      <Link
        to={`/calls/${row.id}`}
        onClick={(e) => e.stopPropagation()}
        className="block truncate text-table-cell font-semibold text-text-primary hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        {title}
      </Link>
      <span className="flex items-center gap-1 text-xs text-text-secondary min-w-0">
        {row.direction && (
          <svg className="w-3.5 h-3.5 flex-none text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={inbound ? 'M17 7 7 17m0 0h7m-7 0v-7' : 'M7 17 17 7m0 0h-7m7 0v7'} />
          </svg>
        )}
        <span className="sr-only">{inbound ? 'Inbound call' : row.direction ? 'Outbound call' : ''}</span>
        <span className="truncate">{named ? phone ?? 'No number on file' : 'No customer on file'}</span>
      </span>
    </div>
  );
}

const PILL = 'inline-flex items-center px-2.5 py-[3px] rounded-full text-badge font-semibold whitespace-nowrap';

/**
 * What came of the call. For a firm scoring sales: the result of the sale it
 * belongs to, and what failed on this call. For a firm scoring calls: its own
 * score and verdict. Verdicts are left out for firms that hide them.
 */
function Outcome({
  row,
  mode,
  scoreOnly,
  align = 'start',
  part = 'both',
}: {
  row: CallListRow;
  mode: Mode;
  scoreOnly: boolean;
  align?: 'start' | 'end';
  /** Phones split the result: the headline beside the name, the detail on its own line. */
  part?: 'both' | 'headline' | 'detail';
}) {
  const wrap = `flex flex-col gap-0.5 ${align === 'end' ? 'items-end' : 'items-start'}`;
  const showHeadline = part !== 'detail';
  const showDetail = part !== 'headline';

  if (PROCESSING.has(row.status)) {
    const label = row.status === 'uploaded' ? 'Queued' : row.status === 'transcribing' ? 'Transcribing' : 'Scoring';
    return showHeadline ? <span className={`${PILL} bg-processing-bg text-processing`}>{label}</span> : null;
  }
  if (row.status === 'failed') return showHeadline ? <span className={`${PILL} bg-fail-bg text-fail`}>Couldn't process</span> : null;
  if (row.status === 'skipped') return showHeadline ? <span className={`${PILL} bg-table-header text-text-muted`}>Too short to score</span> : null;

  const counts = (failed: number, waiting: number, where: string) => {
    const parts: ReactNode[] = [];
    if (failed > 0) parts.push(<span key="f" className="text-fail font-semibold">{failed} failed{where}</span>);
    if (waiting > 0) parts.push(<span key="w" className="text-review font-semibold">{waiting} waiting on you</span>);
    return parts.length ? parts.reduce<ReactNode[]>((acc, p, i) => (i ? [...acc, ' · ', p] : [p]), []) : null;
  };

  if (mode === 'sales') {
    const sale = row.sale;
    if (!sale) return showHeadline ? <span className="text-table-cell text-text-muted">Not in a sale</span> : null;
    const scored = sale.status === 'scored' && sale.overall_score != null;
    const detail = counts(sale.failed_here, sale.waiting_here, ' here');
    return (
      <span className={wrap}>
        {showHeadline && (
        <Link
          to={`/journeys/${sale.id}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-baseline gap-1.5 text-table-cell font-semibold text-text-primary hover:text-primary-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          Sale
          {scored ? (
            <span className="tabular-nums">{Math.floor(Number(sale.overall_score))}%</span>
          ) : (
            <span className="font-normal text-text-secondary">{sale.status === 'failed' ? "couldn't be scored" : 'being scored'}</span>
          )}
          {scored && !scoreOnly && sale.pass != null && (
            <span className={`${PILL} ${sale.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'}`}>
              {sale.pass ? 'Passed' : 'Failed'}
            </span>
          )}
        </Link>
        )}
        {showDetail && (
          <span className="text-xs text-text-secondary">
            {sale.call_number != null ? `Call ${sale.call_number} of ${sale.call_total}` : 'Not transcribed'}
            {detail ? <> · {detail}</> : scored ? ' · nothing failed here' : null}
          </span>
        )}
      </span>
    );
  }

  const score = row.score;
  if (!score) return showHeadline ? <span className="text-table-cell text-text-muted">Not scored</span> : null;
  const detail = counts(score.failed, score.waiting, '');
  const verdict = scoreOnly ? null : score.pass === true ? 'pass' : score.pass === false ? 'fail' : 'review';
  return (
    <span className={wrap}>
      {showHeadline && (
      <span className="inline-flex items-center gap-2">
        {score.overall_score != null && (
          <span className="text-table-cell font-semibold text-text-primary tabular-nums">
            {Math.floor(Number(score.overall_score))}%
          </span>
        )}
        {verdict && (
          <span
            className={`${PILL} ${
              verdict === 'pass' ? 'bg-pass-bg text-pass' : verdict === 'fail' ? 'bg-fail-bg text-fail' : 'bg-review-bg text-review'
            }`}
          >
            {verdict === 'pass' ? 'Pass' : verdict === 'fail' ? 'Fail' : 'Review'}
          </span>
        )}
      </span>
      )}
      {showDetail && detail && <span className="text-xs text-text-secondary">{detail}</span>}
    </span>
  );
}
