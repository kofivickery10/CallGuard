import type { ReactNode } from 'react';

interface ReviewSectionProps {
  /** Stable id: the header's feedback action scrolls to it. */
  id: string;
  title: string;
  /** One line saying where this part of the review stands. */
  summary: ReactNode;
  /** What opening it lets you do — "Show", "Review and send". */
  actionLabel: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * One row of a sale's after-the-review stack: a heading, one line of status,
 * and the full panel opened in place when asked for.
 *
 * Exists because the sale page used to show coaching, data capture,
 * reconciliation and the feedback form fully open, one after another, so the
 * page kept going long after the findings were dealt with. Each now states
 * where it stands in a line; the panel mounts only once opened, so nothing it
 * loads or polls costs anything until someone wants it.
 */
export function ReviewSection({
  id,
  title,
  summary,
  actionLabel,
  open,
  onToggle,
  children,
}: ReviewSectionProps) {
  const bodyId = `${id}-body`;
  return (
    <div id={id} className="border-b border-border-light last:border-0 scroll-mt-6">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[170px_minmax(0,1fr)_auto] gap-x-4 gap-y-1 items-center px-5 py-4 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <span className="text-section-title text-text-primary">{title}</span>
        <span className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto min-w-0 text-table-cell text-text-secondary sm:truncate">
          {summary}
        </span>
        <span className="col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto inline-flex items-center gap-1 text-table-cell font-semibold text-primary-ink whitespace-nowrap">
          {open ? 'Hide' : actionLabel}
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
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>
      {open && (
        <div id={bodyId} className="border-t border-border-light">
          {children}
        </div>
      )}
    </div>
  );
}
