import { RISK_LEVEL_LABELS, type RiskLevel } from '@callguard/shared';

const classMap: Record<RiskLevel, string> = {
  high_risk: 'bg-fail-bg text-fail font-bold',
  elevated: 'bg-review-bg text-review',
  monitor: 'bg-primary-light text-processing',
  low_risk: 'bg-table-header text-text-muted',
  compliant: 'bg-pass-bg text-pass',
};

export function RiskLevelBadge({ level }: { level: RiskLevel }) {
  return (
    <span
      className={`px-2.5 py-[3px] rounded-[20px] text-badge font-semibold uppercase tracking-wider ${classMap[level]}`}
    >
      {RISK_LEVEL_LABELS[level]}
    </span>
  );
}
