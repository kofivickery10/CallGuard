/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#4a9e6e',
          hover: '#3d8a5e',
          light: '#e8f0e8',
          'light-hover': '#f0f5f0',
        },
        page: '#f8faf8',
        card: '#ffffff',
        border: '#e2e8e2',
        'border-light': '#f0f5f0',
        text: {
          primary: '#1a2e1a',
          secondary: '#5a6e5a',
          muted: '#8a9e8a',
          subtle: '#6a7e6a',
          cell: '#3a4e3a',
        },
        icon: {
          muted: '#aabdaa',
        },
        pass: {
          DEFAULT: '#2d6e4a',
          bg: '#e8f5e8',
        },
        fail: {
          DEFAULT: '#c0392b',
          bg: '#fde8e8',
        },
        review: {
          DEFAULT: '#b8860b',
          bg: '#fef3e0',
        },
        processing: {
          DEFAULT: '#2d5a9e',
          bg: '#e8f0fa',
        },
        chart: {
          secondary: '#7ec49e',
        },
        speaker: {
          agent: '#2d6e4a',
          customer: '#5a5a8a',
        },
        flag: {
          bg: '#fef2f2',
          border: '#c0392b',
          text: '#9e3a3a',
        },
        table: {
          header: '#fafcfa',
          border: '#f0f5f0',
        },
        sidebar: {
          border: '#e2e8e2',
          hover: '#f0f5f0',
          active: '#e8f0e8',
        },
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
