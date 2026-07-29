/** @type {import('tailwindcss').Config} */
// 颜色全部走 CSS 变量（R G B 三元组），四套主题在 index.css 里按 [data-theme] 切换
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        player: {
          bg: 'rgb(var(--player-bg) / <alpha-value>)',
          surface: 'rgb(var(--player-surface) / <alpha-value>)',
          accent: 'rgb(var(--player-accent) / <alpha-value>)',
          accent2: 'rgb(var(--player-accent2) / <alpha-value>)'
        }
      }
    }
  },
  plugins: []
}
