interface ScoreGaugeProps {
  score: number;
  size?: 'sm' | 'lg';
  showBar?: boolean;
}

export function ScoreGauge({ score, size = 'sm', showBar = false }: ScoreGaugeProps) {
  const roundedScore = Math.round(score);
  const fillColor =
    roundedScore >= 80 ? 'bg-primary' : roundedScore >= 65 ? 'bg-review' : 'bg-fail';
  const textColor =
    roundedScore >= 80 ? 'text-pass' : roundedScore >= 65 ? 'text-review' : 'text-fail';

  if (showBar) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-block w-[50px] h-[5px] bg-border rounded-[3px] overflow-hidden">
          <span
            className={`block h-full rounded-[3px] ${fillColor}`}
            style={{ width: `${roundedScore}%` }}
          />
        </span>
        <span className={`text-table-cell font-semibold ${textColor}`}>
          {roundedScore}%
        </span>
      </span>
    );
  }

  if (size === 'lg') {
    return (
      <span className={`text-[22px] font-bold ${textColor}`}>
        {roundedScore}%
      </span>
    );
  }

  return (
    <span className={`text-table-cell font-semibold ${textColor}`}>
      {roundedScore}%
    </span>
  );
}
