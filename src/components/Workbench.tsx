import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { usePlayerStore } from '../stores/playerStore'

// Codex 式三栏工作台：左栏(功能+播放记录) / 中栏(AI 对话主角) / 右栏(播放内容区)
// - 左右栏宽可拖拽，持久化到 localStorage
// - 右栏有媒体时自动展开；左栏未钉住则自动收起，留一条展开把手
interface Props {
  rightOpen: boolean
  sidebar: (props: { pinned: boolean; onTogglePin: () => void }) => ReactNode
  center: ReactNode
  right: ReactNode
}

const LEFT_MIN = 180
const LEFT_MAX = 360
const RIGHT_MIN = 320

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export default function Workbench({ rightOpen, sidebar, center, right }: Props) {
  // 影院模式：播放区占满整个窗口，左栏/中栏全部收起
  const theater = usePlayerStore((s) => s.theater)
  const [leftWidth, setLeftWidth] = useState(() => clamp(Number(localStorage.getItem('aiplayer_left_w')) || 240, LEFT_MIN, LEFT_MAX))
  const [rightWidth, setRightWidth] = useState(() => clamp(Number(localStorage.getItem('aiplayer_right_w')) || 480, RIGHT_MIN, Math.round(window.innerWidth * 0.6)))
  const [pinned, setPinned] = useState(() => localStorage.getItem('aiplayer_left_pinned') === '1')

  const leftVisible = !theater && (pinned || !rightOpen)

  const togglePin = useCallback(() => {
    setPinned((value) => {
      localStorage.setItem('aiplayer_left_pinned', value ? '0' : '1')
      return !value
    })
  }, [])

  useEffect(() => {
    localStorage.setItem('aiplayer_left_w', String(leftWidth))
  }, [leftWidth])
  useEffect(() => {
    localStorage.setItem('aiplayer_right_w', String(rightWidth))
  }, [rightWidth])

  const startDrag = useCallback((which: 'left' | 'right') => (event: React.PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = which === 'left' ? leftWidth : rightWidth
    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX
      if (which === 'left') {
        setLeftWidth(clamp(startWidth + dx, LEFT_MIN, LEFT_MAX))
      } else {
        setRightWidth(clamp(startWidth - dx, RIGHT_MIN, Math.round(window.innerWidth * 0.6)))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [leftWidth, rightWidth])

  const divider = (which: 'left' | 'right') => (
    <div
      onPointerDown={startDrag(which)}
      className="w-1.5 shrink-0 cursor-col-resize bg-white/5 hover:bg-player-accent/50 active:bg-player-accent transition-colors"
      title="拖动调整栏宽"
    />
  )

  return (
    <div className="w-screen h-screen flex bg-player-bg overflow-hidden select-none">
      {leftVisible ? (
        <>
          <aside style={{ width: leftWidth }} className="shrink-0 min-h-0 flex flex-col theme-panel border-y-0 border-l-0">
            {sidebar({ pinned, onTogglePin: togglePin })}
          </aside>
          {divider('left')}
        </>
      ) : (
        <button
          onClick={togglePin}
          title="展开功能栏"
          className="w-6 shrink-0 theme-panel border-y-0 border-l-0 flex flex-col items-center justify-center gap-2 text-gray-500 hover:text-player-accent"
        >
          <span className="text-xs">☰</span>
          <span className="text-[10px]" style={{ writingMode: 'vertical-rl' }}>功能栏</span>
        </button>
      )}
      {!theater && <main className="flex-1 min-w-0 min-h-0 flex flex-col">{center}</main>}
      {rightOpen && (
        <>
          {!theater && divider('right')}
          <aside style={theater ? undefined : { width: rightWidth }} className={theater ? 'flex-1 min-w-0 min-h-0 flex flex-col bg-black' : 'shrink-0 min-h-0 flex flex-col bg-black'}>
            {right}
          </aside>
        </>
      )}
    </div>
  )
}
