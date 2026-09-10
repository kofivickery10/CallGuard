import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import type {
  RemediationBacklogAdviser,
  RemediationBacklogItem,
  RemediationBacklogResponse,
} from '@callguard/shared';

// Open remediations, aged, by adviser (CG-27, Phase 4 of the CG-6 scope).
//
// The sales screen answers "which sales have something outstanding?". This one
// answers the question a supervisor actually has on a Monday morning: who is
// sitting on it, and how long has it been. Same data, turned ninety degrees.
//
// Nothing here is an accusation. An adviser at the top of this list may be the
// one who was fed back the most, and an ask on an expired link is the firm's
// problem rather than theirs — which is why that case is called out on the row
// instead of ageing quietly.

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-fail-bg text-fail',
  high: 'bg-fail-bg text-fail',
  medium: 'bg-review-bg text-review',
  low: 'bg-table-header text-text-muted',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

// "9 days" / "today". Written out rather than shown as "9d" because this is
// prose in a card, not a column in a table.
function ageLabel(days: number): string {
  if (days <= 0) return 'today';
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`w-4 h-4 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function ItemRow({ item }: { item: RemediationBacklogItem }) {
  return (
    <li className="border-t border-border-light px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={`px-2.5 py-[3px] rounded-full text-badge font-semibold ${
            SEVERITY_CLASS[item.severity] ?? SEVERITY_CLASS.low
          }`}
        >
          {item.severity}
        </span>
        <span className="text-table-cell text-text-primary font-semibold">{item.item_label}</span>
        <Link
          to={`/journeys/${item.journey_id}`}
          className="text-table-cell text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
        >
          {item.customer_name || 'the sale'}
        </Link>
        <span className="ml-auto text-table-cell text-text-secondary whitespace-nowrap">
          open {ageLabel(item.days_open)}
        </span>
      </div>

      {/* What the firm asked for, in the firm's own words as it was sent. The
          point of the row: a supervisor chasing this needs to see the
          instruction, not just that one exists. */}
      <p className="text-table-cell text-text-secondary mt-2 leading-relaxed">
        <span className="font-semibold text-text-primary">Asked: </span>
        {item.remediation_guidance}
      </p>

      <p className="text-xs text-text-muted mt-1.5">
        Fed back {formatDate(item.told_at)}, acknowledged {formatDate(item.acknowledged_at)}
      </p>

      {/* Not decoration: chasing an adviser whose link has expired asks them to
          do something they cannot do. The feedback has to go again. */}
      {item.link_expired && (
        <p className="text-xs text-review mt-1.5 flex items-center gap-1.5">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="w-3.5 h-3.5 shrink-0"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16.5h.01" />
          </svg>
          Their link has expired — they can no longer answer this one. Send the feedback again.
        </p>
      )}
    </li>
  );
}

function AdviserCard({ adviser }: { adviser: RemediationBacklogAdviser }) {
  // Collapsed until asked for. The cards are already ordered worst-first and
  // carry the two numbers a supervisor is triaging on, so opening every one of
  // them by default turns a queue into a wall of guidance text.
  const [open, setOpen] = useState(false);
  const panelId = `remediation-items-${adviser.adviser_key}`;

  return (
    <div className="bg-card border border-border rounded-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full text-left px-5 py-4 flex flex-wrap items-center gap-x-4 gap-y-2 hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <ChevronIcon open={open} />
        <div className="min-w-0">
          <p className="text-table-cell text-text-primary font-semibold truncate">
            {adviser.adviser_name}
          </p>
          <p className="text-xs text-text-muted truncate">{adviser.adviser_email}</p>
        </div>
        <div className="ml-auto flex items-center gap-6">
          <div className="text-right">
            <p className="text-xs text-text-muted">Open</p>
            <p className="text-card-value text-text-primary tabular-nums">{adviser.open_count}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-text-muted">Oldest</p>
            {/* The headline number. A backlog with an age is being managed; one
                without is a list. */}
            <p
              className={`text-card-value tabular-nums ${
                adviser.oldest_open_days > 0 ? 'text-review' : 'text-text-primary'
              }`}
            >
              {ageLabel(adviser.oldest_open_days)}
            </p>
          </div>
        </div>
      </button>

      {open && (
        <ul id={panelId}>
          {adviser.items.map((item) => (
            <ItemRow key={item.feedback_item_id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function RemediationBacklog() {
  // Scorecards are admin-only, so the pointer to them is too: a supervisor sent
  // to a page they cannot open learns nothing and loses their place.
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['remediation-backlog'],
    queryFn: () => api.get<RemediationBacklogResponse>('/remediations'),
  });

  const advisers = data?.advisers ?? [];

  return (
    <div>
      <div className="mb-7">
        <h2 className="text-page-title text-text-primary">Remediation</h2>
        <p className="text-page-sub text-text-subtle mt-1">
          What has been asked of advisers and not yet closed. A finding appears here once the
          adviser has acknowledged the feedback and has not said what they did about the step your
          firm set for it.
        </p>
      </div>

      {data && data.total_open > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">Open remediations</p>
            <p className="text-card-value text-text-primary tabular-nums">{data.total_open}</p>
          </div>
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">Advisers</p>
            <p className="text-card-value text-text-primary tabular-nums">
              {data.advisers_with_open}
            </p>
          </div>
          <div className="bg-card border border-border rounded-card px-4 py-3">
            <p className="text-xs text-text-muted">Oldest</p>
            <p
              className={`text-card-value tabular-nums ${
                data.oldest_open_days != null && data.oldest_open_days > 0
                  ? 'text-review'
                  : 'text-text-primary'
              }`}
            >
              {data.oldest_open_days == null ? '—' : ageLabel(data.oldest_open_days)}
            </p>
          </div>
        </div>
      )}

      {/* Says so rather than letting a cut list read as the whole backlog. */}
      {data?.truncated && (
        <div className="mb-5 rounded-card border border-border bg-review-bg px-4 py-3 text-table-cell text-text-primary">
          Showing the {data.total_open} oldest open remediations. There are more than this — work
          these down and the rest will appear.
        </div>
      )}

      <div aria-live="polite">
        {isLoading && (
          <div className="bg-card border border-border rounded-card px-5 py-8 text-table-cell text-text-subtle">
            Loading…
          </div>
        )}

        {isError && (
          <div
            role="alert"
            className="bg-card border border-border rounded-card px-5 py-8 text-table-cell text-fail"
          >
            Could not load the remediation backlog. Refresh to try again.
          </div>
        )}

        {/* Empty is the good state here, and it is worth saying which kind of
            empty it is: a firm that has written no guidance has nothing to see
            rather than nothing outstanding, and the two read identically
            otherwise. */}
        {!isLoading && !isError && advisers.length === 0 && (
          <div className="bg-card border border-border rounded-card px-5 py-8">
            <p className="text-table-cell text-text-primary font-semibold">Nothing outstanding.</p>
            <p className="text-table-cell text-text-subtle mt-1.5">
              Every step your firm has set on an acknowledged finding has been answered. If you
              expected to see something here, check that the checkpoint has remediation guidance on
              it — a checkpoint with none has no step for an adviser to close.
            </p>
            {isAdmin && (
              <Link
                to="/scorecards"
                className="inline-block mt-3 text-table-cell font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                Go to scorecards
              </Link>
            )}
          </div>
        )}

        {advisers.length > 0 && (
          <div className="space-y-3">
            {advisers.map((a) => (
              <AdviserCard key={a.adviser_key} adviser={a} />
            ))}
          </div>
        )}
      </div>

      {/* The definition travels with the screen, so a figure read off it into a
          board paper carries what it actually counts. */}
      {data && (
        <p className="text-xs text-text-muted mt-5 leading-relaxed max-w-3xl">{data.note}</p>
      )}
    </div>
  );
}
