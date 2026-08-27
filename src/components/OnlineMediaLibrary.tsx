import { useEffect, useRef, useState } from 'react'
import EbookReader from './EbookReader'

interface MusicLicense { id: string; name: string; url: string; publicDomain: boolean; attributionRequired: boolean }
interface UsageScope { commercialUse: boolean; adaptationAllowed: boolean; videoSyncAllowed: boolean; attributionRequired: boolean; shareAlike: boolean; notice: string }
interface Item { identifier: string; title: string; track?: string; year: string; creator: string; performer?: string; recordingSource?: string; downloads: number; source?: 'ia' | 'ws'; license?: MusicLicense; usageScope?: UsageScope }
interface PlayFile { name: string; size: number; url: string; format: string; track?: string; performer?: string; recordingSource?: string; sourcePageUrl?: string; license?: MusicLicense; usageScope?: UsageScope; attributionText?: string }
interface Props { onClose: () => void }

type Kind = 'movie' | 'audio' | 'book'

// 在线媒体库：电影/书保持原有公版馆藏；音乐只展示许可证允许商业视频改编的录音。
// 音乐下载由主进程重新核验元数据，并生成相邻 .license.json 许可凭证。
export default function OnlineMediaLibrary({ onClose }: Props) {
  const [kind, setKind] = useState<Kind>('movie')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<{ identifier: string; title: string; files: PlayFile[] } | null>(null)
  const [downloading, setDownloading] = useState<{ requestId: string; received: number; total: number; name: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [reading, setReading] = useState<{ identifier: string; title: string; fileName: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const off = window.aiPlayer?.onlineMedia?.onProgress((progress) => {
      setDownloading((current) => (current && current.requestId === progress.requestId ? { ...current, received: progress.received, total: progress.total } : current))
    })
    return off
  }, [])

  const search = async () => {
    if (!query.trim() || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    setExpanded(null)
    try {
      const result = await window.aiPlayer?.onlineMedia?.search({ query: query.trim(), kind })
      if (!result) throw new Error('桌面接口不可用')
      if (!result.success) throw new Error(result.error || '检索失败')
      setItems(result.items)
      setTotal(result.total)
      if (result.items.length === 0) setError('没有找到相关内容；换个关键词试试（建议英文片名/作者名）')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openFiles = async (item: Item) => {
    // 维基文库中文书：不展文件列表，直接进阅读器（章节由服务按页序提供）
    if (item.source === 'ws') {
      setReading({ identifier: item.identifier, title: item.title, fileName: '' })
      return
    }
    if (expanded?.identifier === item.identifier) { setExpanded(null); return }
    setBusy(true)
    setError('')
    try {
      const result = kind === 'book'
        ? await window.aiPlayer?.onlineMedia?.bookFiles({ identifier: item.identifier })
        : kind === 'audio'
          ? await window.aiPlayer?.onlineMedia?.licensedMusicFiles({ identifier: item.identifier })
        : await window.aiPlayer?.onlineMedia?.files({ identifier: item.identifier, kind })
      if (!result?.success) throw new Error(result?.error || '读取文件列表失败')
      if (result.files.length === 0) throw new Error('这个条目没有可直接播放的文件')
      setExpanded({ identifier: item.identifier, title: result.title, files: result.files })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const play = (file: PlayFile, title: string) => {
    // mpv 原生流媒体：在线看即边下边播，不落地
    const name = `${title}（在线）`
    window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: file.url }))
    setNotice(`正在在线播放：${name}`)
    onClose()
  }

  const download = async (file: PlayFile, title: string, useInEdit = false) => {
    if (downloading) return null
    const requestId = `omdl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setDownloading({ requestId, received: 0, total: file.size, name: file.name })
    setError('')
    setNotice('')
    try {
      const result = kind === 'audio'
        ? await window.aiPlayer?.onlineMedia?.downloadLicensedMusic({ identifier: expanded?.identifier || '', fileName: file.name, requestId })
        : await window.aiPlayer?.onlineMedia?.download({ url: file.url, requestId })
      if (!result?.success) throw new Error(result?.error || '下载失败')
      if (kind === 'audio') {
        setNotice(`已下载到「音乐/AgentPlay 授权音乐」，许可凭证与音乐放在一起：${file.track || title}`)
        if (useInEdit && result.outputPath) {
          const receiptPath = 'receiptPath' in result ? result.receiptPath : undefined
          window.dispatchEvent(new CustomEvent('ai-player-licensed-music-ready', { detail: { path: result.outputPath, receiptPath, track: file.track || title } }))
          onClose()
        }
      } else setNotice(`已下载到「视频/AgentPlay 下载」：${title}`)
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setDownloading(null)
    }
  }

  const cancelDownload = async () => {
    if (downloading) await window.aiPlayer?.onlineMedia?.cancel(downloading.requestId)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/10 theme-panel shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-white/10 px-6 py-5">
          <div>
            <h2 className="text-lg font-medium">在线媒体库</h2>
            <p className="mt-1 text-xs text-gray-500">公版电影与书籍；可商用配乐只放行 Public Domain、CC0、CC BY 3.0/4.0，并保留许可凭证</p>
          </div>
          <button onClick={onClose} className="text-lg text-gray-500 hover:text-white">×</button>
        </div>

        <div className="space-y-3 overflow-y-auto px-6 py-4">
          <div className="flex gap-2">
            <div className="flex rounded-lg bg-black/30 p-0.5 text-xs">
              {([['movie', '电影'], ['audio', '可商用配乐'], ['book', '电子书']] as Array<[Kind, string]>).map(([value, label]) => (
                <button key={value} onClick={() => { setKind(value); setItems([]); setExpanded(null) }} className={`rounded-md px-3 py-1.5 ${kind === value ? 'bg-player-accent text-white' : 'text-gray-400 hover:text-gray-200'}`}>{label}</button>
              ))}
            </div>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void search()}
              placeholder={kind === 'movie' ? '搜公版电影（英文片名更准）…' : kind === 'book' ? '搜公版电子书（英文书名/作者更准）…' : '搜可商用配乐（如 calm piano）…'}
              className="flex-1 rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-sm outline-none focus:border-player-accent"
            />
            <button disabled={busy || !query.trim()} onClick={() => void search()} className="rounded-lg bg-player-accent px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-40">搜索</button>
          </div>

          {error && <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
          {notice && <div className="rounded-lg bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</div>}
          {downloading && (
            <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-xs text-gray-400">
                <span className="truncate">下载中：{downloading.name}</span>
                <button onClick={() => void cancelDownload()} className="shrink-0 text-red-300 hover:text-red-200">取消</button>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/40">
                <div className="h-full bg-sky-500 transition-all" style={{ width: `${downloading.total ? Math.min(100, Math.round((downloading.received / downloading.total) * 100)) : 0}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-500">{(downloading.received / 1024 / 1024).toFixed(1)}/{(downloading.total / 1024 / 1024).toFixed(1)}MB</div>
            </div>
          )}

          {busy && items.length === 0 && <p className="py-8 text-center text-sm text-gray-500">正在检索…</p>}
          {!busy && items.length > 0 && <p className="text-xs text-gray-500">共 {total} 条，显示前 {items.length} 条；点条目展开可播放文件</p>}

          <div className="space-y-1.5">
            {items.map((item) => (
              <div key={item.identifier} className="rounded-xl border border-white/10 bg-black/20">
                <button onClick={() => void openFiles(item)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-white/5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-gray-100">{item.title}</p>
                    <p className="mt-0.5 truncate text-xs text-gray-500">
                      {item.source === 'ws' && <span className="mr-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">维基文库</span>}
                      {kind === 'audio' && item.license && <span className="mr-1.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">{item.license.name}</span>}
                      {[item.year, item.creator].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs text-gray-500">{item.source === 'ws' ? '📖' : expanded?.identifier === item.identifier ? '▾' : '▸'}</span>
                </button>
                {expanded?.identifier === item.identifier && (
                  <div className="space-y-1 border-t border-white/10 px-4 py-3">
                    {kind === 'audio' && expanded.files[0]?.license && (
                      <div className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-[11px] leading-5 text-gray-400">
                        <p><span className="text-gray-200">使用范围：</span>{expanded.files[0].usageScope?.notice}</p>
                        <p><span className="text-gray-200">录音来源：</span>{expanded.files[0].recordingSource || '见来源页'}</p>
                        <p><span className="text-gray-200">许可凭证：</span>下载时生成同名 .license.json；发布前可从来源页复核</p>
                      </div>
                    )}
                    {expanded.files.slice(0, 6).map((file) => (
                      <div key={file.name} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate text-gray-300" title={file.attributionText || file.name}>{file.track || file.name}{file.performer ? ` · ${file.performer}` : ''}</span>
                        <span className="shrink-0 text-gray-500">{(file.size / 1024 / 1024).toFixed(0)}MB</span>
                        {kind === 'book' ? (
                          <button onClick={() => setReading({ identifier: expanded.identifier, title: expanded.title, fileName: file.name })} className="shrink-0 rounded bg-player-accent/80 px-2.5 py-1 text-white hover:bg-player-accent">📖 阅读{file.name.endsWith('.epub') ? '（章节版）' : ''}</button>
                        ) : (
                          <>
                            <button onClick={() => play(file, expanded.title)} className="shrink-0 rounded bg-player-accent/80 px-2.5 py-1 text-white hover:bg-player-accent">▶ {kind === 'audio' ? '试听' : '在线看'}</button>
                            {kind === 'movie' && <button
                              onClick={() => {
                                // 与对话窗同一个拉片链路：下载 + 深度解剖（授权/进度/报告全在对话流里）
                                window.dispatchEvent(new CustomEvent('ai-player-link-analysis', { detail: { url: file.url } }))
                                onClose()
                              }}
                              title="下载后对这部影片做深度解剖（报告在对话窗产出）"
                              className="shrink-0 rounded bg-emerald-600/80 px-2.5 py-1 text-white hover:bg-emerald-600"
                            >🎬 拉片</button>}
                          </>
                        )}
                        <button disabled={!!downloading} onClick={() => void download(file, expanded.title)} className="shrink-0 rounded bg-white/10 px-2.5 py-1 hover:bg-white/15 disabled:opacity-40">⬇ 下载</button>
                        {kind === 'audio' && <button disabled={!!downloading} onClick={() => void download(file, expanded.title, true)} className="shrink-0 rounded bg-emerald-600/80 px-2.5 py-1 text-white hover:bg-emerald-600 disabled:opacity-40">用于剪辑</button>}
                      </div>
                    ))}
                    {expanded.files.length > 6 && <p className="text-[11px] text-gray-600">还有 {expanded.files.length - 6} 个版本，已按可播性排序只显示前 6 个</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      {reading && <EbookReader book={reading} onClose={() => setReading(null)} />}
    </div>
  )
}
