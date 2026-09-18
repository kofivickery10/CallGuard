import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { AgentFilter } from '../components/AgentFilter';
import { SeverityBadge } from '../components/BreachBadges';
import { ReviewEvidencePanel } from '../components/ReviewEvidencePanel';
import { useAuth } from '../context/AuthContext';
import { useDialog } from '../components/DialogProvider';
import { REVIEW_SEVERITIES, REVIEW_QUEUE_SORTS, BREACH_SEVERITY_LABELS } from '@callguard/shared';
import type {
  ManualReviewItem,
  ReviewQueueResponse,
  ReviewQueueSort,
  ReviewSeverity,
} from '@callguard/shared';

/**
 * The review queue: the checkpoints the AI could not settle, waiting for a
 * person to rule on them.
 *
 * The screen is built around one fact that the old one never said: a checkpoint
 * sitting here is left out of its parent's score. So the sale it belongs to can
 * read 100% with a critical checkpoint unruled, and one live sale reads "Scored"
 * with no score at all because 41 of its 42 checkpoints are here. Leaving work
 * in this queue does not defer a judgement — it publishes an optimistic one.
 * Everything else follows from that: the age on every row, the oldest first, the
 * consequence stated at the top, and the decision put where the evidence is read
 * rather than a screen-width away from it.
 */

// Past this many days a wait stops being a queue position and starts being a
// problem, so the age is called out. Same threshold, and the same reasoning, as
// the sales list.
const STALE_DAYS = 14;

// Sentinel for "every sale collapsed". Needed because an absent `open` is not
// the same thing: with nothing in the URL the first sale opens, which is what a
// reviewer arriving to work the queue wants.
const NONE = 'none';

// How a ruling is said out loud, for the announcement after it lands.
const RESULT_WORDS: Record<'pass' | 'fail' | 'na', string> = {
  pass: 'passed',
  fail: 'failed',
  na: 'not applicable to this sale',
};

