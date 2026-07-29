import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// 四套主题：玻璃霓虹(默认) / 浅色极简 / 赛博全息 / 琥珀金
export const THEMES = [
  { id: 'glass', name: '玻璃霓虹' },
  { id: 'light', name: '浅色极简' },
  { id: 'cyber', name: '赛博全息' },
  { id: 'amber', name: '琥珀金' }
] as const

export type ThemeId = (typeof THEMES)[number]['id']

interface ThemeState {
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
  cycleTheme: () => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'glass',
      setTheme: (theme) => set({ theme }),
      cycleTheme: () => {
        const index = THEMES.findIndex((item) => item.id === get().theme)
        set({ theme: THEMES[(index + 1) % THEMES.length].id })
      }
    }),
    { name: 'ai-player-theme' }
  )
)

// 把当前主题写到 <html data-theme="...">，CSS 变量按选择器生效
export function applyThemeToDocument(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
}
