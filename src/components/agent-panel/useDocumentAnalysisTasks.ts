import { useEffect, useRef } from 'react'
import type { AgentTask } from '../../stores/agentStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { WorkspaceTaskInput, WorkspaceTaskRetry } from '../../taskLifecycle'
import { kindLabel } from './suggestions'
import type { AgentAttachment, DocumentCapabilities, PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }
type RecutOffer = { reportText: string; mediaName: string }

type DocumentAnalysisTaskOptions = {
  busyRef: CurrentRef<boolean>
  requestIdRef: CurrentRef<string>
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
  inputText: string
  setInputText: (value: string) => void
  attachments: AgentAttachment[]
  clearAttachments: () => void
  documentCapabilities: DocumentCapabilities | null
  setDocumentCapabilities: (capabilities: DocumentCapabilities) => void
  outputFormat: string
  cloudApproved: boolean
  requestCloudApproval: () => void
  clearCloudApproval: () => void
  offerRecut: (offer: RecutOffer) => void
}

export default function useDocumentAnalysisTasks(options: DocumentAnalysisTaskOptions) {
  const {
    busyRef, requestIdRef, executionTaskIdRef, pendingTaskRef, startTask,
    mutateTask, setTaskBusy, setTaskStatus, setTaskOutputs,
    bindCancelableRequest, releaseCancelableRequest, completeExecutionTask,
    failExecutionTask, executionWasCancelled, addMessage, inputText,
    setInputText, attachments, clearAttachments, documentCapabilities,
    setDocumentCapabilities, outputFormat, cloudApproved,
    requestCloudApproval, clearCloudApproval, offerRecut
  } = options
  const docInstructionRef = useRef('')
  const analysisInstructionRef = useRef('')
  const analysisFormatRef = useRef('docx')
  const analysisApprovalRequestIdRef = useRef('')

  useEffect(() => {
    const offDocument = window.aiPlayer?.documents?.onStatus((event) => {
      if (event.requestId === requestIdRef.current) setTaskStatus(event.status)
    })
    const offAnalysis = window.aiPlayer?.analysis?.onStatus((event) => {
      if (event.requestId === requestIdRef.current) setTaskStatus(event.status)
    })
    return () => {
      offDocument?.()
      offAnalysis?.()
    }
  }, [])

  const runDocumentTask = async (forceApprove = false, instructionOverride = '', forceLocal = false) => {
    const api = window.aiPlayer?.documents
    const instruction = forceApprove ? docInstructionRef.current : instructionOverride || inputText.trim()
    if (!api || !instruction || busyRef.current) return
    busyRef.current = true
    docInstructionRef.current = instruction
    const files = attachments
    if (!forceApprove && !instructionOverride) {
      addMessage('user', `${instruction}\n（附件：${files.map((file) => file.name).join('、')}）`)
      setInputText('')
    }
    pendingTaskRef.current = 'doc'
    if (forceApprove && executionTaskIdRef.current) mutateTask({ phase: 'queued', error: '' })
    else executionTaskIdRef.current = startTask({ kind: 'doc', label: '文档任务', instruction, source: files.map((file) => file.name).join('、'), retry: { kind: 'doc', instruction, outputFormat } })
    setTaskBusy(true)
    setTaskStatus('正在分析任务')
    setTaskOutputs([])
    let requestId = ''
    try {
      const capabilities = documentCapabilities || (await api.capabilities()) || null
      if (capabilities && !documentCapabilities) setDocumentCapabilities(capabilities)
      const tokens = files.map((file) => file.token)
      const preview = await api.plan({ tokens, instruction, outputFormat })
      const processingNote = preview.processingMode === 'local-chunked'
        ? `；正文约 ${preview.estimatedTokens || '较多'} tokens，将自动分段处理`
        : preview.processingMode === 'cloud-fallback'
          ? `；将使用大上下文模型 ${preview.fallbackModel || ''}`
          : ''
      addMessage('agent', `方案：${kindLabel(preview.kind)} → ${preview.outputFormat.toUpperCase()}${preview.requiresAi ? '（需要模型）' : '（本地执行）'}${processingNote}`)
      if (preview.requiresAi && capabilities && !capabilities.modelConfigured) {
        throw new Error('这个任务需要模型理解或生成内容，请先在模型接入中心配置模型。')
      }
      if (preview.requiresCloudApproval && !(cloudApproved || forceApprove || forceLocal)) {
        pendingTaskRef.current = 'doc'
        mutateTask({ phase: 'waiting', status: '长文档可切换大上下文云模型' })
        addMessage('agent', `当前本地模型约 ${preview.contextWindow} tokens；可继续本地分段，或经你允许后改用 ${preview.fallbackModel}。`)
        requestCloudApproval()
        return
      }
      if (preview.requiresAi && capabilities && !capabilities.modelLocal && !(cloudApproved || forceApprove)) {
        pendingTaskRef.current = 'doc'
        mutateTask({ phase: 'waiting', status: '等待允许云端处理' })
        requestCloudApproval()
        return
      }
      requestId = `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      bindCancelableRequest(requestId)
      const result = await api.run({ tokens, instruction, outputFormat, cloudApproved: !forceLocal && (cloudApproved || forceApprove),
        preferLocal: forceLocal,
        requestId,
        workspaceTaskId: executionTaskIdRef.current
      })
      if (result.requiresApproval) {
        pendingTaskRef.current = 'doc'
        mutateTask({ phase: 'waiting', status: result.approval?.summary || '等待允许云端处理' })
        requestCloudApproval()
        return
      }
      if (!result.success) throw new Error(result.error || '文档处理失败')
      addMessage('agent', result.summary || '处理完成')
      completeExecutionTask({ outputs: result.outputs || [], summary: result.summary || '处理完成' })
      clearAttachments()
      clearCloudApproval()
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

  useEffect(() => {
    const onAgentDocumentTask = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail
      if (detail?.action !== 'start_advanced_document_ocr') return
      void runDocumentTask(false, '使用高级文档解析提取当前扫描 PDF 的文字并整理成 Markdown')
    }
    window.addEventListener('ai-player-agent-document-task', onAgentDocumentTask)
    return () => window.removeEventListener('ai-player-agent-document-task', onAgentDocumentTask)
  }, [attachments, documentCapabilities, outputFormat, cloudApproved])

  const runAnalysisTask = async (forceApprove = false, instructionOverride = '') => {
    const api = window.aiPlayer?.analysis
    const instruction = forceApprove ? analysisInstructionRef.current : instructionOverride || inputText.trim()
    if (!api || !instruction || busyRef.current) return
    busyRef.current = true
    const { videoSrc, mediaName, duration } = usePlayerStore.getState()
    if (!videoSrc || /^(https?|blob):/i.test(videoSrc)) {
      busyRef.current = false
      addMessage('agent', '[错误] 当前没有可解剖的本地视频，请先打开一个视频文件。')
      return
    }
    analysisInstructionRef.current = instruction
    if (!forceApprove && !instructionOverride) {
      addMessage('user', `${instruction}\n（当前视频：${mediaName || videoSrc}）`)
      setInputText('')
    }
    pendingTaskRef.current = 'analysis'
    if (forceApprove && executionTaskIdRef.current) mutateTask({ phase: 'queued', error: '' })
    else executionTaskIdRef.current = startTask({ kind: 'analysis', label: '视频解剖', instruction, source: videoSrc, retry: { kind: 'analysis', instruction, sourcePath: videoSrc, outputFormat: analysisFormatRef.current } })
    setTaskBusy(true)
    setTaskStatus('正在分析任务')
    setTaskOutputs([])
    let requestId = ''
    let waitingApproval = false
    try {
      requestId = forceApprove && analysisApprovalRequestIdRef.current
        ? analysisApprovalRequestIdRef.current
        : `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      bindCancelableRequest(requestId)
      const result = await api.run({
        sourcePath: videoSrc, mediaName, duration, instruction,
        outputFormat: analysisFormatRef.current,
        cloudApproved: cloudApproved || forceApprove,
        requestId,
        workspaceTaskId: executionTaskIdRef.current
      })
      if (result.requiresApproval) {
        waitingApproval = true
        analysisApprovalRequestIdRef.current = requestId
        pendingTaskRef.current = 'analysis'
        mutateTask({ phase: 'waiting', status: result.approval?.summary || '等待允许云端处理' })
        requestCloudApproval()
        return
      }
      if (!result.success) throw new Error(result.error || '视频解剖失败')
      analysisApprovalRequestIdRef.current = ''
      addMessage('agent', result.summary || '解剖完成')
      completeExecutionTask({ outputs: result.outputs || [], summary: result.summary || '解剖完成' })
      if (result.usedAi) offerRecut({ reportText: result.excerpt || result.summary || '', mediaName: mediaName || '当前视频' })
      clearCloudApproval()
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      if (requestId && !waitingApproval) {
        releaseCancelableRequest(requestId)
        if (analysisApprovalRequestIdRef.current === requestId) analysisApprovalRequestIdRef.current = ''
      }
      busyRef.current = false
      setTaskBusy(false)
      setTaskStatus('')
    }
  }

  const setAnalysisFormat = (format: string) => {
    analysisFormatRef.current = format || 'docx'
  }

  const resumePendingTask = () => pendingTaskRef.current === 'analysis'
    ? runAnalysisTask(true)
    : runDocumentTask(true)

  const retryActiveTask = () => pendingTaskRef.current === 'analysis'
    ? runAnalysisTask(false, analysisInstructionRef.current)
    : runDocumentTask(false, docInstructionRef.current)

  const retryStoredAnalysisTask = (retry: WorkspaceTaskRetry) => {
    if (!retry.sourcePath) return
    usePlayerStore.getState().setMedia(retry.sourcePath.split(/[\\/]/).pop() || '待分析视频', retry.sourcePath)
    setAnalysisFormat(retry.outputFormat || 'docx')
    return runAnalysisTask(false, retry.instruction || '深度解剖这个视频')
  }

  return {
    runDocumentTask,
    resumeLocalDocumentTask: () => runDocumentTask(false, docInstructionRef.current, true),
    runAnalysisTask,
    setAnalysisFormat,
    resumePendingTask,
    retryActiveTask,
    retryStoredAnalysisTask
  }
}
