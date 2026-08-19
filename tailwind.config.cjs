/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./apps/miniapp/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#18203a',
        canvas: '#f3f5fb',
        accent: '#4f6bf8',
        violet: '#8b5cf6',
      },
      boxShadow: {
        soft: '0 12px 32px rgba(37,53,110,.08)',
        glow: '0 8px 22px rgba(79,107,248,.26)',
      },
    },
  },
  plugins: [],
};
