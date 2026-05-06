import { useEffect, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export function useCountUp(target: number | null | undefined, durationMs = 900): number {
  const [value, setValue] = useState<number>(() => {
    if (target == null) return 0;
    return prefersReducedMotion() ? target : 0;
  });

  useEffect(() => {
    if (target == null) {
      setValue(0);
      return;
    }
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }

    const start = performance.now();
    const from = 0;
    let raf = 0;

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      setValue(from + (target - from) * easeOutCubic(t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);

  return value;
}
