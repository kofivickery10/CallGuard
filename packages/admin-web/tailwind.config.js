/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#4a9e6e', hover: '#3d8a5e' },
        page: '#f4f6f4',
        border: '#e2e8e2',
        text: {
          primary: '#1a2e1a',
          secondary: '#5a6e5a',
          muted: '#8a9e8a',
        },
        pass:    { DEFAULT: '#2d6e4a', bg: '#e8f5e8' },
        fail:    { DEFAULT: '#c0392b', bg: '#fde8e8' },
        review:  { DEFAULT: '#b8860b', bg: '#fef3e0' },
        processing: { DEFAULT: '#2d5a9e', bg: '#e8f0fa' },
      },
      fontFamily: { sans: ['Inter', '-apple-system', 'sans-serif'] },
      borderRadius: { card: '10px', btn: '8px' },
    },
  },
  plugins: [],
};
