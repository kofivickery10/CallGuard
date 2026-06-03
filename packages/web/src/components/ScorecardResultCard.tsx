import { useState } from 'react';

interface ScorecardResultCardProps {
  label: string;
  score: number;
  scoreType: string;
  normalizedScore: number;
  confidence: number | null;
  evidence: string | null;
  reasoning: string | null;
  canCorrect?: boolean;
  wasCorrected?: boolean;
  onCorrect?: () => void;
}

export function ScorecardResultCard({
  label,
  score,
  scoreType,
  normalizedScore,
  confidence,
  evidence,
  reasoning,
  canCorrect,
  wasCorrected,
  onCorrect,
}: ScorecardResultCardProps) {
  const passed = normalizedScore >= 70;
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Boolean(evidence || reasoning);

  return (
    <div className="border-b border-border-light last:border-0">
      <div className="flex justify-between items-center py-[11px] px-5 text-table-cell">
        <div className="flex-1 pr-4 min-w-0">
          <div className="text-text-secondary">{label}</div>
          {wasCorrected && (
            <div className="text-[11px] text-primary font-semibold mt-0.5 uppercase tracking-wider">
              Human-corrected
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {hasDetails && (
            <button
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="text-[11px] text-text-muted hover:text-text-secondary font-medium"
            >
              {expanded ? 'Hide' : 'Details'}
            </button>
          )}
          {canCorrect && onCorrect && (
            <button
              onClick={onCorrect}
              className="text-[11px] text-primary hover:text-primary-hover font-semibold"
            >
              Correct
            </button>
          )}
          {scoreType === 'binary' ? (
            <span className={`px-2.5 py-[3px] rounded-[20px] text-badge font-semibold ${
              passed ? 'bg-pass-bg text-pass' : 'bg-fail-bg text-fail'
            }`}>
              {passed ? 'Pass' : 'Fail'}
            </span>
          ) : (
            <span className={`px-2.5 py-[3px] rounded-[20px] text-badge font-semibold ${
              passed ? 'bg-pass-bg text-pass' : normalizedScore >= 50 ? 'bg-review-bg text-review' : 'bg-fail-bg text-fail'
            }`}>
              {score}/{scoreType === 'scale_1_5' ? '5' : '10'}
            </span>
          )}
        </div>
      </div>

      {expanded && hasDetails && (
        <div className="px-5 pb-4 -mt-0.5">
          <div className="rounded-lg bg-table-header border border-border-light p-3.5">
            {evidence && (
              <>
                <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1.5">
                  Evidence from the call
                </div>
                <blockquote className="text-[13px] text-text-secondary italic border-l-2 border-primary pl-3 leading-relaxed">
                  {evidence}
                </blockquote>
              </>
            )}
            {reasoning && (
              <>
                <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mt-3 mb-1.5">
                  Why
                </div>
                <p className="text-[13px] text-text-secondary leading-relaxed">{reasoning}</p>
              </>
            )}
            {confidence != null && (
              <div className="text-[11px] text-text-muted mt-3">
                AI confidence: {Math.round(confidence * 100)}%
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
