import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../stores/agentStore'
import { usePlayerStore } from '../stores/playerStore'

const EXAMPLE_TASKS = [
  { label: '整理成 Word', format: 'docx', text: '把所选资料整理成结构清晰的中文 Word 文档，保留事实和关键数据，增加标题和要点。' },
  { label: '清理表格', format: 'xlsx', text: '清理所有文本首尾空格，并按手机号列去重，另存为新的 Excel 文件。' },
  { label: '生成 PPT', format: 'pptx', text: '根据所选资料制作一套 12 页以内的中文演示稿，每页只保留关键结论，并添加演讲备注。' },
  { label: '合并 PDF', format: 'pdf', text: '按照所选顺序合并这些 PDF，另存为一个新文件。' }
]

function kindLabel(kind: string) {
  const labels: Record<string, string> = {
    'pdf-merge': '本地合并 PDF',
    'pdf-split': '本地拆分 PDF',
    'spreadsheet-edit': '表格清理与公式处理',
    convert: '本地格式转换',
    'ai-generate': 'AI 内容生成与整理',
    'docx-edit': '本地无损编辑 DOCX',
    'pptx-edit': '本地页面级编辑 PPTX',
    'office-convert': '本机 Office 高保真转换',
    'ai-bundle': 'AI 成套生成',
    'image-convert': '本地图片转换',
    'image-ask': '图片理解（云端视觉或本机 OCR）'
  }
  return labels[kind] || kind
}