const SORT_LABELS: Record<ReviewQueueSort, string> = {
  oldest: 'Longest waiting first',
  newest: 'Most recent first',
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// Whole days since an ISO timestamp, floored — a checkpoint raised this morning
// has waited 0 days, and says so rather than rounding up to a day it has not.
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function waitedLabel(days: number | null): string {
  if (days === null) return 'waiting';
  if (days === 0) return 'raised today';
  return `waiting ${days} ${plural(days, 'day', 'days')}`;
}

/** The same age for the table's Waiting column, whose header says the rest. */
function ageLabel(days: number | null): string {
  if (days === null) return '—';
  if (days === 0) return 'Today';
  return `${days} ${plural(days, 'day', 'days')}`;
}

/** The sale (or call) a group of checkpoints belongs to, as a person names it. */
function saleName(item: ManualReviewItem): string {
  return item.customer_name || item.source_call_name || 'Customer not identified';
}

function itemKey(item: ManualReviewItem): string {
  return `${item.kind}:${item.item_score_id}`;
}

interface SaleGroup {
  key: string;
  kind: 'call' | 'journey';
  parentId: string;
  name: string;
  adviser: string | null;
  oldestDays: number | null;
  items: ManualReviewItem[];
  bySeverity: Array<{ severity: ReviewSeverity; count: number }>;
}

/**
 * Rebuild the server's grouping from the flat page it sends. The server has
 * already ordered the rows — whole sales, longest wait first, and within a sale
 * the order the scorecard runs — so this only has to walk them in order and cut
 * a new group whenever the parent changes. Doing it that way rather than by
 * sorting again means the screen can never disagree with the page boundary the
 * server chose.
 */
function groupItems(items: ManualReviewItem[]): SaleGroup[] {
  const groups: SaleGroup[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.parent_id}`;
    let group = groups.length > 0 ? groups[groups.length - 1] : undefined;
    if (!group || group.key !== key) {
      group = {
        key,
        kind: item.kind,
        parentId: item.parent_id,
        name: saleName(item),
        adviser: item.agent_name,
        oldestDays: daysSince(item.detected_at),
        items: [],
        bySeverity: [],
      };
      groups.push(group);
    }
    group.items.push(item);
    const days = daysSince(item.detected_at);
    if (days !== null && (group.oldestDays === null || days > group.oldestDays)) {
      group.oldestDays = days;
    }
  }
  for (const group of groups) {
    group.bySeverity = REVIEW_SEVERITIES.map((severity) => ({
      severity,
      count: group.items.filter((i) => i.severity === severity).length,
    })).filter((s) => s.count > 0);
  }
  return groups;
}

export function ReviewQueue() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { notify } = useDialog();
  const canAction = user?.role === 'admin' || user?.role === 'supervisor';
  const [params, setParams] = useSearchParams();

  // Every filter, the sort, the page, which sales are expanded and which
  // evidence panels are open all live in the URL.
  //
  // Not component state, which is what they were: a reload closed every panel a
  // reviewer had open, Back from a sale lost the view they were working, and a
  // queue narrowed to one adviser could not be sent to the person who had to
  // clear it.
  const adviser = params.get('adviser') ?? '';
  const severityParam = params.get('severity') ?? '';
  const severity = (REVIEW_SEVERITIES as readonly string[]).includes(severityParam)
    ? (severityParam as ReviewSeverity)
    : '';
  const sortParam = params.get('sort') ?? 'oldest';
  const sort = (REVIEW_QUEUE_SORTS as readonly string[]).includes(sortParam)
    ? (sortParam as ReviewQueueSort)
    : 'oldest';
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const openParam = params.get('open');
  const evParam = params.get('ev');

  const openEvidence = useMemo(
    () => new Set((evParam ?? '').split(',').filter(Boolean)),
    [evParam]
  );

  const patch = useCallback(
    (next: Record<string, string | null>, keepPage = false) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (value === null || value === '') out.delete(key);
            else out.set(key, value);
          }
          // Page 3 of an unfiltered queue is rarely page 3 of a filtered one,
          // and landing on an empty page reads as "nothing to review" — the one
          // thing this screen must never say by accident.
          if (!keepPage && !('page' in next)) out.delete('page');
          return out;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const queryString = useMemo(() => {
    const p = new URLSearchParams({ page: String(page) });
    // The URL says `adviser` (the word the screen uses); the API's filter is
    // `agent`, as it is on the sales and calls lists.
    if (adviser) p.set('agent', adviser);
    if (severity) p.set('severity', severity);
    if (sort !== 'oldest') p.set('sort', sort);
    return p.toString();
  }, [page, adviser, severity, sort]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['review-items', queryString],
    queryFn: () => api.get<ReviewQueueResponse>(`/review-items?${queryString}`),
  });

  const summary = data?.summary;
  const groups = useMemo(() => groupItems(data?.data ?? []), [data]);
  const total = data?.total ?? 0;
  const totalSales = data?.total_sales ?? 0;
  const limit = data?.limit ?? 10;
  const totalPages = totalSales > 0 ? Math.ceil(totalSales / limit) : 0;
  const filtered = !!(adviser || severity);

  // How big the backlog was when this reviewer arrived, so the progress line can
  // say "4 of 130 done" rather than counting down a number that also moves when
  // somebody else rules on something.
  const [ruled, setRuled] = useState(0);
  const startTotal = useRef<number | null>(null);
  useEffect(() => {
    if (startTotal.current === null && summary) startTotal.current = summary.checkpoints;
  }, [summary]);

  // What just happened, announced rather than left to be noticed: resolving a
  // row removes it and re-orders what is left, which is silent to a screen
  // reader and easy to miss on a long page.
  const [announcement, setAnnouncement] = useState('');
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const toggleEvidence = (key: string) => {
    const next = new Set(openEvidence);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    patch({ ev: next.size === 0 ? null : [...next].join(',') }, true);
  };

  // Which sales are expanded. With nothing in the URL the first sale on the page
  // is open and the rest are shut: 41 rows under one header is a sitting's work,
  // and 15 headers all open again is the wall of 130 strangers this replaced.
  const expanded = useMemo(() => {
    if (openParam === NONE) return new Set<string>();
    if (openParam) return new Set(openParam.split(',').filter(Boolean));
    return new Set(groups.length > 0 ? [groups[0]!.key] : []);
  }, [openParam, groups]);

  const toggleGroup = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    patch({ open: next.size === 0 ? NONE : [...next].join(',') }, true);
  };

  const resolve = async (item: ManualReviewItem, result: 'pass' | 'fail' | 'na') => {
    const key = itemKey(item);
    setResolvingKey(key);
    const note = (notes[key] ?? '').trim();
    try {
      await api.post('/review-items/resolve', {
        kind: item.kind,
        item_score_id: item.item_score_id,
        result,
        // Optional, and only sent when the reviewer actually wrote something.
        ...(note ? { note } : {}),
      });
      setRuled((n) => n + 1);
      setNotes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // The panel belongs to a row that is about to leave the list.
      if (openEvidence.has(key)) toggleEvidence(key);
      const left = Math.max(0, total - 1);
      setAnnouncement(
        `“${item.label}” marked ${RESULT_WORDS[result]}${note ? ', with your note' : ''}. ` +
          `${left} ${plural(left, 'checkpoint', 'checkpoints')} left in this view.`
      );
      queryClient.invalidateQueries({ queryKey: ['review-items'] });
      queryClient.invalidateQueries({ queryKey: ['breaches'] });
      queryClient.invalidateQueries({ queryKey: ['breach-summary'] });
      queryClient.invalidateQueries({ queryKey: ['journeys'] });
    } catch (err) {
      await notify('Failed to resolve: ' + (err instanceof Error ? err.message : 'unknown error'));
      // Whatever went wrong, this row may no longer be this reviewer's to rule
      // on — another reviewer ruling first is the expected failure here. Refetch
      // so a checkpoint someone else has settled leaves the queue.
      queryClient.invalidateQueries({ queryKey: ['review-items'] });
    } finally {
      setResolvingKey(null);
    }
  };

  const clearFilters = () => patch({ adviser: null, severity: null });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          {/* h1, not h2: this is the page's own heading and the document had no
              level-one heading at all, so every heading below it started at 2
              with nothing above them. */}
          <h1 className="text-page-title text-text-primary">Checkpoints to review</h1>
          <p className="text-page-sub text-text-subtle mt-1">
            Checkpoints the AI could not settle on its own, held for a person to rule on.
          </p>
        </div>
      </div>

      {/* What is outstanding, and what it costs to leave it. Counted across the
          whole queue rather than under the filters below, so the figure cannot
          disappear on the click that filtered to it.

          Hidden outright when the request failed: a strip of zeros would say the
          firm is up to date, which is the one thing it must never say by
          accident. */}
      {!isError && (
        <div className="bg-card border border-border rounded-card shadow-card p-4 mb-5">
          <h2 className="text-card-label uppercase text-text-muted mb-2.5">Outstanding</h2>
          {isLoading || !summary ? (
            <div className="space-y-2">
              <Shimmer width="55%" />
              <Shimmer width="35%" />
            </div>
          ) : summary.checkpoints === 0 ? (
            <p className="text-table-cell text-text-primary">
              Nothing is waiting on a person. Every checkpoint on every scored sale has a verdict, so
              nothing is being left out of a score.
            </p>
          ) : (
            <>
              <p className="text-table-cell text-text-primary">
                <span className="font-semibold tabular-nums">{summary.checkpoints}</span>{' '}
                {plural(summary.checkpoints, 'checkpoint', 'checkpoints')} waiting on you
                <span className="text-text-muted" aria-hidden="true"> · </span>
                <span className="text-text-secondary">
                  across {summary.sales} {plural(summary.sales, 'sale', 'sales')}
                </span>
                {summary.oldest_days !== null && (
                  <>
                    <span className="text-text-muted" aria-hidden="true"> · </span>
                    <span
                      className={
                        summary.oldest_days > STALE_DAYS
                          ? 'text-review font-semibold'
                          : 'text-text-secondary'
                      }
                    >
                      oldest {waitedLabel(summary.oldest_days)}
                    </span>
                  </>
                )}
              </p>

              {/* The consequence, said once, where the numbers are. */}
              <p className="mt-2 flex items-start gap-2 text-table-cell text-text-secondary">
                <WarningIcon className="w-4 h-4 text-review shrink-0 mt-0.5" />
                <span>
                  <span className="font-semibold text-text-primary">Read with care:</span> none of
                  this counts toward a score until it is ruled on. A held checkpoint is left out of
                  its sale's denominator, so a sale can read 100% — or show no score at all — with
                  critical checkpoints still sitting here.
                </span>
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <p className="text-table-cell text-text-secondary">
                  {REVIEW_SEVERITIES.filter((s) => summary.by_severity[s] > 0)
                    .map((s) => `${summary.by_severity[s]} ${BREACH_SEVERITY_LABELS[s].toLowerCase()}`)
                    .join(', ') || 'none rated'}
                  {summary.by_severity.unrated > 0 && `, ${summary.by_severity.unrated} unrated`}
                </p>
                {summary.largest && summary.largest.count > 1 && (
                  <Link
                    to={
                      summary.largest.kind === 'journey'
                        ? `/journeys/${summary.largest.parent_id}`
                        : `/calls/${summary.largest.parent_id}`
                    }
                    className="inline-flex items-center min-h-[24px] px-1 -mx-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
                  >
                    Most held: {summary.largest.name ?? 'a sale'} ({summary.largest.count})
                  </Link>
                )}
              </div>

              {ruled > 0 && startTotal.current !== null && (
                <p className="mt-2 text-table-cell text-text-secondary">
                  You have ruled on{' '}
                  <span className="font-semibold tabular-nums text-text-primary">{ruled}</span> of the{' '}
                  <span className="tabular-nums">{startTotal.current}</span> that were waiting when
                  you opened this page.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Filters, matching the sales and calls lists: adviser and severity, in
          the URL, so a view is linkable and Back works. */}
      <div className="bg-card border border-border rounded-card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="review-adviser" className="block text-xs font-medium text-text-muted mb-1">
            Adviser
          </label>
          <AgentFilter
            id="review-adviser"
            options={data?.advisers ?? []}
            value={adviser || null}
            onChange={(v) => patch({ adviser: v })}
          />
        </div>
        <div>
          <label htmlFor="review-severity" className="block text-xs font-medium text-text-muted mb-1">
            Severity
          </label>
          <select
            id="review-severity"
            value={severity}
            onChange={(e) => patch({ severity: e.target.value })}
            className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <option value="">All severities</option>
            {REVIEW_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {BREACH_SEVERITY_LABELS[s]}
                {summary ? ` (${summary.by_severity[s]})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="review-sort" className="block text-xs font-medium text-text-muted mb-1">
            Order
          </label>
          <select
            id="review-sort"
            value={sort}
            onChange={(e) => patch({ sort: e.target.value })}
            className="px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {REVIEW_QUEUE_SORTS.map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
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

      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-xs text-text-muted">
          {isLoading
            ? 'Loading…'
            : isError
              ? ''
              : total === 0
                ? 'Nothing to review in this view'
                : `${total} ${plural(total, 'checkpoint', 'checkpoints')} across ${totalSales} ${plural(totalSales, 'sale', 'sales')}${
                    totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''
                  }`}
        </p>
        {groups.length > 0 && (
          <button
            type="button"
            onClick={() =>
              patch(
                { open: expanded.size === groups.length ? NONE : groups.map((g) => g.key).join(',') },
                true
              )
            }
            className="px-2 py-1 -mx-2 text-table-cell font-semibold text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {expanded.size === groups.length ? 'Collapse all sales' : 'Expand all sales'}
          </button>
        )}
      </div>

      {/* Announced, not just rendered: a resolved row leaves the list silently. */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>

      {isError ? (
        <div className="bg-card border border-border rounded-card p-10 text-center" role="alert">
          <div className="bg-fail-bg text-fail px-3 py-2 rounded-btn inline-block text-table-cell">
            Couldn't load the checkpoints awaiting review — this is not the same as there being none.
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
      ) : isLoading ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-card border border-border rounded-card p-5 space-y-2.5">
              <Shimmer width="45%" />
              <Shimmer width="70%" />
              <Shimmer width="60%" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-card border border-border rounded-card p-10 text-center">
          <EmptyState filtered={filtered} ruled={ruled} onClear={clearFilters} />
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <SaleSection
              key={group.key}
              group={group}
              open={expanded.has(group.key)}
              onToggle={() => toggleGroup(group.key)}
              openEvidence={openEvidence}
              onToggleEvidence={toggleEvidence}
              canAction={canAction}
              resolvingKey={resolvingKey}
              onResolve={resolve}
              notes={notes}
              onNoteChange={(key, value) => setNotes((prev) => ({ ...prev, [key]: value }))}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <button
            type="button"
            onClick={() => patch({ page: String(page - 1) }, true)}
            disabled={page === 1}
            className="px-3 py-2 -mx-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
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
            className="px-3 py-2 -mx-2 text-table-cell text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            Next
          </button>
        </div>
      )}

      {/* The breach register used to be repeated in full at the foot of this
          page — the same rows as /breaches, fewer columns and no filters — and
          the page's own title and subtitle described that copy rather than the
          checkpoints above it. A link is the honest version of a duplicate. */}
      <div className="bg-card border border-border rounded-card p-5 mt-6">
        <h2 className="text-section-title text-text-primary">Confirmed failures</h2>
        <p className="text-table-cell text-text-secondary mt-1 max-w-2xl">
          Ruling a checkpoint a failure puts it on the breach register, where it is acknowledged,
          coached, escalated or resolved. This page is only the work that has not been ruled on yet.
        </p>
        <Link
          to="/breaches"
          className="inline-flex items-center min-h-[36px] mt-2 px-1 -mx-1 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          Open the breach register
        </Link>
      </div>
    </div>
  );
}

