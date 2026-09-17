import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { AgentFilter } from '../components/AgentFilter';
import { JourneyStatusBadge, ProcessingStateBadge } from '../components/JourneyStatusBadge';
import { ScoreGauge } from '../components/ScoreGauge';
import { SeverityBadge } from '../components/BreachBadges';
import { useDialog } from '../components/DialogProvider';
import { useAuth, useScoreOnly } from '../context/AuthContext';
import { formatPhone, humanLabel } from '../lib/format';
import {
  JOURNEY_LIST_SORTS,
  JOURNEY_WORK_TABS,
  JOURNEY_WORK_TAB_LABELS,
} from '@callguard/shared';
import type {
  JourneyListItem,
  JourneyListResponse,
  JourneyListSort,
  JourneyWorkTab,
} from '@callguard/shared';

// Past this many days a wait stops being a queue position and starts being a
// problem, so the age is called out. Two weeks: long enough that an adviser on
// holiday has not been flagged, short enough that a principal would want to
// know before a month is up.
const STALE_DAYS = 14;

// Every filter, the tab, the sort and the page live in the URL.
//
// Not component state: Back from a sale used to land on page 1 of an unfiltered
// list, losing whatever the reader had narrowed to, and a filtered view could
// not be sent to the person who needed to act on it.
const SORT_LABELS: Record<JourneyListSort, string> = {
  sale_date: 'Sale date',
  score: 'Score',
  waiting: 'Waiting',
};

// Whole days since an ISO timestamp, or null when there isn't one. Floored, so
// a sale sent this morning reads as 0 (and the row omits the age) rather than
// rounding up to a day it has not been waiting.
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// What the reader of this list has to do next about this sale, in their own
// terms — assembled from what is already on the row rather than from a second
// request, so it can never disagree with the cells beside it.
//
// One line, and the order is the priority: the pipeline first (there is nothing
// to decide about a sale that has not been scored), then a checkpoint held for a
// person, then the two waits on somebody else, then feedback nobody has sent.
interface NextStep {
  title: string;
  detail?: string;
  // The wait has gone past STALE_DAYS — shown in the review tone, with the
  // number carrying the meaning rather than the colour.
  stale?: boolean;
  // Scoring broke and an admin can run it again.
  retry?: boolean;
}

function nextStep(j: JourneyListItem): NextStep {
  if (j.status === 'pending') {
    return { title: 'Waiting to score', detail: 'Nothing for you to do yet' };
  }
  if (j.status === 'scoring') {
    return { title: 'Scoring', detail: 'The result will appear here' };
  }
  if (j.status === 'failed') {
    return { title: 'Score it again', detail: 'Scoring did not finish', retry: true };
  }
  if (j.status === 'skipped') {
    return { title: 'Nothing to do', detail: 'Not taken up, so it is not scored' };
  }
  if (j.items_to_review > 0) {
    return {
      title: `Review ${j.items_to_review} ${plural(j.items_to_review, 'checkpoint', 'checkpoints')}`,
      detail: 'held for a person to decide',
    };
  }
  const adviser = j.agent_name ?? 'the adviser';
  if (j.feedback_status === 'awaiting') {
    const days = daysSince(j.feedback_sent_at);
    return {
      title: `Awaiting ${adviser}`,
      detail: days == null ? 'sent, not yet confirmed' : days === 0 ? 'sent today' : `${days} ${plural(days, 'day', 'days')} since sent`,
      stale: (days ?? 0) > STALE_DAYS,
    };
  }
  if (j.feedback_status === 'awaiting_remediation') {
    const days = j.oldest_remediation_days;
    const open = j.open_remediations;
    return {
      title: `Chase ${adviser}`,
      detail:
        `${open} ${plural(open, 'finding', 'findings')} still open` +
        (days != null && days > 0 ? ` · acknowledged ${days} ${plural(days, 'day', 'days')} ago` : ''),
      stale: (days ?? 0) > STALE_DAYS,
    };
  }
  if (j.items_failed > 0 && j.feedback_status === 'not_fed_back') {
    return {
      title: 'Feed back',
      detail: `${j.items_failed} ${plural(j.items_failed, 'finding', 'findings')} ready for ${adviser}`,
    };
  }
  // Nothing left to do — but say which kind of nothing. The column this design
  // dropped was the feedback badge, and "acknowledged" and "there was nothing
  // to feed back" are the two states it distinguished that the word "Done"
  // alone does not.
  return {
    title: 'Done',
    detail:
      j.feedback_status === 'acknowledged' ? `${adviser} acknowledged` : 'nothing found to feed back',
  };
}

