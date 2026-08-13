import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface PlayerState {
  isPlaying: boolean
  volume: number
  currentTime: number
  duration: number
  isFullscreen: boolean
  // 影院模式：播放区占满整个窗口（左栏/中栏收起），双击或全屏按钮进出
  theater: boolean
  subtitleVisible: boolean
  subtitlePosition: 'high' | 'middle' | 'low'
  mediaName: string | null
  videoSrc: string | null
  controlsVisible: boolean
  playbackRate: number
  pictureMode: 'original' | 'fit' | 'fill' | 'stretch'
  lastAudibleVolume: number
  recentMedia: Array<{ name: string; src: string; openedAt: number }>
  favorites: string[]
  positions: Record<string, number>
  togglePlay: () => void
  setVolume: (v: number) => void
  seek: (t: number) => void
  updateTime: (t: number) => void
  rememberPosition: () => void
  setDuration: (d: number) => void
  toggleFullscreen: () => void
  toggleSubtitle: () => void
  setSubtitlePosition: (v: PlayerState['subtitlePosition']) => void
  setMedia: (name: string, src: string) => void
  setTheater: (v: boolean) => void
  clearMedia: () => void
  setControlsVisible: (v: boolean) => void
  setPlaybackRate: (v: number) => void
  setPictureMode: (v: PlayerState['pictureMode']) => void
  toggleMute: () => void
  toggleFavorite: (src: string) => void
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      isPlaying: false,
      volume: 80,
      currentTime: 0,
      duration: 0,
      isFullscreen: false,
      theater: false,
      subtitleVisible: true,
      subtitlePosition: 'low',
      mediaName: null,
      videoSrc: null,
      controlsVisible: true,
      playbackRate: 1,
      pictureMode: 'fit',
      lastAudibleVolume: 80,
      recentMedia: [],
      favorites: [],
      positions: {},
      togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
      setVolume: (v) => set((s) => ({
        volume: Math.max(0, Math.min(100, v)),
        lastAudibleVolume: v > 0 ? Math.max(0, Math.min(100, v)) : s.lastAudibleVolume
      })),
      seek: (t) => set({ currentTime: t }),
      updateTime: (t) => set({ currentTime: t }),
      rememberPosition: () => set((s) => {
        if (!s.videoSrc || !Number.isFinite(s.currentTime)) return s
        const next = { ...s.positions, [s.videoSrc]: s.currentTime }
        const keys = Object.keys(next)
        if (keys.length > 200) delete next[keys[0]]
        return { positions: next }
      }),
      setDuration: (d) => set({ duration: d }),
      toggleFullscreen: () => set((s) => ({ isFullscreen: !s.isFullscreen })),
      setTheater: (v) => set({ theater: v }),
      toggleSubtitle: () => set((s) => ({ subtitleVisible: !s.subtitleVisible })),
      setSubtitlePosition: (v) => set({ subtitlePosition: ['high', 'middle', 'low'].includes(v) ? v : 'low' }),
      setMedia: (name, src) => set((s) => ({
        mediaName: name,
        videoSrc: src,
        isPlaying: true,
        currentTime: s.positions[src] || 0,
        // A crop/stretch choice from the previous file must never hide content
        // when a differently-shaped video is opened (especially 9:16 media).
        pictureMode: 'fit',
        recentMedia: [
          { name, src, openedAt: Date.now() },
          ...s.recentMedia.filter((item) => item.src !== src)
        ].slice(0, 30)
      })),
      // 关闭右栏播放区：停止当前媒体（播放记录里可随时点回）
      clearMedia: () => set({ mediaName: null, videoSrc: null, isPlaying: false, currentTime: 0 }),
      setControlsVisible: (v) => set({ controlsVisible: v }),
      setPlaybackRate: (v) => set({ playbackRate: Math.max(0.25, Math.min(4, v)) }),
      setPictureMode: (v) => set({ pictureMode: v }),
      toggleMute: () => set((s) => ({
        volume: s.volume > 0 ? 0 : s.lastAudibleVolume || 80,
        lastAudibleVolume: s.volume > 0 ? s.volume : s.lastAudibleVolume
      })),
      toggleFavorite: (src) => set((s) => ({
        favorites: s.favorites.includes(src) ? s.favorites.filter((item) => item !== src) : [src, ...s.favorites]
      }))
    }),
    {
      name: 'ai-player-store',
      partialize: (s) => ({
        volume: s.volume,
        subtitleVisible: s.subtitleVisible,
        subtitlePosition: s.subtitlePosition,
        positions: s.positions,
        playbackRate: s.playbackRate,
        lastAudibleVolume: s.lastAudibleVolume,
        recentMedia: s.recentMedia,
        favorites: s.favorites
      })
    }
  )
)
