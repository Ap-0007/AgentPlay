import { useEffect, useRef, useState } from 'react'

interface Props {
  book: { identifier: string; title: string; fileName: string }
  onClose: () => void
}

// 电子书阅读器：公版书（Gutenberg 馆藏）在线阅读 + 章节翻译（离线组件免费 / 云模型更准），译文缓存零重复消耗
export default function EbookReader({ book, onClose }: Props) {
  const [chapters, setChapters] = useState<string[]>([])
  const [current, setCurrent] = useState(0)
  const [text, setText] = useState('')
  const [translated, setTranslated] = useState('')
  const [target, setTarget] = useState<'zh' | 'vernacular' | 'en'>('zh')
  const [showTranslation, setShowTranslation] = useState(true)
  const [loading, setLoading] = useState('')
  const [error, setError] = useState('')
  const [fontSize, setFontSize] = useState(15)
  const [fullscreen, setFullscreen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void rootRef.current?.requestFullscreen?.()
      setFullscreen(true)
    } else {
      void document.exitFullscreen()
      setFullscreen(false)
    }
  }

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading('正在下载并解析全书…')
      setError('')
      try {
        const result = await window.aiPlayer?.ebook?.open({ identifier: book.identifier, fileName: book.fileName })
        if (!result?.success) throw new Error(result?.error || '打开失败')
        setChapters(result.chapters)
        setLoading('')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setLoading('')
      }
    })()
    const off = window.aiPlayer?.ebook?.onTranslateStatus((event) => {
      if (event.index === current) setLoading(event.status)
    })
    return off
  }, [])

  const loadChapter = async (index: number) => {
    setCurrent(index)
    setTranslated('')
    setError('')
    setLoading('正在读取本节…')
    try {
      const result = await window.aiPlayer?.ebook?.chapter({ identifier: book.identifier, fileName: book.fileName, index })
      if (!result?.success) throw new Error(result?.error || '读取失败')
      setText(result.text)
      setLoading('')
      bodyRef.current?.scrollTo({ top: 0 })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading('')
    }
  }

  useEffect(() => {
    if (chapters.length > 0 && !text) void loadChapter(0)
  }, [chapters])

  // 书页式排版：中文段落首行缩进 2em，英文段落不缩进走段距
  const renderBookText = (content: string, colorClass: string) => {
    const cjk = (content.match(/[\u4e00-\u9fff]/g) || []).length
    const isCjk = cjk > content.length * 0.15
    const paras = content.split(/\n+/).map((para) => para.trim()).filter(Boolean)
    return (
      <div className={`ebook-flow ${isCjk ? '' : 'ebook-flow-en'} ${colorClass}`} style={{ fontSize }}>
        {paras.map((para, index) => <p key={index}>{para}</p>)}
      </div>
    )
  }

  const translate = async (engine: 'offline' | 'cloud') => {
    setError('')
    setLoading(engine === 'offline' ? '正在离线翻译本章（免费本地组件）…' : '正在云端翻译本章…')
    try {
      const result = await window.aiPlayer?.ebook?.translate({ identifier: book.identifier, fileName: book.fileName, index: current, engine, target })
      if (!result?.success) throw new Error(result?.error || '翻译失败')
      setTranslated(result.text)
      setShowTranslation(true)
      setLoading('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading('')
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-4" onClick={onClose}>
      <div ref={rootRef} className="flex h-[86vh] w-full max-w-4xl overflow-hidden rounded-2xl border border-white/10 theme-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        {/* 章节栏 */}
        <div className="flex w-52 shrink-0 flex-col border-r border-white/10">
          <div className="border-b border-white/10 px-4 py-3">
            <p className="truncate text-sm text-gray-100" title={book.title}>{book.title}</p>
            <p className="mt-0.5 text-xs text-gray-500">{chapters.length ? `共 ${chapters.length} 节` : '解析中…'}</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {chapters.map((title, index) => (
              <button
                key={index}
                onClick={() => void loadChapter(index)}
                className={`block w-full truncate rounded-lg px-2.5 py-2 text-left text-xs ${index === current ? 'bg-player-accent/20 text-player-accent' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}
                title={title}
              >
                {index + 1}. {title}
              </button>
            ))}
          </div>
        </div>

        {/* 阅读区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
            <div className="flex rounded-lg bg-black/25 p-0.5 text-[11px]" title="翻译目标">
              {([['zh', '中文'], ['vernacular', '白话文'], ['en', 'English']] as const).map(([value, label]) => (
                <button key={value} onClick={() => setTarget(value)} className={`rounded-md px-2.5 py-1 ${target === value ? 'bg-player-accent text-white' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>
              ))}
            </div>
            <button onClick={() => void translate('offline')} disabled={target !== 'zh'} title={target !== 'zh' ? '离线组件只支持英译中' : '离线翻译组件（免费、不出机）'} className="rounded-lg bg-emerald-600/80 px-3 py-1.5 text-xs text-white hover:bg-emerald-600 disabled:opacity-40">离线免费</button>
            <button onClick={() => void translate('cloud')} title="云端大模型（更准，发原文到云，逐次授权）" className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15">云模型精译</button>
            {translated && (
              <button onClick={() => setShowTranslation((value) => !value)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15">
                {showTranslation ? '只看原文' : '原文+译文'}
              </button>
            )}
            <div className="ml-auto flex items-center gap-1 text-xs text-gray-400">
              <button onClick={toggleFullscreen} title={fullscreen ? '退出全屏' : '全屏阅读'} className="rounded px-2 py-1 hover:bg-white/10">{fullscreen ? '🗗' : '🗖'}</button>
              <button onClick={() => setFontSize((size) => Math.max(12, size - 1))} className="rounded px-2 py-1 hover:bg-white/10">A-</button>
              <button onClick={() => setFontSize((size) => Math.min(22, size + 1))} className="rounded px-2 py-1 hover:bg-white/10">A+</button>
              <button onClick={onClose} className="ml-2 px-2 py-1 text-base text-gray-500 hover:text-white">×</button>
            </div>
          </div>
          {error && <div className="mx-4 mt-3 rounded-lg bg-red-500/10 px-4 py-2.5 text-xs text-red-300">{error}</div>}
          {loading && <p className="px-4 pt-3 text-xs text-sky-300">{loading}</p>}
          <div className="relative min-h-0 flex-1">
          {/* 左右点击翻页热区：左 22% 上一节、右 22% 下一节（按钮/链接不吞） */}
          <button
            aria-label="上一节"
            onClick={() => { if (current > 0) void loadChapter(current - 1) }}
            className="absolute left-0 top-0 z-10 h-full w-[22%] cursor-pointer bg-transparent opacity-0 transition-opacity hover:opacity-100 disabled:opacity-0"
            disabled={current === 0}
          ><span className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2 py-1 text-xs text-white">‹</span></button>
          <button
            aria-label="下一节"
            onClick={() => { if (current < chapters.length - 1) void loadChapter(current + 1) }}
            className="absolute right-0 top-0 z-10 h-full w-[22%] cursor-pointer bg-transparent opacity-0 transition-opacity hover:opacity-100 disabled:opacity-0"
            disabled={current >= chapters.length - 1}
          ><span className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/30 px-2 py-1 text-xs text-white">›</span></button>
          <div ref={bodyRef} className="ebook-surface h-full overflow-y-auto px-6 py-6">
            <div className={showTranslation && translated ? 'grid gap-8 md:grid-cols-2' : ''}>
              <div>
                {text && <p className="ebook-chapter-title text-gray-500" style={{ fontSize: fontSize - 1 }}>{chapters[current]}</p>}
                {renderBookText(text || ' ', 'text-gray-200')}
              </div>
              {showTranslation && translated && (
                <div className="border-l border-white/10 pl-8">
                  {renderBookText(translated, 'text-emerald-100/90')}
                </div>
              )}
            </div>
          </div>
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-4 py-2">
            <button disabled={current === 0} onClick={() => void loadChapter(current - 1)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:opacity-30">← 上一节</button>
            <span className="text-xs text-gray-500">{chapters.length ? `${current + 1} / ${chapters.length}` : ''}</span>
            <button disabled={current >= chapters.length - 1} onClick={() => void loadChapter(current + 1)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:opacity-30">下一节 →</button>
          </div>
        </div>
      </div>
    </div>
  )
}
