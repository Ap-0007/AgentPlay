import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useAgentStore } from '../stores/agentStore'
import { useThemeStore, THEMES } from '../stores/themeStore'

interface Props {
  pinned: boolean
  onTogglePin: () => void
  onOpenLibrary: () => void
  onOpenModelCenter: () => void
  onOpenComputerUse: () => void
}

// 左栏：功能按钮组（上）+ 播放记录（下）+ 主题切换与钉住（底）
export default function Sidebar({ pinned, onTogglePin, onOpenLibrary, onOpenModelCenter, onOpenComputerUse }: Props) {
  const recentMedia = usePlayerStore((state) => state.recentMedia)
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)

  // 一个「打开」：先问文件还是文件夹（Windows 组合对话框看不到文件，必须两段式）
  const handleOpen = () => {
    window.dispatchEvent(new CustomEvent('ai-player-ask-open-mode'))
  }

  // 拉片进对话流：粘贴链接即发全管道；本地视频打开后说「深度解剖」
  const openAnalysisChat = () => {
    const store = useAgentStore.getState()
    store.openPanel()
    if (store.messages.length === 0) {
      store.addMessage('agent', '把 B站/YouTube/抖音等视频链接粘贴发给我，就自动下载并开始拉片；也可以先用「打开」选一个本地视频，然后对我说“深度解剖这个视频”。')
    }
  }

  // 统一行高与图标规格：主入口只用渐变区分层级，不做体积差异
  const actionButton = (icon: string, label: string, onClick: () => void, primary = false) => (
    <button
      key={label}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
        primary ? 'bg-player-accent text-white hover:opacity-90' : 'text-gray-400 hover:bg-white/5 hover:text-gray-100'
      }`}
    >
      <span className="w-5 text-center text-sm leading-none">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 pb-2 pt-4">
        <p className="px-1 pb-2 text-[11px] font-medium tracking-widest text-gray-600">AGENTPLAY</p>
        <div className="space-y-1">
          {actionButton('📂', '打开', () => void handleOpen(), true)}
          {actionButton('🎬', '拉片', openAnalysisChat)}
          {actionButton('📺', '投屏', () => {
            onOpenLibrary()
            window.setTimeout(() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'devices' })), 50)
          })}
          {actionButton('🧩', '模型接入中心', onOpenModelCenter)}
          {actionButton('🖥', '电脑观察', onOpenComputerUse)}
        </div>
      </div>

      <div className="mx-3 border-t border-white/10" />

      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        <p className="px-1 pb-1.5 text-xs text-gray-500">播放记录</p>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {recentMedia.length === 0 && <p className="px-1 text-xs text-gray-600">还没有播放过文件</p>}
          {recentMedia.map((item) => (
            <button
              key={item.src}
              onClick={() => usePlayerStore.getState().setMedia(item.name, item.src)}
              title={item.src}
              className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-white/5"
            >
              <p className="truncate text-xs text-gray-200">{item.name}</p>
              <p className="text-[10px] text-gray-500">
                {new Date(item.openedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="relative flex items-center gap-1 border-t border-white/10 px-3 py-2">
        <button
          onClick={() => setThemeMenuOpen((value) => !value)}
          title="切换界面主题"
          className="flex flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-gray-400 hover:bg-white/5 hover:text-white"
        >
          🎨 {THEMES.find((item) => item.id === theme)?.name || '主题'}
        </button>
        <button
          onClick={onTogglePin}
          title={pinned ? '取消钉住（播放时自动收起本栏）' : '钉住本栏（播放时不收起）'}
          className={`rounded-lg px-2 py-1.5 text-sm ${pinned ? 'text-player-accent' : 'text-gray-500 hover:text-white'}`}
        >
          📌
        </button>
        {themeMenuOpen && (
          <div className="absolute bottom-full left-3 right-3 z-50 mb-1 rounded-xl theme-panel p-1 shadow-2xl">
            {THEMES.map((item) => (
              <button
                key={item.id}
                onClick={() => { setTheme(item.id); setThemeMenuOpen(false) }}
                className={`block w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-white/5 ${
                  item.id === theme ? 'text-player-accent' : 'text-gray-300'
                }`}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
