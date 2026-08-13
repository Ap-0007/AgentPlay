import { useRef } from 'react'
import type { AgentTask } from '../../stores/agentStore'
import type { WorkspaceTaskInput } from '../../taskLifecycle'
import type { PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }
type RecutOffer = { reportText: string; mediaName: string }

type LinkMediaTaskOptions = {
  busyRef: CurrentRef<boolean>
  executionTaskIdRef: CurrentRef<string>
  pendingTaskRef: CurrentRef<PendingTaskKind>
  startTask: (input: WorkspaceTaskInput) => string
  mutateTask: (patch: Partial<AgentTask>) => void
  setTaskBusy: (value: boolean) => void
  setTaskStatus: (value: string) => void
  setTaskOutputs: (value: string[]) => void
  bindCancelableRequest: (requestId: string) => void
  releaseCancelableRequest: (requestId: string) => void
  completeExecutionTask: (patch?: Partial<AgentTask>) => void
  failExecutionTask: (error: string) => void
  executionWasCancelled: () => boolean
  addMessage: (role: 'user' | 'agent', text: string) => void
  setInputText: (value: string) => void
  cloudApproved: boolean
  requestCloudApproval: () => void
  offerRecut: (offer: RecutOffer) => void
}

export default function useLinkMediaTasks(options: LinkMediaTaskOptions) {
  const {
    busyRef, executionTaskIdRef, pendingTaskRef, startTask, mutateTask,
    setTaskBusy, setTaskStatus, setTaskOutputs, bindCancelableRequest,
    releaseCancelableRequest, completeExecutionTask, failExecutionTask,
    executionWasCancelled, addMessage, setInputText, cloudApproved,
    requestCloudApproval, offerRecut
  } = options
  const downloadUrlRef = useRef('')
  const linkAnalysisUrlRef = useRef('')
  const linkAnalysisVideoRef = useRef('')
  const downloadDirectRef = useRef(true)

  const runDownloadTask = async (url: string, instruction: string, direct = true) => {
    const api = window.aiPlayer?.mediaDownload
    if (!api || busyRef.current) return
    busyRef.current = true
    downloadUrlRef.current = url
    pendingTaskRef.current = 'download'
    executionTaskIdRef.current = startTask({ kind: 'download', label: direct ? '视频下载' : '站点视频下载', instruction: instruction || url, source: url, retry: { kind: 'download', url, direct } })
    downloadDirectRef.current = direct
    if (instruction) {
      addMessage('user', instruction)
      setInputText('')
    }
    setTaskBusy(true)
    setTaskStatus('正在校验链接')
    setTaskOutputs([])
    let requestId = ''
    try {
      requestId = `media-dl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      bindCancelableRequest(requestId)
      const result = direct
        ? await api.download({ url, requestId, workspaceTaskId: executionTaskIdRef.current })
        : await window.aiPlayer?.siteVideo?.download({ url, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result) throw new Error('站点下载接口不可用')
      if (!result.success || !result.outputPath) throw new Error(result.error || '下载失败')
      completeExecutionTask({ outputs: [result.outputPath], summary: '视频下载完成' })
      const infoTitle = !direct && 'info' in result && result.info?.title ? `，《${String(result.info.title).slice(0, 40)}》` : ''
      addMessage('agent', `视频已下载（${((result.bytes || 0) / 1024 / 1024).toFixed(1)}MB${infoTitle}）：${result.outputPath}，正在为你播放`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      if (requestId) releaseCancelableRequest(requestId)
      busyRef.current = false
      setTaskBusy(false)
      setTaskStatus('')
    }
  }

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
    const targetUrl = pendingTaskRef.current === 'link-analysis' ? linkAnalysisUrlRef.current : downloadUrlRef.current
    if (!targetUrl) {
      addMessage('agent', '[错误] 没有可登录的站点链接')
      return
    }
    addMessage('agent', '已打开站点登录窗口，请扫码或登录（只需这一次，以后自动续期）…')
    try {
      const result = await api.login({ url: targetUrl })
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
    if (!api?.linkAnalysis || busyRef.current) return
    busyRef.current = true
    linkAnalysisUrlRef.current = url
    if (!forceApprove) linkAnalysisVideoRef.current = ''
    pendingTaskRef.current = 'link-analysis'
    if (forceApprove && executionTaskIdRef.current) mutateTask({ phase: 'queued', error: '' })
    else executionTaskIdRef.current = startTask({ kind: 'link-analysis', label: '链接拉片', instruction: instruction || '下载并拉片', source: url, retry: { kind: 'link-analysis', url, instruction } })
    if (!forceApprove && instruction) {
      addMessage('user', instruction)
      setInputText('')
    }
    setTaskBusy(true)
    setTaskStatus('正在准备')
    setTaskOutputs([])
    let requestId = ''
    try {
      requestId = `link-ana-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      bindCancelableRequest(requestId)
      const result = await api.linkAnalysis({
        url,
        videoPath: forceApprove ? linkAnalysisVideoRef.current : undefined,
        instruction,
        cloudApproved: cloudApproved || forceApprove,
        requestId
      })
      if (result.requiresApproval) {
        linkAnalysisVideoRef.current = result.videoPath || ''
        mutateTask({ phase: 'waiting', status: '等待允许云端处理' })
        requestCloudApproval()
        return
      }
      if (!result.success) throw new Error(result.error || '链接拉片失败')
      completeExecutionTask({ outputs: result.outputs || [], summary: result.summary || '拉片完成' })
      addMessage('agent', `${result.summary || '拉片完成'}${result.whispered ? '' : '（未装转写组件，报告仅基于基础结构）'}`)
      const analyzedVideoPath = result.videoPath || linkAnalysisVideoRef.current
      if (result.usedAi) offerRecut({ reportText: result.excerpt || result.summary || '', mediaName: analyzedVideoPath.split(/[\\/]/).pop() || '拉片视频' })
      if (result.videoPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.videoPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      if (requestId) releaseCancelableRequest(requestId)
      busyRef.current = false
      setTaskBusy(false)
      setTaskStatus('')
    }
  }

  const resumeLinkAnalysis = () => runLinkAnalysisTask(linkAnalysisUrlRef.current, '', true)

  const retryActiveLinkTask = () => pendingTaskRef.current === 'download'
    ? runDownloadTask(downloadUrlRef.current, '', downloadDirectRef.current)
    : runLinkAnalysisTask(linkAnalysisUrlRef.current, '', true)

  return { runDownloadTask, runLinkAnalysisTask, importSiteCookies, loginSite, resumeLinkAnalysis, retryActiveLinkTask }
}
