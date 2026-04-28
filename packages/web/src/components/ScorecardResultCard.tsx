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
  evidence,
  reasoning,
  canCorrect,
  wasCorrected,
  onCorrect,
}: ScorecardResultCardProps) {
  const passed = normalizedScore >= 70;

  return (
    <div className="flex justify-between items-center py-[11px] px-5 border-b border-border-light last:border-0 text-table-cell">
      <div className="flex-1 pr-4 min-w-0">
        <div className="text-text-secondary">{label}</div>
        {wasCorrected && (
          <div className="text-[11px] text-primary font-semibold mt-0.5 uppercase tracking-wider">
            Human-corrected
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {evidence && (
          <button
            className="text-[11px] text-text-muted hover:text-text-secondary cursor-help"
            title={`${evidence}${reasoning ? `\n\n${reasoning}` : ''}`}
          >
            Details
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
  );
}
