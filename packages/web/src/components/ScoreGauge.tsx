import { useCountUp } from '../hooks/useCountUp';
import { useScoreOnly } from '../context/AuthContext';

interface ScoreGaugeProps {
  score: number;
  size?: 'sm' | 'lg';
  showBar?: boolean;
  // Force neutral (non-tiered) colour regardless of the logged-in tenant's
  // mode — used on the public share page, which has no auth context. When
  // omitted, the gauge follows the tenant's score-only setting.
  neutral?: boolean;
}

const tierColours = (score: number) => ({
  fill:
    score >= 80 ? 'bg-primary' : score >= 65 ? 'bg-review' : 'bg-fail',
  text:
    score >= 80 ? 'text-pass' : score >= 65 ? 'text-review' : 'text-fail',
  ringStroke:
    score >= 80 ? 'stroke-primary' : score >= 65 ? 'stroke-review' : 'stroke-fail',
});

// Score-only mode drops the green/amber/red banding so nothing reads as
// pass/fail — the score renders in the neutral brand colour instead.
const neutralColours = {
  fill: 'bg-primary',
  text: 'text-text-primary',
  ringStroke: 'stroke-primary',
};

export function ScoreGauge({ score, size = 'sm', showBar = false, neutral }: ScoreGaugeProps) {
  const scoreOnly = useScoreOnly();
  const animated = useCountUp(score);
  const display = Math.round(animated);
  const c = (neutral ?? scoreOnly) ? neutralColours : tierColours(display);

  if (showBar) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-block w-[50px] h-[5px] bg-border rounded-[3px] overflow-hidden">
          <span
            className={`block h-full rounded-[3px] transition-[width] duration-700 ease-out ${c.fill}`}
            style={{ width: `${display}%` }}
          />
        </span>
        <span className={`text-table-cell font-semibold tabular-nums ${c.text}`}>
          {display}%
        </span>
      </span>
    );
  }

  if (size === 'lg') {
    // Animated circular ring. SVG arc length 2 * pi * r = 2 * pi * 22 ≈ 138.23.
    // We animate the dashoffset proportionally to (100 - score)/100.
    const radius = 22;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - display / 100);

    return (
      <span className="relative inline-flex items-center justify-center w-[60px] h-[60px]">
        <svg
          viewBox="0 0 50 50"
          className="absolute inset-0 w-full h-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="25"
            cy="25"
            r={radius}
            fill="none"
            className="stroke-border"
            strokeWidth="3.5"
          />
          <circle
            cx="25"
            cy="25"
            r={radius}
            fill="none"
            className={`${c.ringStroke} transition-[stroke-dashoffset] duration-700 ease-out`}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className={`relative text-[15px] font-bold tabular-nums ${c.text}`}>
          {display}%
        </span>
      </span>
    );
  }

  return (
    <span className={`text-table-cell font-semibold tabular-nums ${c.text}`}>
      {display}%
    </span>
  );
}
