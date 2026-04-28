import { Link } from 'react-router-dom';
import type { CallCoaching, Plan } from '@callguard/shared';
import { hasFeature, PLAN_LABELS } from '@callguard/shared';

interface CoachingPanelProps {
  coaching: CallCoaching | null;
  plan: Plan;
  callStatus: string;
  isAdmin: boolean;
  priorCoachingCount?: number;
}

export function CoachingPanel({ coaching, plan, callStatus, isAdmin, priorCoachingCount }: CoachingPanelProps) {
  const coachingEnabled = hasFeature(plan, 'coaching');

  // Not on a paid plan - show soft upgrade prompt
  if (!coachingEnabled) {
    return (
      <div className="bg-white border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-[15px] font-semibold text-text-primary flex items-center gap-2">
            Coaching
            <span className="text-[10px] font-semibold uppercase tracking-wider bg-secondary/20 text-secondary-700 px-1.5 py-0.5 rounded">
              Premium
            </span>
          </h3>
        </div>
        <div className="p-6 text-center">
          <p className="text-table-cell text-text-subtle mb-3">
            AI-generated coaching - strengths, improvements, and next actions for every call - is available on the Growth plan and above.
          </p>
          {isAdmin ? (
            <Link
              to="/settings"
              className="inline-block bg-primary text-white px-4 py-2 rounded-btn text-table-cell font-semibold hover:bg-primary-hover transition-colors"
            >
              Upgrade your plan
            </Link>
          ) : (
            <p className="text-[12px] text-text-muted">
              Ask your admin to upgrade to {PLAN_LABELS.growth} or {PLAN_LABELS.pro} to enable this feature.
            </p>
          )}
        </div>
      </div>
    );
  }

  // Coaching enabled but not yet generated
  if (!coaching) {
    return (
      <div className="bg-white border border-border rounded-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-[15px] font-semibold text-text-primary">Coaching</h3>
        </div>
        <div className="p-6 text-center text-table-cell text-text-muted">
          {callStatus === 'scored'
            ? 'No coaching generated for this call. Re-score it to produce coaching.'
            : 'Coaching will appear here once the call is scored.'}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-border rounded-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-text-primary flex items-center gap-2">
          Coaching
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2l3 7h7l-5.5 4 2 7L12 16l-6.5 4 2-7L2 9h7z" />
            </svg>
            AI-generated
          </span>
        </h3>
      </div>
      <div className="p-5 space-y-5">
        {/* Summary */}
        <p className="text-table-cell text-text-primary leading-relaxed italic">
          &ldquo;{coaching.summary}&rdquo;
        </p>

        {/* Three columns */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <CoachingList
            title="Strengths"
            items={coaching.strengths}
            icon="check"
            color="pass"
          />
          <CoachingList
            title="To Improve"
            items={coaching.improvements}
            icon="target"
            color="review"
          />
          <CoachingList
            title="Next Actions"
            items={coaching.next_actions}
            icon="arrow"
            color="processing"
          />
        </div>

        {priorCoachingCount && priorCoachingCount > 0 ? (
          <div className="pt-3 border-t border-border-light flex items-center gap-1.5 text-[11px] text-text-muted">
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 8v4l3 3" />
              <circle cx="12" cy="12" r="10" />
            </svg>
            Built on coaching from {priorCoachingCount} previous {priorCoachingCount === 1 ? 'call' : 'calls'} with this agent
          </div>
        ) : null}
      </div>
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
  color: 'pass' | 'review' | 'processing';
}) {
  const bgClass = {
    pass: 'bg-pass-bg',
    review: 'bg-review-bg',
    processing: 'bg-processing-bg',
  }[color];
  const textClass = {
    pass: 'text-pass',
    review: 'text-review',
    processing: 'text-processing',
  }[color];

  return (
    <div>
      <div className={`flex items-center gap-1.5 mb-2 ${textClass}`}>
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
          {icon === 'check' && <path d="M5 13l4 4L19 7" />}
          {icon === 'target' && (
            <>
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
          {icon === 'arrow' && <path d="M5 12h14M13 6l6 6-6 6" />}
        </svg>
        <span className="text-[12px] font-semibold uppercase tracking-wider">{title}</span>
      </div>
      <ul className={`${bgClass} rounded-btn p-3 space-y-2`}>
        {items.map((item, i) => (
          <li key={i} className="text-table-cell text-text-cell leading-relaxed">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
