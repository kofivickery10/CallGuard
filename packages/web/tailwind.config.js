/** @type {import('tailwindcss').Config} */

// Colours are driven by CSS custom properties (see src/index.css) so the whole
// palette can be re-themed for dark mode without touching component classes.
// Each token is an RGB triple ("74 158 110") consumed via rgb(var(--x) / <alpha>)
// so Tailwind opacity modifiers (e.g. bg-primary/10, ring-primary/40) keep working.
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: v('--cg-primary'),
          hover: v('--cg-primary-hover'),
          light: v('--cg-primary-light'),
          'light-hover': v('--cg-primary-light-hover'),
        },
        page: v('--cg-page'),
        card: v('--cg-card'),
        border: v('--cg-border'),
        'border-light': v('--cg-border-light'),
        text: {
          primary: v('--cg-text-primary'),
          secondary: v('--cg-text-secondary'),
          muted: v('--cg-text-muted'),
          subtle: v('--cg-text-subtle'),
          cell: v('--cg-text-cell'),
        },
        icon: {
          muted: v('--cg-icon-muted'),
        },
        pass: {
          DEFAULT: v('--cg-pass'),
          bg: v('--cg-pass-bg'),
        },
        fail: {
          DEFAULT: v('--cg-fail'),
          bg: v('--cg-fail-bg'),
        },
        review: {
          DEFAULT: v('--cg-review'),
          bg: v('--cg-review-bg'),
        },
        processing: {
          DEFAULT: v('--cg-processing'),
          bg: v('--cg-processing-bg'),
        },
        // Accent for star ratings and premium/highlight chips (bg-secondary,
        // text-secondary — used by PublicCallView, CoachingPanel, Layout).
        secondary: {
          DEFAULT: v('--cg-secondary'),
          bg: v('--cg-secondary-bg'),
        },
        chart: {
          secondary: v('--cg-chart-secondary'),
        },
        speaker: {
          agent: v('--cg-speaker-agent'),
          customer: v('--cg-speaker-customer'),
        },
        flag: {
          bg: v('--cg-flag-bg'),
          border: v('--cg-flag-border'),
          text: v('--cg-flag-text'),
        },
        table: {
          header: v('--cg-table-header'),
          border: v('--cg-table-border'),
        },
        sidebar: {
          border: v('--cg-sidebar-border'),
          hover: v('--cg-sidebar-hover'),
          active: v('--cg-sidebar-active'),
        },
        // A true surface token that follows the theme (replaces raw bg-white on
        // cards, drawers, modals and the sidebar so they invert in dark mode).
        surface: v('--cg-card'),
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'sans-serif'],
      },
      fontSize: {
        'page-title': ['19px', { lineHeight: '1.3', fontWeight: '700', letterSpacing: '-0.2px' }],
        'page-sub': ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        'card-label': ['11px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '0.4px' }],
        'card-value': ['24px', { lineHeight: '1.2', fontWeight: '700', letterSpacing: '-0.3px' }],
        'table-header': ['11px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '0.4px' }],
        'table-cell': ['13px', { lineHeight: '1.5', fontWeight: '400' }],
        'nav-item': ['13px', { lineHeight: '1.4', fontWeight: '500' }],
        'nav-label': ['10.5px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '0.7px' }],
        'badge': ['11px', { lineHeight: '1.4', fontWeight: '600' }],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(26,46,26,0.04)',
        md: '0 2px 8px rgba(74,158,110,0.08)',
        card: '0 1px 3px rgba(26,46,26,0.06)',
      },
      borderRadius: {
        card: '10px',
        btn: '8px',
      },
      keyframes: {
        'breach-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(192, 57, 43, 0.45)' },
          '50%':       { boxShadow: '0 0 0 6px rgba(192, 57, 43, 0)' },
        },
        'skeleton-shimmer': {
          '0%':   { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
      },
      animation: {
        'breach-pulse': 'breach-pulse 1.8s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'skeleton-shimmer': 'skeleton-shimmer 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