// ── One sale's worth of work ─────────────────────────────────────────────────

interface SaleSectionProps {
  group: SaleGroup;
  open: boolean;
  onToggle: () => void;
  openEvidence: Set<string>;
  onToggleEvidence: (key: string) => void;
  canAction: boolean;
  resolvingKey: string | null;
  onResolve: (item: ManualReviewItem, result: 'pass' | 'fail' | 'na') => void;
  notes: Record<string, string>;
  onNoteChange: (key: string, value: string) => void;
}

function SaleSection({
  group,
  open,
  onToggle,
  openEvidence,
  onToggleEvidence,
  canAction,
  resolvingKey,
  onResolve,
  notes,
  onNoteChange,
}: SaleSectionProps) {
  const headingId = `sale-${group.key.replace(':', '-')}`;
  const bodyId = `${headingId}-body`;
  const stale = (group.oldestDays ?? 0) > STALE_DAYS;

  return (
    <section
      aria-labelledby={headingId}
      className="bg-card border border-border rounded-card overflow-hidden"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-5 py-2 border-b border-border bg-table-header">
        <h2 id={headingId} className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="w-full flex items-start gap-2.5 min-h-[44px] py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            <svg
              className={`w-5 h-5 mt-0.5 shrink-0 stroke-text-secondary transition-transform ${open ? 'rotate-90' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span className="min-w-0">
              <span className="block text-section-title text-text-primary truncate">{group.name}</span>
              <span className="block text-xs mt-0.5">
                <span className="text-text-secondary">{group.adviser ?? 'Not attributed'}</span>
                <span className="text-text-muted" aria-hidden="true"> · </span>
                <span className="text-text-secondary tabular-nums">
                  {group.items.length} {plural(group.items.length, 'checkpoint', 'checkpoints')}
                </span>
                <span className="text-text-muted" aria-hidden="true"> · </span>
                <span className={stale ? 'text-review font-semibold' : 'text-text-secondary'}>
                  {waitedLabel(group.oldestDays)}
                </span>
              </span>
            </span>
          </button>
        </h2>
        <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
          {group.bySeverity.map((s) => (
            <SeverityBadge key={s.severity} severity={s.severity} count={s.count} quiet />
          ))}
          <Link
            to={group.kind === 'journey' ? `/journeys/${group.parentId}` : `/calls/${group.parentId}`}
            className="inline-flex items-center min-h-[36px] px-2 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
          >
            {group.kind === 'journey' ? 'Open the sale' : 'Open the call'}
            <span className="sr-only"> for {group.name}</span>
          </Link>
        </div>
      </div>

      <div id={bodyId} hidden={!open}>
        {/* Phone: one card per checkpoint, carrying its label, its context and
            its three buttons together. Nothing has to be scrolled sideways to
            reach a decision — which on the table this replaced also took the
            checkpoint's own label off the left of the screen. */}
        <div className="sm:hidden divide-y divide-border-light">
          {group.items.map((item) => {
            const key = itemKey(item);
            return (
              <div key={key} className="px-4 py-3.5">
                <CheckpointLabel item={item} />
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {item.severity && <SeverityBadge severity={item.severity} quiet />}
                  <span className="text-xs text-text-muted">{waitedLabel(daysSince(item.detected_at))}</span>
                </div>
                <div className="mt-3">
                  <EvidenceToggle
                    open={openEvidence.has(key)}
                    label={item.label}
                    onClick={() => onToggleEvidence(key)}
                  />
                </div>
                {canAction && (
                  <div className="mt-2">
                    {/* Left-aligned on a card: the buttons follow the reading,
                        rather than hugging the far edge of a 390px screen. */}
                    <DecisionButtons item={item} busy={resolvingKey === key} onResolve={onResolve} block />
                  </div>
                )}
                {openEvidence.has(key) && (
                  <div className="mt-3 -mx-4">
                    <ReviewEvidencePanel item={item} />
                    <DecisionFooter
                      item={item}
                      variant="card"
                      canAction={canAction}
                      busy={resolvingKey === key}
                      note={notes[key] ?? ''}
                      onNoteChange={(v) => onNoteChange(key, v)}
                      onResolve={onResolve}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full min-w-[540px]">
            <caption className="sr-only">
              Checkpoints held on {group.name}, oldest first: the checkpoint, its severity, how long
              it has waited, and the ruling.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted border-b border-border">
                  Checkpoint
                </th>
                <th scope="col" className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted border-b border-border">
                  Severity
                </th>
                <th scope="col" className="text-left px-5 py-2.5 text-table-header uppercase text-text-muted border-b border-border">
                  Waiting
                </th>
                <th scope="col" className="text-right px-5 py-2.5 text-table-header uppercase text-text-muted border-b border-border">
                  Ruling
                </th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((item) => {
                const key = itemKey(item);
                const isOpen = openEvidence.has(key);
                const days = daysSince(item.detected_at);
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-border-light last:border-0 hover:bg-table-header transition-colors">
                      <td className="px-5 py-3 text-table-cell text-text-primary align-top max-w-[34rem]">
                        <CheckpointLabel item={item} />
                        <div className="mt-1">
                          <EvidenceToggle open={isOpen} label={item.label} onClick={() => onToggleEvidence(key)} />
                        </div>
                      </td>
                      <td className="px-5 py-3 align-top">
                        {item.severity ? <SeverityBadge severity={item.severity} quiet /> : <span className="text-xs text-text-muted">Unrated</span>}
                      </td>
                      <td className="px-5 py-3 align-top text-table-cell whitespace-nowrap">
                        <span
                          className={`tabular-nums ${(days ?? 0) > STALE_DAYS ? 'text-review font-semibold' : 'text-text-cell'}`}
                        >
                          {ageLabel(days)}
                        </span>
                        {/* The column header carries "waiting"; a screen reader
                            reading the cell alone should still get the sense. */}
                        <span className="sr-only"> {waitedLabel(days)}</span>
                      </td>
                      <td className="px-5 py-3 text-right align-top whitespace-nowrap">
                        {canAction ? (
                          <DecisionButtons item={item} busy={resolvingKey === key} onResolve={onResolve} />
                        ) : (
                          <span className="text-xs text-text-muted">View only</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border-light last:border-0">
                        <td colSpan={4} className="p-0">
                          <ReviewEvidencePanel item={item} />
                          <DecisionFooter
                            item={item}
                            variant="row"
                            canAction={canAction}
                            busy={resolvingKey === key}
                            note={notes[key] ?? ''}
                            onNoteChange={(v) => onNoteChange(key, v)}
                            onResolve={onResolve}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function CheckpointLabel({ item }: { item: ManualReviewItem }) {
  return (
    <span className="block text-table-cell text-text-primary">
      {item.section && <span className="text-text-muted">{item.section}: </span>}
      {item.label}
    </span>
  );
}

function EvidenceToggle({
  open,
  label,
  onClick,
}: {
  open: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    // The extra context is appended to the visible words rather than replacing
    // them with an aria-label: a speech-input user says what they can see
    // ("read the evidence"), and an aria-label that does not contain the
    // visible text leaves them with nothing to say (WCAG 2.5.3).
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="inline-flex items-center gap-1.5 min-h-[36px] px-2 -mx-2 text-table-cell font-semibold text-primary-ink hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
    >
      <svg
        className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      {open ? 'Hide the evidence' : 'Read the evidence'}
      <span className="sr-only"> for {label}</span>
    </button>
  );
}

/**
 * Pass / Fail / Not applicable. One recipe, used on the row and again at the
 * foot of the evidence panel — the decision has to be reachable from wherever
 * the reviewer happens to be, and on the screen this replaced it was 985px
 * right of the checkpoint it judged and 828px above the evidence that informed
 * it. 36px tall with a real gap between them, all three labelled, all three
 * with a focus ring: Pass and Fail had none of that, and were 24px targets 6px
 * apart.
 */
function DecisionButtons({
  item,
  busy,
  onResolve,
  block,
}: {
  item: ManualReviewItem;
  busy: boolean;
  onResolve: (item: ManualReviewItem, result: 'pass' | 'fail' | 'na') => void;
  block?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center min-h-[36px] px-3 rounded-btn border text-table-cell font-semibold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  return (
    <div
      className={`flex items-center gap-2 ${block ? 'flex-wrap' : 'flex-nowrap justify-end'}`}
    >
      <button
        type="button"
        onClick={() => onResolve(item, 'pass')}
        disabled={busy}
        className={`${base} text-pass border-pass/40 hover:bg-pass hover:text-on-solid hover:border-pass`}
      >
        Pass
        {/* Which checkpoint, for anyone who cannot see which row this is in.
            Appended to the visible word rather than replacing it — see
            EvidenceToggle. Pass and Fail had no accessible name at all. */}
        <span className="sr-only"> — mark “{item.label}” as passed</span>
      </button>
      <button
        type="button"
        onClick={() => onResolve(item, 'fail')}
        disabled={busy}
        className={`${base} text-fail border-fail/40 hover:bg-fail hover:text-on-solid hover:border-fail`}
      >
        Fail
        <span className="sr-only">
          {' '}— mark “{item.label}” as failed, which puts it on the breach register
        </span>
      </button>
      {/* Without this the only way to clear a checkpoint that could not apply
          was to pass it, which put "the adviser did this" on the register for
          something never in scope — a trust item on a product that cannot be
          placed in trust, say. 'Not applicable' drops it out of the score
          instead of passing it. */}
      <button
        type="button"
        onClick={() => onResolve(item, 'na')}
        disabled={busy}
        title="This checkpoint did not apply to this sale — excluded from the score rather than passed"
        className={`${base} text-text-secondary border-border hover:bg-table-header hover:text-text-primary hover:border-text-muted`}
      >
        N/A
        <span className="sr-only">
          {' '}— mark “{item.label}” as not applicable to this sale, which excludes it from the
          score rather than passing it
        </span>
      </button>
      {busy && <span className="text-xs text-text-muted">Saving…</span>}
    </div>
  );
}

/**
 * The foot of the evidence panel: where the reading ends, so the decision is
 * there too — with somewhere to say why. The note is optional, because the
 * queue must not become harder to clear, but on a page whose whole purpose is
 * that a person's judgement becomes the record, there has to be a place to put
 * the judgement in words. On a sale it is stored as the reason against the
 * correction; on every kind it is stamped on the audit trail.
 */
function DecisionFooter({
  item,
  variant,
  canAction,
  busy,
  note,
  onNoteChange,
  onResolve,
}: {
  item: ManualReviewItem;
  // Which layout this copy belongs to. Both are in the DOM at once (CSS picks
  // one), so the note field needs an id of its own in each or the <label> is
  // pointing at two elements.
  variant: 'card' | 'row';
  canAction: boolean;
  busy: boolean;
  note: string;
  onNoteChange: (value: string) => void;
  onResolve: (item: ManualReviewItem, result: 'pass' | 'fail' | 'na') => void;
}) {
  const noteId = `note-${variant}-${item.kind}-${item.item_score_id}`;
  if (!canAction) {
    return (
      <div className="bg-page/60 border-t border-border-light px-5 py-3">
        <p className="text-xs text-text-muted">
          Only an administrator or supervisor can rule on a checkpoint.
        </p>
      </div>
    );
  }
  return (
    <div className="bg-page/60 border-t border-border-light px-5 py-4">
      <label htmlFor={noteId} className="block text-xs font-medium text-text-muted mb-1">
        Why you ruled this way (optional)
      </label>
      <textarea
        id={noteId}
        value={note}
        rows={2}
        maxLength={2000}
        onChange={(e) => onNoteChange(e.target.value)}
        placeholder="What you heard, and what made this a pass, a fail, or out of scope…"
        className="w-full max-w-2xl px-3 py-2 rounded-btn border border-border bg-card text-table-cell text-text-primary focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
      <p className="text-xs text-text-muted mt-1 max-w-2xl">
        Kept with the ruling and on the audit trail. It is what a later reviewer — or the FCA — reads
        to understand the decision.
      </p>
      <div className="mt-2.5">
        <DecisionButtons item={item} busy={busy} onResolve={onResolve} block />
      </div>
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

/**
 * Empty says which kind of empty. And when the reviewer emptied it themselves,
 * it says so: the old page simply unmounted the card on the last ruling, so the
 * work vanished without anybody being told it was finished.
 */
function EmptyState({
  filtered,
  ruled,
  onClear,
}: {
  filtered: boolean;
  ruled: number;
  onClear: () => void;
}) {
  if (filtered) {
    return (
      <span className="inline-flex flex-wrap items-center justify-center gap-2 text-table-cell text-text-muted">
        No checkpoints match these filters.
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center min-h-[36px] px-2 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          Clear filters
        </button>
      </span>
    );
  }
  if (ruled > 0) {
    return (
      <div className="text-table-cell text-text-secondary">
        <p className="text-section-title text-text-primary">The queue is clear.</p>
        <p className="mt-1">
          You ruled on {ruled} {plural(ruled, 'checkpoint', 'checkpoints')}.{' '}
          {ruled === 1
            ? "It now counts toward its sale's score, so that score has moved."
            : "Every one of them now counts toward its sale's score, so those scores have moved."}
        </p>
        <Link
          to="/journeys"
          className="inline-flex items-center min-h-[36px] mt-2 px-2 -mx-2 text-table-cell font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          See the sales
        </Link>
      </div>
    );
  }
  return (
    <span className="text-table-cell text-text-muted">
      Nothing is waiting on a person. Every checkpoint on every scored sale has a verdict.
    </span>
  );
}

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 9v4M12 17h.01M10.3 3.9L2.4 17.4A1.8 1.8 0 004 20.1h16a1.8 1.8 0 001.6-2.7L13.7 3.9a1.8 1.8 0 00-3.4 0z" />
    </svg>
  );
}