export function Journeys() {
  const scoreOnly = useScoreOnly();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { notify } = useDialog();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const tabParam = params.get('tab') ?? 'all';
  const tab = (JOURNEY_WORK_TABS as string[]).includes(tabParam)
    ? (tabParam as JourneyWorkTab)
    : 'all';
  const q = params.get('q') ?? '';
  const adviser = params.get('adviser') ?? '';
  const branch = params.get('branch') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const sortParam = params.get('sort') ?? 'sale_date';
  const sort = (JOURNEY_LIST_SORTS as string[]).includes(sortParam)
    ? (sortParam as JourneyListSort)
    : 'sale_date';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);

  // One writer for the URL. Any filter change drops the page number: page 3 of
  // an unfiltered list is rarely page 3 of a filtered one, and landing on an
  // empty page reads as "no results" rather than "wrong page".
  const patch = useCallback(
    (next: Record<string, string | null>, keepPage = false) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (value === null || value === '') out.delete(key);
            else out.set(key, value);
          }
          if (!keepPage && !('page' in next)) out.delete('page');
          return out;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  // The search box types faster than the list can answer, so the URL (and the
  // request) follow a beat behind.
  const [searchText, setSearchText] = useState(q);
  useEffect(() => {
    setSearchText(q);
  }, [q]);
  useEffect(() => {
    if (searchText === q) return;
    const timer = setTimeout(() => patch({ q: searchText }), 300);
    return () => clearTimeout(timer);
  }, [searchText, q, patch]);

  // Distinct closing advisers, for the filter. Cached separately from the list
  // so paging or changing a tab doesn't refetch it.
  const { data: advisersData } = useQuery({
    queryKey: ['journey-advisers'],
    queryFn: () => api.get<{ data: string[] }>('/journeys/advisers'),
    staleTime: 5 * 60 * 1000,
  });
  const advisers = advisersData?.data ?? [];

  // Branches actually present in the org's sales (not merely configured), so
  // the filter never offers an option that returns nothing.
  const { data: branchesData } = useQuery({
    queryKey: ['journey-branches'],
    queryFn: () => api.get<{ data: string[] }>('/journeys/branches'),
    staleTime: 5 * 60 * 1000,
  });
  const branches = branchesData?.data ?? [];

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: '50', sort, dir });
    if (tab !== 'all') p.set('tab', tab);
    if (q) p.set('q', q);
    if (adviser) p.set('agent', adviser);
    if (branch) p.set('branch', branch);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    return p.toString();
  }, [page, sort, dir, tab, q, adviser, branch, from, to]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['journeys', queryString],
    queryFn: () => api.get<JourneyListResponse>(`/journeys?${queryString}`),
    refetchInterval: (query) => {
      // Poll while anything is still in flight so scores appear without a manual refresh.
      const rows = query.state.data?.data ?? [];
      return rows.some((j) => j.status === 'pending' || j.status === 'scoring') ? 4000 : false;
    },
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/journeys/${id}/rescore`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['journeys'] });
      void notify('Scoring started again — the result will appear here shortly.');
    },
    // The API refuses a re-score it judges pointless or unfair (unchanged
    // evidence, or findings already fed back) and says why in the message, so
    // pass it through rather than inventing our own wording.
    onError: (err) => void notify(err instanceof Error ? err.message : 'Could not score it again'),
  });

  const journeys = data?.data ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? 50;
  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
  const counts = data?.tab_counts;
  const outstanding = data?.outstanding;
  const firstRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const lastRow = Math.min(page * limit, total);
  const filtered = !!(tab !== 'all' || q || adviser || branch || from || to);

  const clearFilters = () =>
    patch({ tab: null, q: null, adviser: null, branch: null, from: null, to: null });

  // Clicking the column you are already sorted by turns it round; clicking a
  // new one starts from the end a reader wants first — the worst score, the
  // newest sale, the longest wait.
  const applySort = (next: JourneyListSort) =>
    patch({
      sort: next === 'sale_date' ? null : next,
      dir: sort === next && dir === 'desc' ? 'asc' : null,
    });
  const ariaSort = (col: JourneyListSort): 'ascending' | 'descending' | 'none' =>
    sort !== col ? 'none' : dir === 'asc' ? 'ascending' : 'descending';

  const columns: Array<{ key: string; label: string; sort?: JourneyListSort }> = [
    { key: 'sale', label: 'Sale', sort: 'sale_date' },
    { key: 'adviser', label: 'Adviser' },
    { key: 'score', label: 'Score', sort: 'score' },
    { key: 'findings', label: 'Findings' },
    { key: 'next', label: 'Next step', sort: 'waiting' },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-page-title text-text-primary">Sales</h2>
          <p className="text-page-sub text-text-subtle mt-1">
            Multi-call sales scored as one unit — a statement or consent counts if it happened on any
            call in the sale.
          </p>
        </div>
      </div>

      {/* What the firm owes and is owed, counted across every sale rather than
          under the filters below. The two banners this replaced were filtered,
          so each disappeared on the very click that filtered to it — and
          neither mentioned the review backlog at all, which is how 130
          checkpoints held for a person stayed invisible on a screen showing
          their sales at 100%.

          On the card surface, not a tinted one: the links inside measured
          4.30:1 on the review tint, and primary-ink on card is 4.7:1.

          Hidden outright when the request failed — a strip of zeros would say
          the firm is up to date, which is the one thing it must never say by
          accident. */}
      {!isError && (
      <div className="bg-card border border-border rounded-card shadow-card p-4 mb-5">
        <h3 className="text-card-label uppercase text-text-muted mb-2.5">Outstanding</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <OutstandingFigure
            loading={isLoading}
            count={outstanding?.awaiting_confirmation ?? 0}
            label="awaiting confirmation"
            detail={
              outstanding?.oldest_awaiting_days != null && outstanding.oldest_awaiting_days > 0
                ? `oldest sent ${outstanding.oldest_awaiting_days} ${plural(outstanding.oldest_awaiting_days, 'day', 'days')} ago`
                : undefined
            }
            stale={(outstanding?.oldest_awaiting_days ?? 0) > STALE_DAYS}
            action={
              (outstanding?.awaiting_confirmation ?? 0) > 0 && tab !== 'awaiting_adviser'
                ? {
                    label: `Show the ${outstanding?.awaiting_confirmation}`,
                    onClick: () => patch({ tab: 'awaiting_adviser' }),
                  }
                : undefined
            }
          />
          <OutstandingFigure
            loading={isLoading}
            count={outstanding?.awaiting_outcome ?? 0}
            label="awaiting an outcome"
            detail={
              outstanding?.oldest_outcome_days != null && outstanding.oldest_outcome_days > 0
                ? `oldest acknowledged ${outstanding.oldest_outcome_days} ${plural(outstanding.oldest_outcome_days, 'day', 'days')} ago`
                : undefined
            }
            stale={(outstanding?.oldest_outcome_days ?? 0) > STALE_DAYS}
            // "Who is sitting on this?" is the next question, and this screen
            // cannot answer it — the by-adviser view can.
            action={{ label: 'By adviser', to: '/remediation' }}
          />
          <OutstandingFigure
            loading={isLoading}
            count={outstanding?.review_checkpoints ?? 0}
            label={plural(outstanding?.review_checkpoints ?? 0, 'checkpoint to review', 'checkpoints to review')}
            detail={
              (outstanding?.review_sales ?? 0) > 0
                ? `across ${outstanding?.review_sales} ${plural(outstanding?.review_sales ?? 0, 'sale', 'sales')}`
                : undefined
            }
            action={{ label: 'Review queue', to: '/review-queue' }}
          />
        </div>
      </div>
      )}

      {/* Filters. Separate from the tabs below: what a sale is waiting for is
          the axis a compliance manager works along, and mixing six controls
          into that row buries it. */}
      <div className="bg-card border border-border rounded-card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="sales-search" className="block text-xs font-medium text-text-muted mb-1">
            Customer or phone
          </label>
          <input
            id="sales-search"
            type="search"
            value={searchText}
            placeholder="Search name or number…"
            onChange={(e) => setSearchText(e.target.value)}
            className="w-56 px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </div>

        {advisers.length > 0 && (
          <div>
            <label htmlFor="sales-adviser" className="block text-xs font-medium text-text-muted mb-1">
              Adviser
            </label>
            <AgentFilter
              id="sales-adviser"
              options={advisers}
              value={adviser || null}
              onChange={(v) => patch({ adviser: v })}
            />
          </div>
        )}

        {branches.length > 1 && (
          <div>
            <label htmlFor="sales-branch" className="block text-xs font-medium text-text-muted mb-1">
              Branch
            </label>
            <select
              id="sales-branch"
              value={branch}
              onChange={(e) => patch({ branch: e.target.value })}
              className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <option value="">All branches</option>
              {/* The stored key is the value; the reader sees "On risk". */}
              {branches.map((b) => (
                <option key={b} value={b}>{humanLabel(b)}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor="sales-from" className="block text-xs font-medium text-text-muted mb-1">
            Sale date from
          </label>
          <input
            id="sales-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => patch({ from: e.target.value })}
            className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </div>
        <div>
          <label htmlFor="sales-to" className="block text-xs font-medium text-text-muted mb-1">
            Sale date to
          </label>
          <input
            id="sales-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => patch({ to: e.target.value })}
            className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </div>

        {filtered && (
          <button
            type="button"
            onClick={clearFilters}
            className="px-3 py-2 rounded-btn text-table-cell font-semibold text-text-secondary hover:text-text-primary underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* What each sale is waiting for. A scrolling chip row on a phone rather
          than a wrapped block, so the table below starts near the top of the
          screen. */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div
          role="group"
          aria-label="Filter sales by what they are waiting for"
          className="flex gap-1.5 overflow-x-auto -mx-1 px-1 py-0.5"
        >
          {JOURNEY_WORK_TABS.map((t) => {
            const n = counts?.[t];
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => patch({ tab: t === 'all' ? null : t })}
                aria-pressed={active}
                className={`shrink-0 px-3 py-1.5 rounded-btn text-table-cell font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  active
                    ? 'bg-primary-ink text-on-solid'
                    : 'border border-border text-text-secondary hover:bg-sidebar-hover'
                }`}
              >
                {JOURNEY_WORK_TAB_LABELS[t]}
                {n !== undefined && (
                  <span className={active ? 'ml-1.5 opacity-80' : 'ml-1.5 text-text-muted'}>{n}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Where you are in the result set. Always shown, not only when it
            paginates — "12 sales" is worth knowing on its own. */}
        <div className="shrink-0 text-xs text-text-muted" aria-live="polite">
          {isLoading
            ? 'Loading…'
            : isError
              ? ''
              : total === 0
                ? 'No sales'
                : totalPages > 1
                  ? `${firstRow}–${lastRow} of ${total} sales`
                  : `${total} ${plural(total, 'sale', 'sales')}`}
        </div>
      </div>

      {/* One line about what this tab holds, where the tab needs one. */}
      {tab === 'processing' && (
        <p className="text-table-cell text-text-secondary mb-3">
          Sales still going through the pipeline, and sales whose scoring broke. Nothing here has a
          compliance result yet — “Not scored” means the run did not finish, not that the sale
          failed.
        </p>
      )}
      {tab === 'not_taken_up' && (
        <p className="text-table-cell text-text-secondary mb-3">
          Sales the CRM marks as not taken up. They are deliberately never scored, so there is no
          result to read here — they are listed because the business still happened.
        </p>
      )}

      {isError ? (
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block text-table-cell">
            Could not load sales.
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="px-[18px] py-[9px] rounded-btn text-table-cell font-semibold bg-primary-ink text-on-solid hover:bg-primary-ink-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {isFetching ? 'Trying…' : 'Try again'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Phone: one card per sale, so nothing has to be scrolled sideways
              to find out whether a sale needs attention. */}
          <div className="sm:hidden space-y-3">
            {isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <div key={`card-skeleton-${i}`} className="bg-card border border-border rounded-card p-4 space-y-2">
                  <Shimmer width="70%" />
                  <Shimmer width="45%" />
                  <Shimmer width="55%" />
                </div>
              ))}
            {!isLoading && journeys.length === 0 && (
              <div className="bg-card border border-border rounded-card p-10 text-center">
                <EmptyState filtered={filtered} onClear={clearFilters} />
              </div>
            )}
            {journeys.map((j) => (
              <SaleCard
                key={j.id}
                journey={j}
                scoreOnly={scoreOnly}
                canRetry={isAdmin}
                onRetry={() => retry.mutate(j.id)}
                retrying={retry.isPending && retry.variables === j.id}
              />
            ))}
          </div>

          <div className="hidden sm:block bg-card border border-border rounded-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <caption className="sr-only">
                  Sales, five columns: the sale, its closing adviser, its score, what was found on
                  it, and the next step. Sortable by sale date, score and how long the next step has
                  waited.
                </caption>
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th
                        key={col.key}
                        scope="col"
                        aria-sort={col.sort ? ariaSort(col.sort) : undefined}
                        className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted bg-table-header border-b border-border"
                      >
                        {col.sort ? (
                          <button
                            type="button"
                            onClick={() => applySort(col.sort!)}
                            className="inline-flex items-center gap-1 min-h-[24px] px-1 -mx-1 uppercase text-table-header text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                          >
                            {col.label}
                            <SortArrow active={sort === col.sort} ascending={dir === 'asc'} />
                            <span className="sr-only">
                              {sort === col.sort
                                ? `, sorted ${dir === 'asc' ? 'ascending' : 'descending'}; activate to reverse`
                                : `, activate to sort by ${SORT_LABELS[col.sort]}`}
                            </span>
                          </button>
                        ) : (
                          col.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {isLoading &&
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={`skeleton-${i}`} className="border-b border-border-light last:border-0">
                        {columns.map((col, j) => (
                          <td key={col.key} className="px-5 py-3.5">
                            <Shimmer width={j === 0 ? '70%' : '40%'} />
                          </td>
                        ))}
                      </tr>
                    ))}

                  {!isLoading && journeys.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} className="px-5 py-12 text-center text-text-muted text-table-cell">
                        <EmptyState filtered={filtered} onClear={clearFilters} />
                      </td>
                    </tr>
                  )}

                  {journeys.map((j) => {
                    const step = nextStep(j);
                    return (
                      // The row is the link to the sale (the `before` overlay on
                      // the customer's name covers it), which is what a reader
                      // aims at — the old row's dominant link went to the
                      // customer and the only way to the sale was a 31×16px
                      // "View". Nested links sit above the overlay.
                      <tr
                        key={j.id}
                        className="relative hover:bg-table-header transition-colors border-b border-border-light last:border-0"
                      >
                        <td className="px-5 py-3.5 text-table-cell">
                          <Link
                            to={`/journeys/${j.id}`}
                            className="font-semibold text-text-primary hover:underline before:absolute before:inset-0 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                          >
                            {saleLabel(j)}
                          </Link>
                          <div className="text-xs text-text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5">
                            <span>{formatPhone(j.customer_phone) || 'No number'}</span>
                            <span aria-hidden="true">·</span>
                            <span>{formatDate(j.sale_date)}</span>
                            <Link
                              to={`/customers/${j.customer_id}`}
                              className="relative inline-flex items-center min-h-[24px] px-1 -mx-1 text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                            >
                              Customer
                              <span className="sr-only"> profile for {saleLabel(j)}</span>
                            </Link>
                          </div>
                        </td>
                        <td className="px-5 py-3.5 text-table-cell text-text-cell">
                          <AdviserCell journey={j} />
                        </td>
                        <td className="px-5 py-3.5">
                          <ScoreCell journey={j} scoreOnly={scoreOnly} />
                        </td>
                        <td className="px-5 py-3.5">
                          <FindingsCell journey={j} />
                        </td>
                        <td className="px-5 py-3.5">
                          <div className="text-table-cell font-semibold text-text-primary">{step.title}</div>
                          {step.detail && (
                            <div className={`text-xs mt-0.5 ${step.stale ? 'text-review font-semibold' : 'text-text-muted'}`}>
                              {step.detail}
                            </div>
                          )}
                          {step.retry && isAdmin && (
                            <button
                              type="button"
                              onClick={() => retry.mutate(j.id)}
                              disabled={retry.isPending && retry.variables === j.id}
                              className="relative mt-1.5 px-3 py-1.5 rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              {retry.isPending && retry.variables === j.id ? 'Starting…' : 'Retry'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border bg-table-header">
                <button
                  type="button"
                  onClick={() => patch({ page: String(page - 1) }, true)}
                  disabled={page === 1}
                  className="px-2 py-1 -mx-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Previous
                </button>
                <span className="text-xs text-text-muted">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => patch({ page: String(page + 1) }, true)}
                  disabled={page === totalPages}
                  className="px-2 py-1 -mx-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Next
                </button>
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="sm:hidden flex items-center justify-between mt-3">
              <button
                type="button"
                onClick={() => patch({ page: String(page - 1) }, true)}
                disabled={page === 1}
                className="px-3 py-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Previous
              </button>
              <span className="text-xs text-text-muted">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => patch({ page: String(page + 1) }, true)}
                disabled={page === totalPages}
                className="px-3 py-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────────

// A sale is named by its customer, and by their number when nobody has a name
// for them — never "Unknown customer", which named nothing and read as a fault.
function saleLabel(j: JourneyListItem): string {
  return j.customer_name || formatPhone(j.customer_phone) || 'Customer not identified';
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB') : 'No date';
}

function AdviserCell({ journey: j }: { journey: JourneyListItem }) {
  if (!j.agent_name) return <span className="text-text-muted">Not attributed</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="truncate max-w-[10rem]">{j.agent_name}</span>
      {j.agent_count > 1 && (
        <span
          className="px-1.5 py-[1px] rounded-full text-badge font-semibold bg-table-header text-text-muted shrink-0"
          title={`This sale was handled by ${j.agent_count} advisers. Shown is the one who closed it — the same attribution used for breaches and CRM write-back.`}
        >
          +{j.agent_count - 1}
          {/* The chip carried its meaning in a title alone, which a keyboard or
              screen-reader user never sees. */}
          <span className="sr-only">
            {' '}
            and {j.agent_count - 1} other {plural(j.agent_count - 1, 'adviser', 'advisers')} worked
            this sale; the closer is shown
          </span>
        </span>
      )}
    </span>
  );
}

function ScoreCell({ journey: j, scoreOnly }: { journey: JourneyListItem; scoreOnly: boolean }) {
  // Still in the pipeline, or its scoring broke: the state stands where the
  // score would be, with the reason under it.
  if (j.status === 'pending' || j.status === 'scoring' || j.status === 'failed') {
    return (
      <div>
        <ProcessingStateBadge status={j.status} />
        {j.status === 'failed' && j.error_message && (
          <div className="text-xs text-text-muted mt-1 max-w-[16rem] break-words">{j.error_message}</div>
        )}
      </div>
    );
  }
  if (j.status === 'skipped') return <JourneyStatusBadge status="skipped" />;
  if (j.overall_score == null) return <span className="text-text-muted text-table-cell">No score</span>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Floored, as the sale page floors it: a sale reading 79% on one screen
          and 80% on another is a sale nobody trusts. */}
      <ScoreGauge score={Math.floor(Number(j.overall_score))} showBar />
      {/* Withheld for score-only tenants — the API does not even send `pass`. */}
      {!scoreOnly && j.pass != null && (
        <span
          className={`inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold ${
            j.pass ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
          }`}
        >
          {j.pass ? 'Pass' : 'Fail'}
        </span>
      )}
    </div>
  );
}

// What the sale found — and the column this list existed without.
//
// A held checkpoint is left out of the score entirely, so a sale can read 100%
// with four checkpoints nobody has ruled on, two of them critical. This cell is
// the fix: it can never read as clean while anything is unreviewed.
function FindingsCell({ journey: j }: { journey: JourneyListItem }) {
  if (j.status !== 'scored') return <span className="text-text-muted text-table-cell">—</span>;
  if (j.items_failed === 0 && j.items_to_review === 0) {
    return <span className="text-text-muted text-table-cell">Nothing found</span>;
  }
  return (
    <div className="space-y-1">
      {j.items_failed > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-table-cell text-text-cell">
            {j.items_failed} failed
          </span>
          {j.worst_failed_severity && <SeverityBadge severity={j.worst_failed_severity} />}
        </div>
      )}
      {j.items_to_review > 0 && (
        <span className="inline-block px-2.5 py-[3px] rounded-full text-badge font-semibold bg-review-bg text-review">
          {j.items_to_review} to review
        </span>
      )}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Shimmer({ width }: { width: string }) {
  return (
    <div
      className="h-4 rounded bg-[length:800px_100%] animate-skeleton-shimmer"
      style={{
        backgroundImage:
          'linear-gradient(90deg, rgb(var(--cg-border-light)) 0%, rgb(var(--cg-border)) 50%, rgb(var(--cg-border-light)) 100%)',
        width,
      }}
    />
  );
}

// An empty list says which kind of empty it is: nothing matched what you asked
// for (with the way out), or there is nothing here yet.
function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  if (!filtered) {
    return (
      <span className="text-text-muted text-table-cell">
        No scored sales yet. A sale is scored when it closes in your CRM, or via “Score sale” on a
        customer.
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-2 text-table-cell text-text-muted">
      No sales match these filters.
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center min-h-[24px] px-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
      >
        Clear filters
      </button>
    </span>
  );
}

function SortArrow({ active, ascending }: { active: boolean; ascending: boolean }) {
  if (!active) {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-icon-muted" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 stroke-text-primary" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ascending ? <path d="M6 14l6-6 6 6" /> : <path d="M6 10l6 6 6-6" />}
    </svg>
  );
}

function OutstandingFigure({
  loading,
  count,
  label,
  detail,
  stale,
  action,
}: {
  loading: boolean;
  count: number;
  label: string;
  detail?: string;
  stale?: boolean;
  action?: { label: string; to?: string; onClick?: () => void };
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Shimmer width="60%" />
        <Shimmer width="40%" />
      </div>
    );
  }
  // primary-ink on the card surface, not on a review tint: the link this
  // replaced measured 4.30:1 in light mode, and this pairing is 4.7:1.
  const linkClass =
    'inline-flex items-center min-h-[24px] px-1 -mx-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded';
  return (
    <div>
      <p className="text-table-cell text-text-primary">
        <span className="font-semibold tabular-nums">{count}</span> {label}
        {detail && (
          <>
            <span className="text-text-muted" aria-hidden="true"> · </span>
            <span className={stale ? 'text-review font-semibold' : 'text-text-secondary'}>{detail}</span>
          </>
        )}
      </p>
      {action && (
        <div className="mt-1">
          {action.to ? (
            <Link to={action.to} className={linkClass}>
              {action.label}
            </Link>
          ) : (
            <button type="button" onClick={action.onClick} className={linkClass}>
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// One sale on a phone. Same five facts as the row, stacked: who it was with and
// what it scored on the first line, then what was found and what to do.
function SaleCard({
  journey: j,
  scoreOnly,
  canRetry,
  onRetry,
  retrying,
}: {
  journey: JourneyListItem;
  scoreOnly: boolean;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const step = nextStep(j);
  return (
    <div className="relative bg-card border border-border rounded-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/journeys/${j.id}`}
            className="text-table-cell font-semibold text-text-primary hover:underline before:absolute before:inset-0 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {saleLabel(j)}
          </Link>
          <div className="text-xs text-text-muted mt-0.5">
            {formatPhone(j.customer_phone) || 'No number'} · {formatDate(j.sale_date)}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {j.agent_name ?? 'Not attributed'}
            {j.agent_count > 1 && ` +${j.agent_count - 1}`}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <ScoreCell journey={j} scoreOnly={scoreOnly} />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FindingsCell journey={j} />
      </div>
      <div className="mt-3 pt-3 border-t border-border-light">
        <div className="text-table-cell font-semibold text-text-primary">{step.title}</div>
        {step.detail && (
          <div className={`text-xs mt-0.5 ${step.stale ? 'text-review font-semibold' : 'text-text-muted'}`}>
            {step.detail}
          </div>
        )}
        {step.retry && canRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="relative mt-2 px-[18px] py-[9px] rounded-btn border border-border text-text-cell font-semibold text-table-cell hover:bg-sidebar-hover disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {retrying ? 'Starting…' : 'Retry'}
          </button>
        )}
      </div>
    </div>
  );
}
