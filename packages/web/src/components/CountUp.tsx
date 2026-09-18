import { useCountUp } from '../hooks/useCountUp';

interface CountUpProps {
  value: number | string | null | undefined;
  suffix?: string;
  className?: string;
  durationMs?: number;
}

/**
 * Renders `value` as a number that animates from 0 to its final value on
 * mount. Strings or non-finite values pass through unchanged so this is
 * safe to drop in anywhere a stat is rendered.
 */
export function CountUp({ value, suffix = '', className, durationMs }: CountUpProps) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const animated = useCountUp(numeric, durationMs);

  if (numeric == null) {
    return <span className={className}>{value ?? '-'}{suffix && value != null && value !== '-' ? suffix : ''}</span>;
  }

  return (
    <span className={`tabular-nums ${className ?? ''}`}>
      {/* Grouped, so a five-figure call count reads as 8,848 rather than 8848. */}
      {Math.round(animated).toLocaleString('en-GB')}{suffix}
    </span>
  );
}
