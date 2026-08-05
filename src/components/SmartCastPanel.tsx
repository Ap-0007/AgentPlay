import { useEffect, useRef, useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

interface Device {
  id: string
  name: string
  kind: 'tv' | 'agentplay'
  host?: string
  port?: number
  lastSuccess?: boolean
}
interface Props { onClose: () => void }

// 智能投屏：打开即扫全类型设备（电视/盒子 + AgentPlay 镜像设备），点一下即投。
// 协议与模式全自动选择：电视=投当前视频文件，AgentPlay 设备=屏幕镜像；防火墙/进度/控制全部收口在这一层。
export default function SmartCastPanel({ onClose }: Props) {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [scanning, setScanning] = useState(true)
  const [active, setActive] = useState<{ device: Device; message: string; stateLabel?: string } | null>(null)
  const [pinFor, setPinFor] = useState<Device | null>(null)
  const [pin, setPin] = useState('')
  const [notice, setNotice] = useState('')
  const videoSrc = usePlayerStore((s) => s.videoSrc)
  const mediaName = usePlayerStore((s) => s.mediaName)
  const scanningRef = useRef(false)

  const scan = async () => {
    if (scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    try {
      const list = await window.aiPlayer?.cast?.smartScan?.()
      setDevices(list || [])
    } finally {
      scanningRef.current = false
      setScanning(false)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const fw = await window.aiPlayer?.cast?.ensureFirewall?.()
        if (fw?.needed) setNotice('首次投屏需在弹出的授权框点"是"（放行局域网端口，只此一次）')
      } catch { /* 忽略 */ }
      void scan()
    })()
    // eslint-disable-next-line
  }, [])

  const refreshState = async (device: Device) => {
    if (device.kind !== 'tv') return
    const status = await window.aiPlayer?.cast?.status(device.id)
    if (status?.success) setActive((cur) => (cur && cur.device.id === device.id ? { ...cur, stateLabel: status.label } : cur))
  }

  const castTo = async (device: Device) => {
    setNotice('')
    if (device.kind === 'agentplay') {
      setPinFor(device)
      setPin('')
      return
    }
    // 电视：投当前在播文件；没有在播就引导先选文件
    let target = videoSrc
    if (!target || /^https?:/i.test(target)) {
      setNotice('正在投的内容是网络流或还没打开视频——先选一个本地文件')
      const result = await window.aiPlayer?.chat?.openAny?.()
      const picked = result?.media?.[0]
      if (!picked) { setNotice('没有选文件，取消投屏'); return }
      target = picked
    }
    setActive({ device, message: `正在投屏到 ${device.name}…` })
    const result = await window.aiPlayer?.cast?.cast(device.id, target)
    if (result?.success) {
      setActive({ device, message: `已投屏到 ${device.name}` })
      window.setTimeout(() => void refreshState(device), 3000)
    } else {
      setActive(null)
      setNotice(result?.error || result?.action || '投屏失败')
    }
  }

  const mirrorTo = async () => {
    if (!pinFor) return
    if (!/^\d{6}$/.test(pin)) { setNotice('输入接收端显示的 6 位 PIN'); return }
    setActive({ device: pinFor, message: `正在连接 ${pinFor.name}…` })
    const result = await window.aiPlayer?.mirror?.startSender({ host: pinFor.host || '', port: pinFor.port || 0, pin })
    if (result?.success) {
      setActive({ device: pinFor, message: `屏幕已镜像到 ${pinFor.name}` })
    } else {
      setActive(null)
      setNotice(result?.error || '镜像连接失败')
    }
    setPinFor(null)
  }

  const stopActive = async () => {
    if (!active) return
    if (active.device.kind === 'tv') await window.aiPlayer?.cast?.stop(active.device.id)
    else await window.aiPlayer?.mirror?.stopSender()
    setActive(null)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-white/10 theme-panel p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium">投屏</h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {videoSrc ? `当前内容：${mediaName || '已打开的文件'}` : '电视投「正在播放/选中的视频」；AgentPlay 设备投整个屏幕'}
            </p>
          </div>
          <button onClick={onClose} className="text-lg text-gray-500 hover:text-white">×</button>
        </div>

        {notice && <div className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{notice}</div>}

        {active ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p className="text-sm text-emerald-100">{active.message}{active.stateLabel ? `（${active.stateLabel}）` : ''}</p>
              <p className="mt-1 text-xs text-gray-500">{active.device.kind === 'tv' ? '📺 电视/盒子' : '🖥️ AgentPlay 屏幕镜像'}</p>
            </div>
            <div className="flex gap-2">
              {active.device.kind === 'tv' && (
                <>
                  <button onClick={async () => { await window.aiPlayer?.cast?.pause(active.device.id); void refreshState(active.device) }} className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15">暂停</button>
                  <button onClick={async () => { await window.aiPlayer?.cast?.resume(active.device.id); void refreshState(active.device) }} className="flex-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15">继续</button>
                </>
              )}
              <button onClick={() => void stopActive()} className="flex-1 rounded-lg bg-red-500/80 px-3 py-2 text-xs text-white hover:bg-red-500">结束投屏</button>
            </div>
          </div>
        ) : pinFor ? (
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <p className="text-sm text-gray-200">镜像到 {pinFor.name}</p>
            <p className="mt-1 text-xs text-gray-500">在对端 AgentPlay 窗口看 6 位 PIN</p>
            <div className="mt-3 flex gap-2">
              <input
                value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位 PIN"
                inputMode="numeric"
                className="flex-1 rounded-lg border border-white/10 bg-black/35 px-3 py-2 text-center text-lg tracking-widest outline-none focus:border-player-accent"
                onKeyDown={(event) => event.key === 'Enter' && void mirrorTo()}
                autoFocus
              />
              <button onClick={() => void mirrorTo()} className="rounded-lg bg-player-accent px-4 py-2 text-sm text-white">连接</button>
            </div>
            <button onClick={() => setPinFor(null)} className="mt-2 w-full text-center text-[11px] text-gray-500 hover:text-gray-300">返回设备列表</button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs text-gray-500">{scanning ? '正在搜索同一局域网内的设备…' : devices?.length ? `找到 ${devices.length} 台设备` : '没找到设备'}</p>
              <button onClick={() => void scan()} disabled={scanning} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:opacity-40">{scanning ? '搜索中…' : '重新搜索'}</button>
            </div>
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {scanning && <p className="py-6 text-center text-xs text-gray-500">搜索中（电视和 AgentPlay 设备一起找）…</p>}
              {!scanning && devices?.length === 0 && (
                <p className="py-4 text-xs leading-6 text-gray-500">没发现设备：确认电视/对端电脑与本机在同一 WiFi；电视需打开投屏/多屏互动，对端电脑在 AgentPlay 里开启"屏幕镜像接收"。</p>
              )}
              {devices?.map((device) => (
                <button key={device.id} onClick={() => void castTo(device)} className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-left hover:border-player-accent/50 hover:bg-white/5">
                  <span className="text-lg">{device.kind === 'tv' ? '📺' : '🖥️'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-100">{device.name}</span>
                    <span className="text-[11px] text-gray-500">{device.kind === 'tv' ? '电视 · 投视频文件' : 'AgentPlay · 镜像整个屏幕'}</span>
                  </span>
                  {device.lastSuccess && <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">上次成功</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
