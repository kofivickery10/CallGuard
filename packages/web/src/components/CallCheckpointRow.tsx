import { ItemResultBadge } from './ItemResultBadge';
import { WithRedactions } from './EvidenceExcerpt';
import { formatClock } from '../lib/format';
import { isItemPass, BREACH_SEVERITY_LABELS } from '@callguard/shared';
import type { BreachSeverity, ItemResult } from '@callguard/shared';

export interface CallCheckpointItem {
  /** The item score row: what a correction or a resolution is filed against. */
  id: string;
  label: string;
  section: string | null;
  result: ItemResult;
  severity: BreachSeverity | null;
  evidence: string | null;
  reasoning: string | null;
  normalized_score: number | null;
}

export interface CheckpointPosition {
  matched: boolean;
  line_index: number | null;
  timestamp_seconds: number | null;
}

interface CallCheckpointRowProps {
  item: CallCheckpointItem;
  /** Where this checkpoint's quote sits in the call; undefined while loading. */
  position: CheckpointPosition | undefined;
  open: boolean;
  onToggle: () => void;
  /** Phone only: the transcript is a separate tab, so it has to be asked for. */
  onShowInTranscript: () => void;
  /** No transcript beside the row, so the quote has to carry the evidence. */
  transcriptShown: boolean;
  canAction: boolean;
  canCorrect: boolean;
  onCorrect: () => void;
  onResolve: (result: 'pass' | 'fail' | 'na') => void;
  resolving: boolean;
  /** The firm's pass mark, which decides a provisional verdict's pass or fail. */
  passThreshold: number;
  /** What the checkpoint was scored as part of: the sale, or this call alone. */
  scoredOn: 'sale' | 'call';
}

// The AI prefixes a sale's quote with the call it came from ("[Call 2] …"),
// which is noise on the page for that very call.
const CALL_MARKER = /^\s*\[call\s+\d+\]\s*/i;

/**
 * One checkpoint as it reads on the call it was decided on: the verdict, when
 * in the call it was decided, and what the AI decided it on.
 *
 * The evidence itself is not repeated here — the transcript beside the row is
 * showing it, with the line highlighted. What the row adds is the part a
 * transcript can't say: whether the AI quoted something real, or described
 * something that was never said, which is what most failures are.
 */
export function CallCheckpointRow({
  item,
  position,
  open,
  onToggle,
  onShowInTranscript,
  transcriptShown,
  canAction,
  canCorrect,
  onCorrect,
  onResolve,
  resolving,
  passThreshold,
  scoredOn,
}: CallCheckpointRowProps) {
  const bodyId = `call-checkpoint-body-${item.id}`;
  const isScored = item.result === 'pass' || item.result === 'fail';
  const quote = item.evidence?.replace(CALL_MARKER, '').trim() ?? '';
  const hasQuote = quote.length > 0;
  const aiAssessed = item.normalized_score != null;
  const at = position?.timestamp_seconds ?? null;

  return (
    <div id={`call-checkpoint-${item.id}`} className="border-b border-border-light last:border-0 scroll-mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
        className={`w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[96px_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-5 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 ${
          open ? 'bg-table-header' : 'hover:bg-table-header'
        }`}
      >
        <span className="sm:row-start-1 sm:col-start-1">
          <ItemResultBadge result={item.result} />
        </span>

        <span className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-2 min-w-0">
          <span className="block text-table-cell text-text-primary">{item.label}</span>
          {item.section && <span className="block text-xs text-text-secondary mt-0.5">{item.section}</span>}
        </span>

        <span className="col-span-2 sm:col-span-1 sm:row-start-1 sm:col-start-3 flex items-center gap-3 sm:justify-end">
          {/* Severity as a word, not a second tinted chip. Only critical keeps
              its colour, because critical alone fails a sale whatever it scored. */}
          {item.result === 'fail' && item.severity && (
            <span
              className={`text-xs ${
                item.severity === 'critical' ? 'text-fail font-semibold' : 'text-text-secondary font-medium'
              }`}
            >
              {BREACH_SEVERITY_LABELS[item.severity]}
            </span>
          )}
          <span className="text-xs text-text-secondary tabular-nums">
            {at != null ? formatClock(at) : position?.matched ? 'In the transcript' : hasQuote ? 'No single line' : ''}
          </span>
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
        <div id={bodyId} className="px-5 pb-4 sm:pl-[124px] space-y-3">
          {/* Held for a person to confirm. That happens for more than one reason
              — the speaker could not be told apart, the AI's confidence fell
              below the firm's floor, or repeat scoring runs disagreed — so the
              reason is not guessed at; the verdict is stated as provisional. */}
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
            <p className="text-table-cell text-text-secondary">Not required for this {scoredOn}.</p>
          )}

          {!hasQuote && item.result !== 'na' && (
            <p className="text-table-cell text-text-secondary leading-relaxed">
              {aiAssessed
                ? `No relevant evidence was found ${scoredOn === 'sale' ? "on the sale's calls" : 'on this call'} for this checkpoint.`
                : 'Not assessed by the AI — this checkpoint is decided by a reviewer.'}
            </p>
          )}

          {hasQuote && position?.matched && transcriptShown && (
            <p className="text-table-cell text-text-secondary">
              {at != null ? (
                <>
                  Said at <span className="font-semibold text-text-primary tabular-nums">{formatClock(at)}</span>,
                  highlighted in the transcript.
                </>
              ) : (
                'Highlighted in the transcript.'
              )}{' '}
              <button
                type="button"
                onClick={onShowInTranscript}
                className="lg:hidden font-semibold text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                Show it
              </button>
            </p>
          )}

          {/* The quote stands on its own where the transcript isn't beside it,
              or where the AI's wording matched nothing in it. The second case is
              most failures: what the AI reports is that something was never
              said, and there is no line to point at. */}
          {hasQuote && (!transcriptShown || position?.matched === false) && (
            <>
              <blockquote className="text-table-cell text-text-cell border-l-2 border-border pl-3 leading-relaxed">
                <WithRedactions text={quote} />
              </blockquote>
              <p className="text-xs text-text-secondary">
                {!transcriptShown
                  ? 'Your firm keeps some personal details in its transcripts, so the conversation around this quote is shown to administrators only.'
                  : 'This wording was not found in the transcript — the AI may have paraphrased it, or be reporting that it was never said. Read the call to check.'}
              </p>
            </>
          )}

          {item.reasoning && (
            <p className="text-table-cell text-text-secondary leading-relaxed border-t border-border-light pt-3">
              {/* Labelled as the AI's, not as the reason for the verdict: a
                  person may since have overruled it, and the reasoning is kept. */}
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
              <button
                type="button"
                onClick={() => onResolve('na')}
                disabled={resolving}
                aria-label={`Mark "${item.label}" as not applicable to this ${scoredOn}`}
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
