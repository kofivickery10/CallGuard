import { ItemResultBadge } from './ItemResultBadge';
import { EvidenceExcerpt } from './EvidenceExcerpt';
import { formatClock } from '../lib/format';
import { isItemPass, BREACH_SEVERITY_LABELS } from '@callguard/shared';
import type { BreachSeverity, ItemResult } from '@callguard/shared';

const SEVERITY_WORDS: Record<BreachSeverity, string> = BREACH_SEVERITY_LABELS;

export interface CheckpointRowItem {
  id: string;
  label: string;
  section: string | null;
  result: ItemResult;
  severity: BreachSeverity | null;
  evidence: string | null;
  reasoning: string | null;
  normalized_score: number | null;
  source_call_id: string | null;
  source_timestamp: number | null;
  applies_to_products: string[] | null;
}

interface CheckpointRowProps {
  item: CheckpointRowItem;
  open: boolean;
  onToggle: () => void;
  /** "Call 2" — which call in the sale the evidence came from. */
  callLabel: string | null;
  /** Product names this checkpoint is scoped to, for explaining an N/A. */
  productNames: string[];
  canAction: boolean;
  canCorrect: boolean;
  onCorrect: () => void;
  onResolve: (result: 'pass' | 'fail' | 'na') => void;
  resolving: boolean;
  /** The firm's pass mark, which decides a provisional verdict's pass or fail. */
  passThreshold: number;
}

/**
 * One checkpoint on a sale: the verdict, what it was decided on, and where in
 * the call that was said.
 *
 * Collapsed, it answers "what happened and when" from data the sale already
 * carries. The transcript excerpt behind the verdict is fetched only when the
 * row is opened — a sale runs to forty-odd checkpoints, and loading every
 * excerpt would be a transcript read each.
 */
export function CheckpointRow({
  item,
  open,
  onToggle,
  callLabel,
  productNames,
  canAction,
  canCorrect,
  onCorrect,
  onResolve,
  resolving,
  passThreshold,
}: CheckpointRowProps) {
  const bodyId = `checkpoint-body-${item.id}`;
  const isScored = item.result === 'pass' || item.result === 'fail';
  const moment = [callLabel, item.source_timestamp != null ? formatClock(Number(item.source_timestamp)) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div id={`checkpoint-${item.id}`} className="border-b border-border-light last:border-0 scroll-mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[124px_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-5 py-3 hover:bg-table-header transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <span className="sm:row-start-1 sm:col-start-1">
          <ItemResultBadge result={item.result} />
        </span>

        <span className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-2 min-w-0">
          <span className="block text-table-cell text-text-primary">{item.label}</span>
          {item.section && (
            <span className="block text-xs text-text-secondary mt-0.5">{item.section}</span>
          )}
        </span>

        <span className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-3 flex items-center gap-3 sm:justify-end">
          {/* Severity as a word, not a second tinted chip: one coloured pill per
              row keeps forty rows scannable. Only critical keeps its colour,
              because critical alone fails a sale whatever it scores. */}
          {item.result === 'fail' && item.severity && (
            <span
              className={`text-xs ${
                item.severity === 'critical' ? 'text-fail font-semibold' : 'text-text-secondary font-medium'
              }`}
            >
              {SEVERITY_WORDS[item.severity]}
            </span>
          )}
          {moment ? (
            <span className="text-xs text-text-secondary tabular-nums">{moment}</span>
          ) : (
            item.result !== 'na' && (
              <span className="text-xs text-text-secondary">Not tied to one call</span>
            )
          )}
          <svg
            className={`w-4 h-4 text-text-secondary transition-transform ${open ? 'rotate-90' : ''}`}
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
        <div id={bodyId} className="px-5 pb-4 sm:pl-[152px] space-y-3">
          {/* Held for a person to confirm. That happens for more than one reason —
              the speaker could not be told apart, the AI's confidence fell below
              the firm's floor, or repeat scoring runs disagreed — so the reason is
              not guessed at here; the verdict is stated as provisional. */}
          {item.result === 'manual_review' && item.normalized_score != null && (
            <p className="text-table-cell text-text-secondary">
              The AI's provisional verdict is{' '}
              <span
                className={`font-semibold ${
                  isItemPass(Number(item.normalized_score), passThreshold) ? 'text-pass' : 'text-fail'
                }`}
              >
                {isItemPass(Number(item.normalized_score), passThreshold) ? 'Pass' : 'Fail'}
              </span>
              . It was held for a person to confirm: read the lines and decide.
            </p>
          )}

          {item.result === 'na' && (
            <p className="text-table-cell text-text-secondary">
              {productNames.length > 0
                ? `Not required for this sale's products — only scored for ${productNames.join(', ')}.`
                : 'Not required for this sale.'}
            </p>
          )}

          {item.result !== 'na' && (
            <EvidenceExcerpt
              kind="journey"
              itemScoreId={item.id}
              quote={item.evidence}
              sourceCallId={item.source_call_id}
              label={item.label}
              callLabel={callLabel}
              aiAssessed={item.normalized_score != null}
            />
          )}

          {item.reasoning && (
            <p className="text-table-cell text-text-secondary leading-relaxed border-t border-border-light pt-3">
              {/* Labelled as the AI's, not as the reason for the verdict: a person
                  may since have overruled it, and the reasoning is kept. */}
              <span className="font-semibold text-text-primary">The AI's reasoning: </span>
              {item.reasoning}
            </p>
          )}

          {item.result === 'manual_review' && canAction && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-table-cell text-text-secondary mr-1">Your verdict</span>
              <button
                type="button"
                onClick={() => onResolve('pass')}
                disabled={resolving}
                aria-label={`Mark "${item.label}" as passed`}
                className="min-h-[32px] px-3 py-1.5 rounded-btn text-table-cell font-semibold text-pass border border-pass/40 hover:bg-pass hover:text-on-solid hover:border-pass disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => onResolve('fail')}
                disabled={resolving}
                aria-label={`Mark "${item.label}" as failed`}
                className="min-h-[32px] px-3 py-1.5 rounded-btn text-table-cell font-semibold text-fail border border-fail/40 hover:bg-fail hover:text-on-solid hover:border-fail disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Fail
              </button>
              {/* See ReviewQueue.tsx: passing a checkpoint that could not apply
                  is what put "the adviser did this" on the register for
                  something never in scope. */}
              <button
                type="button"
                onClick={() => onResolve('na')}
                disabled={resolving}
                aria-label={`Mark "${item.label}" as not applicable to this sale`}
                title="Excluded from the score rather than passed"
                className="min-h-[32px] px-3 py-1.5 rounded-btn text-table-cell font-semibold text-text-secondary border border-border hover:bg-table-header hover:text-text-primary disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Didn't apply
              </button>
            </div>
          )}

          {isScored && canCorrect && (
            <div className="pt-1">
              <button
                type="button"
                onClick={onCorrect}
                aria-label={`Correct the verdict on "${item.label}"`}
                title="Saved as a calibration example for the AI"
                className="min-h-[32px] px-3 py-1.5 rounded-btn border border-border text-table-cell font-semibold text-text-cell hover:bg-sidebar-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Correct this verdict
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