export default function AgentPanel() {
  const { messages, inputText, setInputText, send, cancel, thinking, listening, toggleListening, setListening, addMessage } =
    useAgentStore()
  const focusNonce = useAgentStore((s) => s.focusNonce)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [focusNonce])
  const [attachments, setAttachments] = useState<Array<{ token: string; name: string; ext: string; size: number }>>([])
  const [docCaps, setDocCaps] = useState<{ modelConfigured: boolean; modelLocal: boolean; providerName: string; model: string } | null>(null)
  const task = useAgentStore((s) => s.task)
  const setTask = useAgentStore((s) => s.setTask)
  const docBusy = task.running
  const docStatus = task.status
  const docOutputs = task.outputs
  const setDocBusy = (value: boolean) => setTask({ running: value })
  const setDocStatus = (value: string) => setTask({ status: value })
  const setDocOutputs = (value: string[]) => setTask({ outputs: value })
  const [needsApproval, setNeedsApproval] = useState(false)
  const [cloudApproved, setCloudApproved] = useState(false)
  const [outputFormat, setOutputFormat] = useState('auto')
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  const docRequestIdRef = useRef('')
  const docBusyRef = useRef(false)
  const runDocTaskRef = useRef<(forceApprove?: boolean) => Promise<void>>(async () => {})
  const runAnalysisTaskRef = useRef<(forceApprove?: boolean) => Promise<void>>(async () => {})
  const runDownloadTaskRef = useRef<(url: string, instruction: string, direct?: boolean) => Promise<void>>(async () => {})
  const routeTextSendRef = useRef<() => Promise<void>>(async () => {})
  const pendingTaskRef = useRef<'doc' | 'analysis' | 'download' | 'link-analysis'>('doc')
  const docInstructionRef = useRef('')
  const analysisInstructionRef = useRef('')
  const analysisFormatRef = useRef('docx')
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem('aiplayer_tmdb_key') || '')
  const [subtitleKey, setSubtitleKey] = useState(() => localStorage.getItem('aiplayer_subtitle_key') || '')
  const [showServiceEdit, setShowServiceEdit] = useState(false)
  const [modelLabel, setModelLabel] = useState('尚未配置模型')
  const [modelMode, setModelMode] = useState<'cloud' | 'bundled'>('cloud')
  const [modeSwitching, setModeSwitching] = useState(false)
  const applyConfigLabel = (config: { providerId: string; providerName?: string; model: string; hasApiKey: boolean }) => {
    setModelMode(config.providerId === 'bundled-lite' ? 'bundled' : 'cloud')
    setModelLabel(`${config.providerName || config.providerId} / ${config.model}${config.hasApiKey ? ' · Key 已加密保存' : ''}`)
  }
  const switchModelMode = async (target: 'cloud' | 'bundled') => {
    if (target === modelMode || modeSwitching) return
    setModeSwitching(true)
    try {
      const result = await window.aiPlayer?.models?.quickSwitch({ role: 'chat', target })
      if (!result) return
      if (result.needDownload) {
        addMessage('agent', '本地 AI 组件还没下载：到「模型接入中心」点「下载本地 AI 组件」（约 429MB，只下一次），装好就能一键切本地。')
        window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))
        return
      }
      if (!result.switched) {
        addMessage('agent', `${result.reason || '切换失败'}：请先到「模型接入中心」保存一个云端模型。`)
        return
      }
      if (result.config) applyConfigLabel(result.config)
      addMessage('agent', target === 'bundled' ? '已切到本地模型：离线运行、内容不出机，速度取决于 CPU。' : '已切回云端模型。')
    } finally {
      setModeSwitching(false)
    }
  }
  const saveOtherServices = () => {
    localStorage.setItem('aiplayer_tmdb_key', tmdbKey)
    localStorage.setItem('aiplayer_subtitle_key', subtitleKey)
    setShowServiceEdit(false)
  }

  useEffect(() => {
    window.aiPlayer?.models?.config('chat').then((config) => {
      if (config) applyConfigLabel(config)
    })
  }, [])

  useEffect(() => {
    const off = window.aiPlayer?.documents?.onStatus((event) => {
      if (event.requestId === docRequestIdRef.current) setDocStatus(event.status)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.aiPlayer?.analysis?.onStatus((event) => {
      if (event.requestId === docRequestIdRef.current) setDocStatus(event.status)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.aiPlayer?.mediaDownload?.onStatus((event) => {
      if (event.requestId === docRequestIdRef.current) setDocStatus(event.status)
    })
    return off
  }, [])

  useEffect(() => {
    // 冷启动竞态修复：Explorer 动词带来的附件先落在 store，面板一挂载就消费
    const pending = useAgentStore.getState().pendingDocs
    if (pending?.length) {
      setAttachments((current) => [...current, ...pending])
      useAgentStore.getState().setPendingDocs(null)
      void window.aiPlayer?.documents?.capabilities().then((caps) => { if (caps) setDocCaps((current) => current || caps) })
    }
    const handler = (event: Event) => {
      const docs = (event as CustomEvent<Array<{ token: string; name: string; ext: string; size: number }>>).detail
      if (!Array.isArray(docs) || docs.length === 0) return
      useAgentStore.getState().openPanel()
      setAttachments((current) => [...current, ...docs])
      void window.aiPlayer?.documents?.capabilities().then((caps) => { if (caps) setDocCaps((current) => current || caps) })
    }
    window.addEventListener('ai-player-attach-docs', handler)
    return () => window.removeEventListener('ai-player-attach-docs', handler)
  }, [])

  // 拖文件进对话窗 = 与系统选择框同级的显式授权
  const handleDropFiles = async (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((value): value is string => Boolean(value))
    if (!paths.length) return
    const result = await window.aiPlayer?.documents?.attachPaths?.(paths)
    if (!result) return
    if (!Array.isArray(result)) {
      addMessage('agent', `[错误] ${result.error}`)
      return
    }
    if (result.length) setAttachments((current) => [...current, ...result])
  }

  const [history, setHistory] = useState<Array<{ id: string; createdAt: string; instruction: string; kind: string; outputs: string[]; summary: string }>>([])
  useEffect(() => {
    if (messages.length === 0 && attachments.length === 0) {
      void window.aiPlayer?.documents?.history?.().then((items) => { if (items) setHistory(items) })
    }
  }, [messages.length, attachments.length])

  // 按附件类型给出推荐动作：点一下 = 自动填指令并直接执行，不用组织语言
  const suggestedActions = (() => {
    if (!attachments.length) return [] as Array<{ label: string; text: string }>
    const exts = new Set(attachments.map((file) => file.ext))
    const has = (...list: string[]) => list.some((ext) => exts.has(ext))
    const actions: Array<{ label: string; text: string }> = []
    if (has('.docx', '.doc', '.txt', '.md', '.rtf', '.odt')) {
      actions.push(
        { label: '整理成 Word', text: '把所选资料整理成结构清晰的中文 Word 文档，保留事实和关键数据，增加标题和要点。' },
        { label: '转成 PDF', text: '把所选文件高保真转成 PDF，保留原版式。' },
        { label: '做成 PPT', text: '根据所选资料制作一套 12 页以内的中文演示稿，每页只保留关键结论。' },
        { label: '提取文字', text: '提取所选文件的全部文字，另存为 TXT 文件。' }
      )
    }
    if (has('.xlsx', '.csv', '.ods')) {
      actions.push(
        { label: '清理表格', text: '清理所有文本首尾空格，并去除重复行。' },
        { label: '表格转 PDF', text: '把所选表格转成 PDF。' }
      )
    }
    if (has('.pdf')) {
      actions.push(
        { label: '提取文字', text: '提取 PDF 全部文字，另存为 TXT 文件。' },
        { label: '合并 PDF', text: '按照所选顺序合并这些 PDF，另存为一个新文件。' },
        { label: '拆分 PDF', text: '把 PDF 按页拆分成单页文件。' }
      )
    }
    if (has('.pptx', '.odp')) actions.push({ label: '演示稿转 PDF', text: '把演示稿转成 PDF。' })
    return actions.slice(0, 6)
  })()

  const runSuggested = (text: string) => {
    setInputText(text)
    window.setTimeout(() => void runDocTaskRef.current(), 0)
  }

  const openAny = async () => {
    const result = await window.aiPlayer?.chat?.openAny?.()
    if (!result) return
    if (result.media?.length) {
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.media[0] }))
    }
    if (result.documents?.length) {
      setAttachments((current) => [...current, ...result.documents])
      if (!docCaps) {
        const caps = await window.aiPlayer?.documents?.capabilities()
        if (caps) setDocCaps(caps)
      }
    }
  }

  const runDocTask = async (forceApprove = false) => {
    const api = window.aiPlayer?.documents
    const instruction = forceApprove ? docInstructionRef.current : inputText.trim()
    if (!api || !instruction || docBusyRef.current) return
    docBusyRef.current = true
    docInstructionRef.current = instruction
    const files = attachments
    if (!forceApprove) {
      addMessage('user', `${instruction}\n（附件：${files.map((file) => file.name).join('、')}）`)
      setInputText('')
    }
    pendingTaskRef.current = 'doc'
    setTask({ kind: 'doc', label: '文档任务', error: '' })
    setDocBusy(true)
    setDocStatus('正在分析任务')
    setDocOutputs([])
    try {
      const caps = docCaps || (await api.capabilities()) || null
      if (caps && !docCaps) setDocCaps(caps)
      const tokens = files.map((file) => file.token)
      const preview = await api.plan({ tokens, instruction, outputFormat })
      addMessage('agent', `方案：${kindLabel(preview.kind)} → ${preview.outputFormat.toUpperCase()}${preview.requiresAi ? '（需要模型）' : '（本地执行）'}`)
      if (preview.requiresAi && caps && !caps.modelConfigured) {
        throw new Error('这个任务需要模型理解或生成内容，请先在模型接入中心配置模型。')
      }
      if (preview.requiresAi && caps && !caps.modelLocal && !(cloudApproved || forceApprove)) {
        pendingTaskRef.current = 'doc'
        setNeedsApproval(true)
        return
      }
      const requestId = `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      docRequestIdRef.current = requestId
      const result = await api.run({ tokens, instruction, outputFormat, cloudApproved: cloudApproved || forceApprove, requestId })
      if (!result.success) throw new Error(result.error || '文档处理失败')
      addMessage('agent', result.summary || '处理完成')
      setDocOutputs(result.outputs || [])
      setAttachments([])
      setNeedsApproval(false)
      setCloudApproved(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTask({ error: message })
      addMessage('agent', `[错误] ${message}`)
    } finally {
      docBusyRef.current = false
      setDocBusy(false)
      setDocStatus('')
    }
  }
  runDocTaskRef.current = runDocTask

  const runAnalysisTask = async (forceApprove = false) => {
    const api = window.aiPlayer?.analysis
    const instruction = forceApprove ? analysisInstructionRef.current : inputText.trim()
    if (!api || !instruction || docBusyRef.current) return
    docBusyRef.current = true
    const { videoSrc, mediaName, duration } = usePlayerStore.getState()
    if (!videoSrc || /^(https?|blob):/i.test(videoSrc)) {
        docBusyRef.current = false
      addMessage('agent', '[错误] 当前没有可解剖的本地视频，请先打开一个视频文件。')
      return
    }
    analysisInstructionRef.current = instruction
    if (!forceApprove) {
      addMessage('user', `${instruction}\n（当前视频：${mediaName || videoSrc}）`)
      setInputText('')
    }
    pendingTaskRef.current = 'analysis'
    setTask({ kind: 'analysis', label: '视频解剖', error: '' })
    setDocBusy(true)
    setDocStatus('正在分析任务')
    setDocOutputs([])
    try {
      const requestId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      docRequestIdRef.current = requestId
      const result = await api.run({
        sourcePath: videoSrc, mediaName, duration, instruction,
        outputFormat: analysisFormatRef.current,
        cloudApproved: cloudApproved || forceApprove,
        requestId
      })
      if (result.requiresApproval) {
        pendingTaskRef.current = 'analysis'
        setNeedsApproval(true)
        return
      }
      if (!result.success) throw new Error(result.error || '视频解剖失败')
      addMessage('agent', result.summary || '解剖完成')
      setDocOutputs(result.outputs || [])
      setNeedsApproval(false)
      setCloudApproved(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTask({ error: message })
      addMessage('agent', `[错误] ${message}`)
    } finally {
      docBusyRef.current = false
      setDocBusy(false)
      setDocStatus('')
    }
  }
  runAnalysisTaskRef.current = runAnalysisTask

  const routeTextSend = async () => {
    const text = inputText.trim()
    const { videoSrc } = usePlayerStore.getState()
    if (/^去重|重复文件|查重/.test(text)) {
      await runDedupTask(text)
      return
    }
    const libraryIntents: Array<[RegExp, string, string]> = [
      [/屏幕录制|开始录制|录屏/, 'record', '已打开屏幕录制（在媒体库页操作）'],
      [/整理建议|整理素材|素材整理/, 'organize', '正在生成素材整理建议'],
      [/^插件|^插件管理/, 'plugins', '已打开插件列表'],
      [/海报刮削|刮削海报|海报信息/, 'poster', '正在刮削海报信息'],
    ]
    const libraryHit = libraryIntents.find(([re]) => re.test(text))
    if (libraryHit) {
      addMessage('user', text)
      setInputText('')
      addMessage('agent', libraryHit[2])
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: libraryHit[1] }))
      return
    }
    if (text && window.aiPlayer?.mediaDownload) {
      try {
        const detection = await window.aiPlayer.mediaDownload.detect(text)
        if (detection?.matched && detection.url) {
          if (detection.mode === 'analyze') await runLinkAnalysisTask(detection.url, text)
          else await runDownloadTask(detection.url, text, detection.direct !== false)
          return
        }
      } catch { /* 意图检测失败时按普通对话处理 */ }
    }
    if (text && videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.analysis) {
      try {
        const detection = await window.aiPlayer.analysis.detect(text)
        if (detection?.matched) {
          analysisFormatRef.current = detection.outputFormat
          await runAnalysisTask()
          return
        }
      } catch { /* 意图检测失败时按普通对话处理 */ }
    }
    void send()
  }
  routeTextSendRef.current = routeTextSend

  const downloadUrlRef = useRef('')
  const linkAnalysisUrlRef = useRef('')
  const linkAnalysisVideoRef = useRef('')
  const runLinkAnalysisTaskRef = useRef<(url: string, instruction: string, forceApprove?: boolean) => Promise<void>>(async () => {})
  const downloadDirectRef = useRef(true)
  const runDownloadTask = async (url: string, instruction: string, direct = true) => {
    const api = window.aiPlayer?.mediaDownload
    if (!api || docBusyRef.current) return
    docBusyRef.current = true
    downloadUrlRef.current = url
    pendingTaskRef.current = 'download'
    setTask({ kind: 'doc', label: direct ? '视频下载' : '站点视频下载', error: '' })
    if (instruction) {
      addMessage('user', instruction)
      setInputText('')
    }
    setDocBusy(true)
    setDocStatus('正在校验链接')
    setDocOutputs([])
    try {
      const requestId = `media-dl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      docRequestIdRef.current = requestId
      const result = direct ? await api.download({ url, requestId }) : await window.aiPlayer?.siteVideo?.download({ url, requestId })
      if (!result) throw new Error('站点下载接口不可用')
      if (!result.success || !result.outputPath) throw new Error(result.error || '下载失败')
      setDocOutputs([result.outputPath])
      const infoTitle = !direct && 'info' in result && result.info?.title ? `，《${String(result.info.title).slice(0, 40)}》` : ''
      addMessage('agent', `视频已下载（${((result.bytes || 0) / 1024 / 1024).toFixed(1)}MB${infoTitle}）：${result.outputPath}，正在为你播放`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTask({ error: message })
      addMessage('agent', `[错误] ${message}`)
    } finally {
      docBusyRef.current = false
      setDocBusy(false)
      setDocStatus('')
    }
  }
  runDownloadTaskRef.current = runDownloadTask
  const importSiteCookies = async () => {
    const api = window.aiPlayer?.siteVideo
    if (!api?.importCookies) return
    try {
      const result = await api.importCookies()
      if (result.success && result.domain) {
        addMessage('agent', `已导入 ${result.domain} 的 Cookies（${result.count || 0} 条），点「重试」继续`)
      } else if (!result.canceled) {
        addMessage('agent', `[错误] ${result.error || 'Cookies 文件无效'}`)
      }
    } catch (error) {
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const loginSite = async () => {
    const api = window.aiPlayer?.siteVideo
    if (!api?.login) return
    addMessage('agent', '已打开站点登录窗口，请扫码或登录（只需这一次，以后自动续期）…')
    try {
      const result = await api.login({ domain: 'douyin.com' })
      if (result.success) {
        addMessage('agent', '登录成功，站点凭证已保存，之后过期会自动续期，点「重试」继续')
      } else if (!result.canceled) {
        addMessage('agent', `[错误] ${result.error || '登录未完成'}`)
      }
    } catch (error) {
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
    }
  }


  const runLinkAnalysisTask = async (url: string, instruction: string, forceApprove = false) => {
    const api = window.aiPlayer?.mediaDownload
    if (!api?.linkAnalysis || docBusyRef.current) return
    docBusyRef.current = true
    linkAnalysisUrlRef.current = url
    pendingTaskRef.current = 'link-analysis'
    setTask({ kind: 'analysis', label: '链接拉片', error: '' })
    if (!forceApprove && instruction) {
      addMessage('user', instruction)
      setInputText('')
    }
    setDocBusy(true)
    setDocStatus('正在准备')
    setDocOutputs([])
    try {
      const requestId = `link-ana-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      docRequestIdRef.current = requestId
      const result = await api.linkAnalysis({
        url,
        videoPath: forceApprove ? linkAnalysisVideoRef.current : undefined,
        instruction,
        cloudApproved: cloudApproved || forceApprove,
        requestId
      })
      if (result.requiresApproval) {
        linkAnalysisVideoRef.current = result.videoPath || ''
        setNeedsApproval(true)
        return
      }
      if (!result.success) throw new Error(result.error || '链接拉片失败')
      setDocOutputs(result.outputs || [])
      addMessage('agent', `${result.summary || '拉片完成'}${result.whispered ? '' : '（未装转写组件，报告仅基于基础结构）'}`)
      if (result.videoPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.videoPath }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTask({ error: message })
      addMessage('agent', `[错误] ${message}`)
    } finally {
      docBusyRef.current = false
      setDocBusy(false)
      setDocStatus('')
    }
  }
  runLinkAnalysisTaskRef.current = runLinkAnalysisTask

  const runDedupTask = async (instruction: string) => {
    if (docBusyRef.current) return
    docBusyRef.current = true
    pendingTaskRef.current = 'doc'
    setTask({ kind: 'doc', label: '重复文件检查', error: '' })
    addMessage('user', instruction)
    setInputText('')
    setDocBusy(true)
    setDocStatus('正在扫描媒体库找重复文件')
    setDocOutputs([])
    try {
      const results = ((await window.aiPlayer?.media?.dedup()) || []) as Array<{ original: string; duplicate: string; name: string }>
      if (!results.length) {
        addMessage('agent', '没有发现内容重复的文件 ✓')
      } else {
        const lines = results.slice(0, 10).map((d, i) => `${i + 1}. ${d.name}`).join('\n')
        const more = results.length > 10 ? `\n…共 ${results.length} 组` : ''
        addMessage('agent', `发现 ${results.length} 组内容重复（下面是重复副本，点开可直接查看）：\n${lines}${more}`)
        setDocOutputs(results.slice(0, 5).map((d) => d.duplicate))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTask({ error: message })
      addMessage('agent', `[错误] ${message}`)
    } finally {
      docBusyRef.current = false
      setDocBusy(false)
      setDocStatus('')
    }
  }

  const cancelDocTask = async () => {
    const requestId = docRequestIdRef.current
    if (!requestId) return
    // 按任务类型分发取消：下载/链接拉片走 media 命名空间，视频解剖走 analysis，其余走文档
    const pending = pendingTaskRef.current
    if (pending === 'download' || pending === 'link-analysis') await window.aiPlayer?.mediaDownload?.cancel(requestId)
    else if (pending === 'analysis') await window.aiPlayer?.analysis?.cancel(requestId)
    else await window.aiPlayer?.documents?.cancel(requestId)
    setDocStatus('正在取消')
  }

  const handleSend = () => {
    if (attachments.length > 0) {
      void runDocTask()
      return
    }
    void routeTextSend()
  }

  useEffect(() => {
    if (!listening) return
    let cancelled = false
    let recorder: MediaRecorder | null = null
    const chunks: Blob[] = []
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        addMessage('agent', '[错误] 当前环境不支持录音')
        setListening(false)
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return
          const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0) + event.data.size
          if (total > 25 * 1024 * 1024) {
            addMessage('agent', '录音已达 25MB 上限，自动停止')
            setListening(false)
            try { recorder?.stop() } catch { /* 已停止 */ }
            return
          }
          chunks.push(event.data)
        }
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop())
          if (cancelled) return
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
          if (!blob.size) return
          setDocStatus('正在离线转写语音…')
          try {
            const data = new Uint8Array(await blob.arrayBuffer())
            const result = await window.aiPlayer?.transcribe?.blob({ data, ext: '.webm' })
            if (result?.success && result.text) {
              const text = result.text.trim()
              if (text) {
                setInputText(text)
                if (attachmentsRef.current.length > 0) void runDocTaskRef.current()
                else void routeTextSendRef.current()
              }
            } else {
              addMessage('agent', `[错误] ${result?.error || '语音转写失败'}`)
            }
          } finally {
            setDocStatus('')
          }
        }
        recorder.start()
      } catch (error) {
        addMessage('agent', `[错误] 无法打开麦克风：${error instanceof Error ? error.message : String(error)}`)
        setListening(false)
      }
    }
    void start()
    return () => {
      cancelled = true
      try { recorder?.stop() } catch { /* 已停止 */ }
    }
  }, [listening, setListening])

  return (
    <div
      className="h-full min-h-0 flex flex-col bg-player-bg"
    >
      <div
        className="flex-1 min-h-0 flex flex-col"
        onDrop={(e) => void handleDropFiles(e)}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <span className="text-sm text-gray-300">AI Agent</span>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleListening}
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                listening ? 'bg-red-500 animate-pulse' : 'bg-player-accent'
              }`}
            >
              🎙️
            </button>
          </div>
        </div>

        <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex shrink-0 overflow-hidden rounded border border-white/15 text-[11px]">
              <button onClick={() => void switchModelMode('cloud')} disabled={modeSwitching} title="使用已配置的云端模型" className={`px-2 py-0.5 ${modelMode === 'cloud' ? 'bg-player-accent text-white' : 'text-gray-400 hover:text-white'}`}>云端</button>
              <button onClick={() => void switchModelMode('bundled')} disabled={modeSwitching} title="使用本机内置离线模型" className={`px-2 py-0.5 ${modelMode === 'bundled' ? 'bg-emerald-600 text-white' : 'text-gray-400 hover:text-white'}`}>本地</button>
            </div>
            <span className="text-xs text-gray-500 truncate">{modelLabel}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))} className="text-xs text-player-accent">模型接入中心</button>
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'computer-use' }))} className="text-xs text-amber-400">电脑观察</button>
            <button onClick={() => setShowServiceEdit((value) => !value)} className="text-xs text-gray-400">海报/字幕 Key</button>
          </div>
        </div>
        {showServiceEdit && (
          <div className="px-4 py-3 border-b border-white/10">
            <p className="text-xs text-gray-400 mb-2">可选的媒体信息服务</p>
            <div className="grid grid-cols-1 gap-2">
              <input
                type="password"
                value={tmdbKey}
                onChange={(e) => setTmdbKey(e.target.value)}
                placeholder="TMDB key（可选，海报刮削）"
                className="w-full bg-black/40 rounded px-2 py-1 text-xs outline-none"
              />
              <input
                type="password"
                value={subtitleKey}
                onChange={(e) => setSubtitleKey(e.target.value)}
                placeholder="OpenSubtitles API key（可选）"
                className="w-full bg-black/40 rounded px-2 py-1 text-xs outline-none"
              />
              <button onClick={saveOtherServices} className="px-3 py-1 bg-player-accent rounded text-xs">
                保存配置
              </button>
            </div>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2">
            {attachments.map((file) => (
              <span key={file.token} className="flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-500/10 px-2 py-1 text-xs text-blue-200">
                <span className="font-semibold uppercase">{file.ext.slice(1)}</span>
                <span className="max-w-40 truncate">{file.name}</span>
                <button onClick={() => setAttachments((current) => current.filter((item) => item.token !== file.token))} className="text-blue-300 hover:text-white">✕</button>
              </span>
            ))}
            <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)} className="ml-auto rounded border border-white/10 bg-[#111c2d] px-2 py-1 text-xs text-gray-300 outline-none">
              <option value="auto">输出：自动判断</option>
              <option value="docx">Word (.docx)</option>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="pptx">PPT (.pptx)</option>
              <option value="pdf">PDF</option>
              <option value="md">Markdown</option>
              <option value="txt">纯文本</option>
            </select>
          </div>
        )}
        {suggestedActions.length > 0 && (
          <div className="px-4 py-2 border-b border-white/10 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-500">快捷动作：</span>
            {suggestedActions.map((action) => (
              <button key={action.label} disabled={docBusy} onClick={() => runSuggested(action.text)} className="rounded-full border border-player-accent/40 bg-player-accent/10 px-3 py-1 text-xs text-player-accent hover:bg-player-accent/20 disabled:opacity-40">
                {action.label}
              </button>
            ))}
          </div>
        )}
        {needsApproval && (
          <div className="flex items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.06] px-4 py-2 text-xs text-amber-100">
            <label className="flex flex-1 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={cloudApproved} onChange={(event) => setCloudApproved(event.target.checked)} />
              允许把本次任务的内容（文件正文、字幕或视频关键画面截图）发送给当前云端模型
            </label>
            <button disabled={!cloudApproved || docBusy} onClick={() => { setNeedsApproval(false); if (pendingTaskRef.current === 'analysis') void runAnalysisTaskRef.current(true); else if (pendingTaskRef.current === 'link-analysis') void runLinkAnalysisTaskRef.current(linkAnalysisUrlRef.current, '', true); else void runDocTaskRef.current(true) }} className="rounded bg-amber-600 px-3 py-1 text-white disabled:opacity-40">继续执行</button>
          </div>
        )}


        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {messages.length === 0 && attachments.length === 0 && (
            <div className="mt-6">
              <p className="text-gray-500 text-sm text-center">说点什么，或点 📎 打开视频和文档，也可以直接把文件拖进来</p>
              <div className="mt-4 grid grid-cols-2 gap-2">
                {EXAMPLE_TASKS.map((task) => (
                  <button
                    key={task.label}
                    onClick={() => { setInputText(task.text); setOutputFormat(task.format) }}
                    className="rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-gray-300 hover:border-player-accent hover:bg-white/5"
                  >
                    {task.label}
                  </button>
                ))}
              </div>
              {history.length > 0 && (
                <div className="mt-5">
                  <p className="text-[11px] text-gray-600 mb-1">最近任务</p>
                  <div className="space-y-1">
                    {history.slice(0, 5).map((record) => (
                      <div key={record.id} className="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2">
                        <p className="truncate text-xs text-gray-400">{record.instruction}</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {record.outputs.map((output) => (
                            <button key={output} onClick={() => void window.aiPlayer?.system?.openPath(output)} className="truncate rounded bg-black/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-black/50" title={output}>
                              {output.split(/[\\/]/).pop()}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {messages.length === 0 && attachments.length > 0 && (
            <p className="text-gray-500 text-sm text-center mt-8">附件已就绪，说对它们要做什么…</p>
          )}
          {(docBusy || docOutputs.length > 0 || task.error) && (
            <div className="rounded-xl border border-emerald-400/20 bg-emerald-500/[0.07] p-3 select-text">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-emerald-100">{task.label || '任务'}</span>
                {docBusy && <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-400" />}
              </div>
              {docBusy && (() => {
                const progress = /（(\d+)\/(\d+)）/.exec(docStatus || '')
                const percent = progress ? Math.round((Number(progress[1]) / Number(progress[2])) * 100) : null
                return (
                  <>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
                      <div className={`h-full bg-blue-500 transition-all ${percent === null ? 'animate-pulse' : ''}`} style={{ width: `${percent ?? 30}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-slate-300">{docStatus || '正在处理…'}</p>
                  </>
                )
              })()}
              {task.error && (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="min-w-0 text-xs text-red-300">{task.error}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    {/cookies|登录态/i.test(task.error) && (
                      <><button onClick={() => void loginSite()} className="rounded bg-emerald-500/20 px-3 py-1 text-xs text-emerald-100 hover:bg-emerald-500/30">扫码登录</button><button onClick={() => void importSiteCookies()} className="rounded bg-orange-500/20 px-3 py-1 text-xs text-orange-100 hover:bg-orange-500/30">导入 Cookies</button></>
                    )}
                    <button onClick={() => { setTask({ error: '' }); if (pendingTaskRef.current === 'analysis') void runAnalysisTaskRef.current(); else if (pendingTaskRef.current === 'download') void runDownloadTaskRef.current(downloadUrlRef.current, '', downloadDirectRef.current); else if (pendingTaskRef.current === 'link-analysis') void runLinkAnalysisTaskRef.current(linkAnalysisUrlRef.current, '', true); else void runDocTaskRef.current() }} className="rounded bg-white/10 px-3 py-1 text-xs text-white hover:bg-white/20">重试</button>
                  </div>
                </div>
              )}
              {docOutputs.length > 0 && <div className="mt-1 space-y-1">{docOutputs.map((output) => (
                <button key={output} onClick={() => void window.aiPlayer?.system?.openPath(output)} className="block w-full truncate rounded bg-black/20 px-2 py-1.5 text-left text-xs text-emerald-200 hover:bg-black/30" title={output}>打开结果：{output}</button>
              ))}</div>}
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`text-sm ${m.role === 'user' ? 'text-white text-right' : 'text-gray-300'}`}
            >
              {m.text}
            </div>
          ))}
        </div>
        {/* 输入框（贴底） */}
        <div className="px-4 py-3 border-t border-white/10 flex gap-2">
          <button onClick={openAny} title="打开文件（视频、音频、图片或文档）" className="w-9 h-9 shrink-0 rounded-lg bg-white/10 hover:bg-white/15 flex items-center justify-center text-base">📎</button>
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !thinking && !docBusy && handleSend()}
            placeholder={attachments.length ? '说对这些附件要做什么…' : '打字或点麦克风说话…'}
            className="flex-1 bg-black/40 rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 ring-player-accent"
          />
          <button onClick={docBusy ? cancelDocTask : thinking ? cancel : handleSend} className={`px-4 py-2 rounded-lg text-sm ${docBusy || thinking ? 'bg-red-600' : 'bg-player-accent'}`}>
            {docBusy || thinking ? '停止' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}