import { useTheme } from './theme';

// Recharts paints series/grid/tick colours as SVG attributes, which don't
// resolve CSS var(), so we mirror the app's semantic tokens as concrete values
// for each theme. Series colours re-theme too, so e.g. fail-red lightens on dark
// to stay legible — matching the --cg-* tokens in src/index.css.
//
// This lives here rather than beside one chart because every chart in the app
// needs the same values: a second copy would drift from the tokens the moment
// one of them changed.
export interface ChartColors {
  primary: string;
  fail: string;
  high: string;
  review: string;
  processing: string;
  neutral: string;
  grid: string;
  tick: string;
}

export const CHART_COLORS: Record<'light' | 'dark', ChartColors> = {
  light: {
    primary: '#4a9e6e',
    fail: '#c0392b',
    high: '#e57766',
    review: '#b8860b',
    processing: '#2d5a9e',
    neutral: '#c2c5c5',
    grid: '#c2c5c5',
    tick: '#8a9e8a',
  },
  dark: {
    primary: '#57ab7a',
    fail: '#f0726a',
    high: '#e8938c',
    review: '#d6a838',
    processing: '#6f9bdb',
    neutral: '#4a554e',
    grid: '#2b3630',
    tick: '#8a9c8d',
  },
};

/** The chart palette for the active theme. */
export function useChartColors(): ChartColors {
  const { theme } = useTheme();
  return theme === 'dark' ? CHART_COLORS.dark : CHART_COLORS.light;
}

/**
 * Shared Recharts tooltip styling, so every tooltip sits on the card surface
 * rather than Recharts' default white box (which is invisible in dark mode).
 */
export const TOOLTIP_STYLE = {
  background: 'rgb(var(--cg-card))',
  border: '1px solid rgb(var(--cg-border))',
  borderRadius: 6,
  fontSize: 12,
} as const;

export const TOOLTIP_LABEL_STYLE = { color: 'rgb(var(--cg-text-primary))' } as const;
