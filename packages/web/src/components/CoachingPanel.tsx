import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Plan } from '@callguard/shared';
import { hasFeature, parseCoaching, PLAN_LABELS } from '@callguard/shared';

interface CoachingPanelProps {
  // Deliberately `unknown`, not CallCoaching: the brief is free-form model
  // output stored in a JSONB column, so what arrives here is only *usually* the
  // declared shape. It is validated below rather than trusted — an unreadable
  // brief has to degrade to a message, not take the sale page down with it.
  coaching: unknown;
  plan: Plan | null;
  callStatus: string;
  isAdmin: boolean;
  priorCoachingCount?: number;
  // What the coaching is about — journeys reuse this panel and the copy must
  // not say "this call" on a journey page.
  subject?: 'call' | 'journey';
  // Rendered inside a section that already carries the "Coaching" heading (the
  // sale page's after-the-review rows), so the panel drops its own card and
  // title rather than nesting a card inside a card.
  embedded?: boolean;
}

export function CoachingPanel({ coaching: rawCoaching, plan, callStatus, isAdmin, priorCoachingCount, subject = 'call', embedded = false }: CoachingPanelProps) {
  const coaching = parseCoaching(rawCoaching);
  // Something was stored, but it is not a brief we can render. Said plainly:
  // "no coaching was generated" would be untrue, and would send someone looking
  // in the wrong place for a brief that exists but is malformed.
  const unreadable = rawCoaching != null && coaching === null;
  // Coaching ships on every plan (see FEATURES.coaching in shared) — hasFeature
  // only returns false here while `plan` hasn't loaded yet, never because a
  // real plan lacks it. Show the upgrade prompt only for an actual gated
  // plan; treat `plan` being unset as still-loading, not "not on your plan".
  const coachingEnabled = plan ? hasFeature(plan, 'coaching') : true;

  const shell = (title: ReactNode, body: ReactNode) =>
    embedded ? (
      <div>{body}</div>
    ) : (
      <div className="bg-card border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-section-title text-text-primary flex items-center gap-2">{title}</h3>
        </div>
        {body}
      </div>
    );

  if (plan && !coachingEnabled) {
    return shell(
      <>
        Coaching
        <span className="text-badge font-semibold bg-secondary-bg text-secondary px-2 py-0.5 rounded-full">
          Premium
        </span>
      </>,
      <div className="p-6 text-center">
        <p className="text-table-cell text-text-secondary mb-3">
          AI-generated coaching - strengths, improvements, and next actions for every {subject === 'journey' ? 'sale' : 'call'} - is available on the {PLAN_LABELS.professional} plan and above.
        </p>
        {isAdmin ? (
          <Link
            to="/settings/organization"
            className="inline-block bg-primary-ink text-on-solid px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-ink-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Upgrade your plan
          </Link>
        ) : (
          <p className="text-xs text-text-secondary">
            Ask your admin to upgrade to {PLAN_LABELS.professional} or {PLAN_LABELS.enterprise} to enable this feature.
          </p>
        )}
      </div>
    );
  }

  // Coaching enabled but not yet generated (or plan still loading)
  if (!coaching) {
    return shell(
      'Coaching',
      <div className="p-6 text-center text-table-cell text-text-secondary">
        {unreadable
          ? `A coaching brief was produced for this ${subject === 'journey' ? 'sale' : 'call'} but could not be read, so it is not shown. The score and checkpoints below are unaffected. Re-scoring produces a fresh brief.`
          : callStatus === 'scored'
            ? subject === 'journey'
              ? 'No coaching was generated for this sale. Coaching is produced when the sale is scored.'
              : 'No coaching generated for this call. Re-score it to produce coaching.'
            : subject === 'journey'
              ? 'Coaching will appear here once the sale is scored.'
              : 'Coaching will appear here once the call is scored.'}
      </div>
    );
  }

  return shell(
    <>
      Coaching
      <span className="text-badge font-semibold text-text-secondary bg-table-header border border-border px-2 py-0.5 rounded-full">
        AI-generated
      </span>
    </>,
    <div>
      {/* The brief is the AI's own words about the adviser, not a quote from the
          call, so it is set as ordinary text: italics and quotation marks read
          as evidence on a page where quoted evidence means something. */}
      <p className="px-5 pt-4 text-table-cell text-text-cell leading-relaxed max-w-[90ch]">
        {coaching.summary}
      </p>

      {/* Three columns, divided by hairlines rather than three tinted boxes, so
          adviser coaching never out-shouts the compliance findings above it. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border-light border-t border-border-light mt-4">
        <CoachingList title="Strengths" items={coaching.strengths} icon="check" color="pass" />
        <CoachingList title="To improve" items={coaching.improvements} icon="target" color="review" />
        <CoachingList title="Next actions" items={coaching.next_actions} icon="arrow" color="secondary" />
      </div>

      {priorCoachingCount && priorCoachingCount > 0 ? (
        <div className="px-5 py-3 border-t border-border-light flex items-center gap-1.5 text-xs text-text-secondary">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 8v4l3 3" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          Built on coaching from {priorCoachingCount} previous {priorCoachingCount === 1 ? 'call' : 'calls'} with this agent
        </div>
      ) : null}
    </div>
  );
}

function CoachingList({
  title,
  items,
  icon,
  color,
}: {
  title: string;
  items: string[];
  icon: 'check' | 'target' | 'arrow';
  color: 'pass' | 'review' | 'secondary';
}) {
  const iconClass = {
    pass: 'text-pass',
    review: 'text-review',
    secondary: 'text-text-secondary',
  }[color];

  return (
    <div className="bg-card px-5 py-4">
      <h4 className="flex items-center gap-1.5 mb-2 text-card-label uppercase text-text-secondary">
        <svg viewBox="0 0 24 24" className={`w-4 h-4 ${iconClass}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {icon === 'check' && <path d="M5 13l4 4L19 7" />}
          {icon === 'target' && (
            <>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
          {icon === 'arrow' && <path d="M5 12h14M13 6l6 6-6 6" />}
        </svg>
        {title}
      </h4>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="text-table-cell text-text-cell leading-relaxed pl-3.5 relative before:content-[''] before:absolute before:left-0.5 before:top-[0.6em] before:w-1.5 before:h-1.5 before:rounded-full before:bg-border">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
