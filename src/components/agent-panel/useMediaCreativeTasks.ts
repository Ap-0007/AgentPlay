import { useEffect, useRef } from 'react'
import type { AgentTask } from '../../stores/agentStore'
import { usePlayerStore } from '../../stores/playerStore'
import type { WorkspaceTaskInput, WorkspaceTaskRetry } from '../../taskLifecycle'
import type { AgentAttachment, PendingTaskKind } from './types'

type CurrentRef<T> = { current: T }
type RecutOffer = { reportText: string; mediaName: string }
type BatchInput = { instruction: string; targets: AgentAttachment[] }
type CompressInput = {
  instruction: string
  sourcePath: string
  targetMb: number
  mode: 'compress' | 'remux'
}
type TrimInput = {
  instruction: string
  sourcePath: string
  startSeconds: number
  endSeconds: number
  operation?: 'trim' | 'remove' | 'concat' | 'music' | 'audio-mix' | 'audio-repair' | 'rhythm' | 'effects' | 'reframe' | 'repair' | 'subtitle' | 'shift' | 'mux' | 'translate' | 'cue-edit' | 'transform' | 'layout'
  segments?: Array<{ startSeconds: number; endSeconds: number }>
  decision?: MediaEditDecisionV1
}
type PendingSemanticReview = { sourcePath: string; decision: MediaEditDecisionV1 }
type PendingLongVersionPlan = { sourcePath: string; plan: LongVideoVersionPlanV1 }
type VersionBundleInput = { sourcePath: string; plan: LongVideoVersionPlanV1 }

type MediaCreativeTaskOptions = {
  busyRef: CurrentRef<boolean>
  requestIdRef: CurrentRef<string>
  executionTaskIdRef: CurrentRef<string>
  pendingTaskRef: CurrentRef<PendingTaskKind>
  startTask: (input: WorkspaceTaskInput) => string
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
  attachments: AgentAttachment[]
  clearRecutOffer: () => void
}

const VIDEO_GENERATION_INTENT = /^生成(一段|一个|一条|个|段|条)?视频|^做(一段|一个|一条|个|段|条)?视频|^来(一段|一条)视频/
const AUDIO_VIDEO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma', '.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv'])
const VIDEO_PLAY_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
// 剪辑成果也可能是字幕等非视频文件（如字幕调时产出的 .srt），这类成果只给回执不自动进播放器
const isPlayableVideoPath = (value: string) => VIDEO_PLAY_EXTENSIONS.has((/\.[^.\\/]+$/.exec(String(value || ''))?.[0] || '').toLowerCase())
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const AUDIO_FILE_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma'])
const sameLocalPath = (left: string, right: string) => left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase()

export default function useMediaCreativeTasks(options: MediaCreativeTaskOptions) {
  const {
    busyRef, requestIdRef, executionTaskIdRef, pendingTaskRef, startTask,
    setTaskBusy, setTaskStatus, setTaskOutputs, bindCancelableRequest,
    releaseCancelableRequest, completeExecutionTask, failExecutionTask,
    executionWasCancelled, addMessage, setInputText, attachments,
    clearRecutOffer
  } = options
  const recutInputRef = useRef<RecutOffer | null>(null)
  const batchInputRef = useRef<BatchInput>({ instruction: '', targets: [] })
  const compressInputRef = useRef<CompressInput>({ instruction: '', sourcePath: '', targetMb: 25, mode: 'compress' })
  const trimInputRef = useRef<TrimInput>({ instruction: '', sourcePath: '', startSeconds: 0, endSeconds: 0 })
  const pendingEditClarificationRef = useRef<MediaEditClarification | null>(null)
  const pendingSemanticReviewRef = useRef<PendingSemanticReview | null>(null)
  const pendingLongVersionRef = useRef<PendingLongVersionPlan | null>(null)
  const versionBundleInputRef = useRef<VersionBundleInput | null>(null)
  const videoGenInstructionRef = useRef('')
  const dedupInstructionRef = useRef('')

  useEffect(() => {
    const off = window.aiPlayer?.media?.onDedupProgress((event) => {
      if (event.requestId !== requestIdRef.current) return
      if (event.phase === 'scanning') {
        setTaskStatus(`正在扫描媒体库 · 已发现 ${event.filesScanned || 0} 个媒体文件`)
        return
      }
      if (event.phase === 'hashing') {
        const total = event.totalFiles || 0
        const done = event.processedFiles || 0
        const percent = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0
        setTaskStatus(total > 0 ? `正在核对文件内容 ${done}/${total} · ${percent}%` : '正在筛选可能重复的文件')
      }
    })
    return off
  }, [])

  const runRecutShort = async (input: RecutOffer | null, retrying = false) => {
    if (!input || busyRef.current) return
    busyRef.current = true
    recutInputRef.current = input
    clearRecutOffer()
    if (!retrying) addMessage('user', '🎬 生成重构短片')
    executionTaskIdRef.current = startTask({
      kind: 'creative', label: '生成重构短片', phase: 'running', status: '正在准备镜头脚本…',
      instruction: '生成重构短片', source: input.mediaName, retry: { kind: 'recut' }
    })
    const requestId = `recut-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'recut'
    bindCancelableRequest(requestId)
    const off = window.aiPlayer?.studio?.onRecutProgress?.((event) => {
      if (event.requestId === requestId || !event.requestId) setTaskStatus(event.stage)
    })
    try {
      setTaskStatus('正在本机提取节奏、景别、运镜、光线和色彩蓝图…')
      const stylePlan = await window.aiPlayer?.studio?.planRecut?.({ ...input, count: 3 })
      if (!stylePlan?.success || !stylePlan.blueprintSha256) throw new Error(stylePlan?.error || '风格蓝图生成失败')
      addMessage('agent', `${stylePlan.summary}\n接下来只把抽象蓝图与原创目标交给模型；不会发送拉片报告正文或参考帧。`)
      const result = await window.aiPlayer?.studio?.recutShort({ ...input, count: 3, blueprintSha256: stylePlan.blueprintSha256, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '重构短片生成失败')
      completeExecutionTask({ outputs: [result.outputPath], summary: result.summary || '原创重构任务已完成' })
      addMessage('agent', `${result.summary || '原创重构短片已生成'}\n共 ${result.clips || 3} 个 AI 镜头，正在为你播放：${result.outputPath}`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      off?.()
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runVideoGenTask = async (text: string, retrying = false) => {
    if (!text || busyRef.current) return
    busyRef.current = true
    videoGenInstructionRef.current = text
    if (!retrying) {
      addMessage('user', text)
      setInputText('')
    }
    const prompt = (text.split(/[：:，,]/).slice(1).join('，') || text.replace(VIDEO_GENERATION_INTENT, '')).trim() || '一段有科技感的抽象动画'
    const seconds = Math.max(1, Math.min(8, Number(/(\d+)\s*秒/.exec(text)?.[1]) || 4))
    executionTaskIdRef.current = startTask({
      kind: 'creative', label: 'AI 生成视频', phase: 'running', status: `正在生成 ${seconds} 秒视频（约 1-2 分钟）…`,
      instruction: text, retry: { kind: 'video-gen', instruction: text }
    })
    const requestId = `video-gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'video-gen'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer?.studio?.generateVideo({ prompt, duration: seconds, requestId, workspaceTaskId: executionTaskIdRef.current, instruction: text })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '视频生成失败')
      completeExecutionTask({ outputs: [result.outputPath], summary: '任务已完成' })
      addMessage('agent', `视频已生成（${result.numFrames || ''} 帧），正在为你播放：${result.outputPath}`)
      window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runBatchTask = async (text: string, targetOverride?: AgentAttachment[]) => {
    if (!text || busyRef.current) return
    const kind = /转写/.test(text) ? 'transcribe' : 'compress'
    const targets = targetOverride || attachments.filter((file) => (kind === 'transcribe' ? AUDIO_VIDEO_EXTENSIONS : VIDEO_EXTENSIONS).has(file.ext))
    if (!targets.length) {
      addMessage('agent', kind === 'transcribe' ? '附件里没有可转写的音视频文件' : '附件里没有可压缩的视频文件')
      return
    }
    busyRef.current = true
    batchInputRef.current = { instruction: text, targets: [...targets] }
    if (!targetOverride) {
      addMessage('user', text)
      setInputText('')
    }
    const label = kind === 'transcribe' ? `批量转写 ${targets.length} 个文件` : `批量压缩 ${targets.length} 个视频`
    executionTaskIdRef.current = startTask({
      kind: 'media', label, phase: 'running', status: '准备中…', instruction: text,
      source: targets.map((file) => file.name).join('、'), retry: { kind: 'batch', instruction: text }
    })
    const requestId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'batch'
    bindCancelableRequest(requestId)
    const off = window.aiPlayer?.mediaBatch?.onProgress?.((event) => {
      if (event.requestId === requestId || !event.requestId) setTaskStatus(`（${event.done}/${event.total}）${event.name}`)
    })
    try {
      const result = await window.aiPlayer?.mediaBatch?.run({ tokens: targets.map((file) => file.token), kind, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success) throw new Error(result?.error || '批量任务失败')
      const succeeded = (result.results || []).filter((item) => item.success)
      const failed = (result.results || []).filter((item) => !item.success)
      const outputs = succeeded.map((item) => item.outputPath).filter(Boolean) as string[]
      completeExecutionTask({ outputs, summary: `${label}完成：成功 ${succeeded.length}/${targets.length}` })
      addMessage('agent', `${label}完成：成功 ${succeeded.length}/${targets.length}${failed.length ? `；失败 ${failed.length} 个（${failed[0]?.error || ''}）` : ''}`)
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      off?.()
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runEditHistoryTask = async (text: string): Promise<boolean> => {
    if (!text) return false
    const currentPath = usePlayerStore.getState().videoSrc
    if (!currentPath || /^(https?|blob):/i.test(currentPath) || !window.aiPlayer?.mediaTools?.planHistory) return false
    try {
      const plan = await window.aiPlayer.mediaTools.planHistory({ instruction: text, currentPath })
      if (!plan?.matched || !plan.action) return false
      addMessage('user', text)
      setInputText('')
      if (busyRef.current) {
        addMessage('agent', '当前任务还在处理中，完成后再撤销或重做，避免切换到错误版本。')
        return true
      }
      const result = await window.aiPlayer.mediaTools.navigateHistory({ instruction: text, currentPath })
      if (!result?.success || !result.currentPath) {
        addMessage('agent', `[错误] ${result?.error || '没有可以切换的编辑版本'}`)
        return true
      }
      const position = Number(result.cursor) + 1
      addMessage('agent', `${result.summary || '已切换编辑版本'}\n项目版本：${position}/${result.versionCount || position}；所有版本文件均保留。`)
      if (isPlayableVideoPath(result.currentPath)) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.currentPath }))
      return true
    } catch (error) {
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  const runVersionBundleTask = async (input: VersionBundleInput): Promise<boolean> => {
    if (busyRef.current) return true
    busyRef.current = true
    versionBundleInputRef.current = input
    executionTaskIdRef.current = startTask({
      kind: 'media', label: `生成长视频多版本 ${input.plan.variants.length + input.plan.chapters.length} 个`, phase: 'running',
      status: '正在按共享章节与高光证据生成多个版本…', instruction: input.plan.instruction, source: input.sourcePath,
      retry: { kind: 'versions', instruction: input.plan.instruction, sourcePath: input.sourcePath }
    })
    const requestId = `versions-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'versions'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer?.mediaTools?.runVersionBundle({ sourcePath: input.sourcePath, plan: input.plan, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputs?.length) throw new Error(result?.error || '长视频多版本生成失败')
      completeExecutionTask({ outputs: result.outputs, summary: result.summary || `已生成 ${result.outputs.length} 个视频版本` })
      const lines = (result.versions || []).map((item) => `- ${item.label}：${Number(item.durationSeconds || 0).toFixed(2)}秒`).join('\n')
      addMessage('agent', `${result.summary || `已生成 ${result.outputs.length} 个视频版本`}\n${lines}\n所有版本来自同一份字幕证据，原文件未改动。`)
      if (result.outputs[0]) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputs[0] }))
      return true
    } catch (error) {
      if (executionWasCancelled()) return true
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
      return true
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runTrimTask = async (text: string, override?: TrimInput): Promise<boolean> => {
    if (!text) return false
    const currentPath = override?.sourcePath || usePlayerStore.getState().videoSrc
    const pendingLongVersion = override ? null : pendingLongVersionRef.current
    if (pendingLongVersion && (!currentPath || !sameLocalPath(currentPath, pendingLongVersion.sourcePath))) {
      pendingLongVersionRef.current = null
      addMessage('user', text); setInputText('')
      addMessage('agent', '当前视频已经切换，刚才待确认的长视频多版本方案已取消。')
      return true
    }
    if (pendingLongVersion) {
      addMessage('user', text); setInputText('')
      if (/^(?:算了|取消|不执行|先不做了)[吧。！!]*$/.test(text.trim())) {
        pendingLongVersionRef.current = null
        addMessage('agent', '好的，已取消多版本方案，没有创建任务，也没有改动文件。')
        return true
      }
      if (!/^(?:确认(?:执行)?|执行|就按这个(?:方案)?|按这个方案执行)[吧。！!]*$/.test(text.trim())) {
        addMessage('agent', '多版本方案尚未执行。请回复“确认执行”或“取消”。')
        return true
      }
      pendingLongVersionRef.current = null
      return runVersionBundleTask({ sourcePath: pendingLongVersion.sourcePath, plan: pendingLongVersion.plan })
    }
    const pendingSemanticReview = override ? null : pendingSemanticReviewRef.current
    if (pendingSemanticReview && (!currentPath || !sameLocalPath(currentPath, pendingSemanticReview.sourcePath))) {
      pendingSemanticReviewRef.current = null
      addMessage('user', text)
      setInputText('')
      addMessage('agent', `当前视频已经切换，刚才待确认的${pendingSemanticReview.decision.kind === 'media.rhythm-edit' ? '节拍剪辑' : pendingSemanticReview.decision.kind === 'media.visual-repair' ? '画面修复' : '语义剪辑'}方案已取消；请对当前视频重新说明。`)
      return true
    }
    if (pendingSemanticReview) {
      addMessage('user', text)
      setInputText('')
      if (/^(?:算了|取消|不执行|先不剪了)[吧。！!]*$/.test(text.trim())) {
        pendingSemanticReviewRef.current = null
        addMessage('agent', `好的，已取消这份${pendingSemanticReview.decision.kind === 'media.rhythm-edit' ? '节拍剪辑' : pendingSemanticReview.decision.kind === 'media.visual-repair' ? '画面修复' : '语义剪辑'}方案，没有创建任务，也没有改动文件。`)
        return true
      }
      if (!/^(?:确认(?:执行)?|执行|就按这个(?:方案)?|按这个方案执行)[吧。！!]*$/.test(text.trim())) {
        addMessage('agent', `这份${pendingSemanticReview.decision.kind === 'media.rhythm-edit' ? '节拍剪辑' : pendingSemanticReview.decision.kind === 'media.visual-repair' ? '画面修复' : '语义剪辑'}方案尚未执行。请回复“确认执行”或“取消”。`)
        return true
      }
      pendingSemanticReviewRef.current = null
      const reviewDecision = pendingSemanticReview.decision
      const reviewSegments = reviewDecision.timeline?.segments || []
      return runTrimTask(reviewDecision.instruction, {
        instruction: reviewDecision.instruction,
        sourcePath: pendingSemanticReview.sourcePath,
        startSeconds: Number(reviewDecision.timeline?.startSeconds || reviewSegments[0]?.sourceStartSeconds || 0),
        endSeconds: Number(reviewDecision.timeline?.endSeconds || reviewSegments.at(-1)?.sourceEndSeconds || 0),
        operation: reviewDecision.kind === 'media.rhythm-edit' ? 'rhythm' : reviewDecision.kind === 'media.visual-repair' ? 'repair' : reviewDecision.kind === 'media.concat-segments' ? 'concat' : 'trim',
        segments: reviewSegments.map((segment) => ({ startSeconds: segment.sourceStartSeconds, endSeconds: segment.sourceEndSeconds })),
        decision: reviewDecision
      })
    }
    const pendingClarification = override ? null : pendingEditClarificationRef.current
    if (pendingClarification && (!currentPath || !sameLocalPath(currentPath, pendingClarification.sourcePath))) {
      pendingEditClarificationRef.current = null
      addMessage('user', text)
      setInputText('')
      addMessage('agent', '当前视频已经切换，刚才未完成的剪辑追问已取消；请对当前视频重新说明。')
      return true
    }
    let sourcePath = pendingClarification?.sourcePath || currentPath
    if (!sourcePath || /^(https?|blob):/i.test(sourcePath) || !window.aiPlayer?.mediaTools?.planEdit) return false
    let startSeconds = override?.startSeconds || 0
    let endSeconds = override?.endSeconds || 0
    let operation: 'trim' | 'remove' | 'concat' | 'music' | 'audio-mix' | 'audio-repair' | 'rhythm' | 'effects' | 'reframe' | 'repair' | 'subtitle' | 'shift' | 'mux' | 'translate' | 'cue-edit' | 'transform' | 'layout' = override?.operation || 'trim'
    let segments = override?.segments || []
    let sourceCount = 0
    let semanticCut: MediaEditDecisionV1['semanticCut'] | undefined = override?.decision?.semanticCut
    let semanticLocate: MediaEditDecisionV1['semanticLocate'] | undefined = override?.decision?.semanticLocate
    let semanticSelect: MediaEditDecisionV1['semanticSelect'] | undefined = override?.decision?.semanticSelect
    let autoInspection: MediaEditDecisionV1['autoInspection'] | undefined = override?.decision?.autoInspection
    let visualEffects: MediaEditDecisionV1['effects'] | undefined = override?.decision?.effects
    let brandPackage: MediaEditDecisionV1['brandPackage'] | undefined = override?.decision?.brandPackage
    let smartReframe: MediaEditDecisionV1['reframe'] | undefined = override?.decision?.reframe
    let visualRepair: MediaEditDecisionV1['repair'] | undefined = override?.decision?.repair
    let rhythmEdit: MediaEditDecisionV1['rhythm'] | undefined = override?.decision?.rhythm
    let frozenDecision: MediaEditDecisionV1 | undefined = override?.decision
    let executionInstruction = text
    if (!override) {
      try {
        const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: text, sourcePath, ...(pendingClarification ? { clarificationId: pendingClarification.id } : {}) })
        if (pendingClarification && plan?.error) {
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', `[错误] ${plan.error}`)
          return true
        }
        if (plan?.cancelled) {
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', '好的，已取消这次剪辑，没有创建任务，也没有改动文件。')
          return true
        }
        if (plan?.clarification) {
          pendingEditClarificationRef.current = plan.clarification
          addMessage('user', text)
          setInputText('')
          addMessage('agent', plan.clarification.question)
          return true
        }
        if (plan?.versionPlan) {
          pendingLongVersionRef.current = { sourcePath, plan: plan.versionPlan }
          pendingEditClarificationRef.current = null
          addMessage('user', text); setInputText('')
          const variants = plan.versionPlan.variants.map((item) => `${item.label}（目标${item.targetSeconds}秒，计划${item.durationSeconds.toFixed(2)}秒）`).join('、')
          const chapters = plan.versionPlan.chapters.map((item) => `${item.label}（${item.sourceStartSeconds.toFixed(2)}–${item.sourceEndSeconds.toFixed(2)}秒）`).join('、')
          addMessage('agent', `长视频多版本方案已完成，尚未执行：\n内容摘要：${plan.versionPlan.summary}\n时长版本：${variants}\n章节版：${chapters}\n共享证据由 ${plan.versionPlan.model.providerName} · ${plan.versionPlan.model.model} 一次规划，后续不会为每个版本重复调用模型。\n请回复“确认执行”或“取消”。`)
          return true
        }
        if (plan?.review?.summary && !plan?.decision) {
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', plan.review.summary)
          return true
        }
        const decision = plan?.decision
        if (!plan?.matched || !decision || !['media.trim', 'media.remove-segment', 'media.concat-segments', 'media.add-music', 'media.mix-audio', 'media.repair-audio', 'media.rhythm-edit', 'media.visual-effects', 'media.smart-reframe', 'media.visual-repair', 'media.concat-sources', 'media.burn-subtitles', 'media.shift-subtitles', 'media.mux-subtitles', 'media.translate-subtitles', 'media.edit-subtitle-cues', 'media.transform-subtitles', 'media.subtitle-layout-variants'].includes(decision.kind)) {
          pendingEditClarificationRef.current = null
          return false
        }
        pendingEditClarificationRef.current = null
        frozenDecision = decision
        semanticCut = decision.semanticCut
        semanticLocate = decision.semanticLocate
        semanticSelect = decision.semanticSelect
        autoInspection = decision.autoInspection
        visualEffects = decision.effects
        brandPackage = decision.brandPackage
        smartReframe = decision.reframe
        visualRepair = decision.repair
        rhythmEdit = decision.rhythm
        if (decision.kind === 'media.smart-reframe' && decision.source?.path) sourcePath = decision.source.path
        if (rhythmEdit?.confirmationRequired) {
          pendingSemanticReviewRef.current = { sourcePath, decision }
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          addMessage('agent', `节拍剪辑方案已完成，尚未执行：\n真实节拍：${rhythmEdit.bpm.toFixed(1)} BPM，网格支持率 ${Math.round(rhythmEdit.supportRatio * 100)}%\n切镜：${rhythmEdit.segments.length} 个镜头（${rhythmEdit.pace === 'fast' ? '更快' : rhythmEdit.pace === 'restrained' ? '更克制' : '均衡'}）\n高潮：${rhythmEdit.highlight.startSeconds.toFixed(2)}–${rhythmEdit.highlight.endSeconds.toFixed(2)}秒，平均切镜间隔比普通段短 ${Math.round((1 - rhythmEdit.highlight.densityRatio) * 100)}%\n片尾：${rhythmEdit.tail.endBeatSeconds.toFixed(2)}秒强拍处，画面和声音同时淡出。\n原视频和音乐不会覆盖。请回复“确认执行”或“取消”。`)
          return true
        }
        if (visualRepair?.confirmationRequired) {
          pendingSemanticReviewRef.current = { sourcePath, decision }
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          const actions = [visualRepair.stabilize ? '防抖' : '', visualRepair.rotationDegrees ? `旋转 ${visualRepair.rotationDegrees}°` : '', visualRepair.autoColor ? '自动曝光/偏色校正' : ''].filter(Boolean).join('、')
          const findings = visualRepair.lowQualityFindings.map((item, index) => `${index + 1}. ${Number(item.startSeconds).toFixed(2)}–${Number(item.endSeconds).toFixed(2)}秒：${item.reason}`).join('\n')
          addMessage('agent', `画面修复方案已完成，尚未执行：\n修复动作：${actions}\n将另存修复版和处理前后对比版，原片不覆盖。${findings ? `\n低质量片段仅提示、不自动删除：\n${findings}` : '\n没有发现需要额外提示的低质量片段。'}\n请回复“确认执行”或“取消”。`)
          return true
        }
        if (autoInspection?.confirmationRequired) {
          pendingSemanticReviewRef.current = { sourcePath, decision }
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          const safe = autoInspection.safeRemovals.map((item, index) => `${index + 1}. ${item.startSeconds.toFixed(2)}–${item.endSeconds.toFixed(2)}秒：${item.reasons.join('；')}`).join('\n')
          const review = autoInspection.reviewOnly.map((item, index) => `${index + 1}. ${item.startSeconds?.toFixed(2) || '?'}–${item.endSeconds?.toFixed(2) || '?'}秒：${item.reason || item.text || item.kind}`).join('\n')
          addMessage('agent', `自动体检方案已完成，尚未执行：\n可安全批量处理 ${autoInspection.safeRemovals.length} 处：\n${safe}\n${autoInspection.reviewOnly.length ? `\n仅标记、不自动删除 ${autoInspection.reviewOnly.length} 处：\n${review}\n` : ''}预计压缩 ${autoInspection.totalRemovedSeconds.toFixed(2)} 秒。请回复“确认执行”或“取消”。`)
          return true
        }
        if (semanticSelect?.confirmationRequired) {
          pendingSemanticReviewRef.current = { sourcePath, decision }
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          const evidence = semanticSelect.evidence.map((item) => `第${item.cueIndex}条：“${item.quote}”`).join('\n')
          const ranges = semanticSelect.ranges.map((item) => `${item.sourceStartSeconds.toFixed(2)}–${item.sourceEndSeconds.toFixed(2)}秒`).join('、')
          addMessage('agent', `先给你核对保留主题“${semanticSelect.topic}”的方案，尚未执行：\n${evidence}\n将保留 ${semanticSelect.selectedCueIndexes.length} 条字幕证据，形成 ${semanticSelect.ranges.length} 个片段（${ranges}）。\n模型：${semanticSelect.model.providerName} · ${semanticSelect.model.model}；置信度 ${(semanticSelect.confidence * 100).toFixed(0)}%。\n请回复“确认执行”或“取消”。`)
          return true
        }
        if (semanticCut?.confirmationRequired) {
          pendingSemanticReviewRef.current = { sourcePath, decision }
          pendingEditClarificationRef.current = null
          addMessage('user', text)
          setInputText('')
          const removable = semanticCut.removed.map((item) => `第${item.cueIndex || '?'}条（${item.startSeconds.toFixed(2)}–${item.endSeconds.toFixed(2)}秒）“${item.text || ''}”：${item.reason}`).join('\n')
          const reviewOnly = semanticCut.reviewOnly?.length
            ? `\n另有 ${semanticCut.reviewOnly.length} 条句中疑似口头禅因没有逐词时间戳，只标记、不删除。`
            : ''
          const visualHint = semanticCut.visualEvidence
            ? `\n镜头交叉验证：${semanticCut.visualEvidence.safeCandidateIndexes.length} 个候选通过，${semanticCut.visualEvidence.blockedCandidateIndexes.length} 个因不安全或不确定被挡下；视觉模型 ${semanticCut.visualEvidence.model.providerName} · ${semanticCut.visualEvidence.model.model}。`
            : ''
          addMessage('agent', `先给你核对方案，尚未执行：\n${removable}${reviewOnly}${visualHint}\n请回复“确认执行”或“取消”。`)
          return true
        }
        executionInstruction = decision.instruction || text
        operation = decision.kind === 'media.rhythm-edit' ? 'rhythm' : decision.kind === 'media.repair-audio' ? 'audio-repair' : decision.kind === 'media.mix-audio' ? 'audio-mix' : decision.kind === 'media.add-music' ? 'music' : decision.kind === 'media.visual-repair' ? 'repair' : decision.kind === 'media.smart-reframe' ? 'reframe' : decision.kind === 'media.visual-effects' ? 'effects' : decision.kind === 'media.subtitle-layout-variants' ? 'layout' : decision.kind === 'media.transform-subtitles' ? 'transform' : decision.kind === 'media.burn-subtitles' ? 'subtitle' : decision.kind === 'media.mux-subtitles' ? 'mux' : decision.kind === 'media.translate-subtitles' ? 'translate' : decision.kind === 'media.edit-subtitle-cues' ? 'cue-edit' : decision.kind === 'media.shift-subtitles' ? 'shift' : decision.kind === 'media.remove-segment' ? 'remove' : decision.kind === 'media.concat-segments' || decision.kind === 'media.concat-sources' ? 'concat' : 'trim'
        startSeconds = Number(decision.timeline?.startSeconds || decision.timeline?.segments?.[0]?.sourceStartSeconds || 0)
        endSeconds = Number(decision.timeline?.endSeconds || decision.timeline?.segments?.at(-1)?.sourceEndSeconds || 0)
        segments = (decision.timeline?.segments || []).map((segment) => ({ startSeconds: segment.sourceStartSeconds, endSeconds: segment.sourceEndSeconds }))
        sourceCount = decision.kind === 'media.concat-sources' ? (decision.sources?.length || 0) : 0
      } catch (error) {
        if (/(?:多轨混音|环境声|氛围声|音效|提示音|对白闪避|分段音量|降噪|去直流|响度匹配|静音修复|分离人声|提取伴奏|按音乐节拍|卡点|踩点|高潮对齐|片尾自然收束)/.test(text)) {
          if (!override) { addMessage('user', text); setInputText('') }
          addMessage('agent', `[错误] 多轨音频规划失败：${error instanceof Error ? error.message : String(error)}`)
          return true
        }
        return false
      }
    }
    if (busyRef.current) return true
    const input: TrimInput = { instruction: executionInstruction, sourcePath, startSeconds, endSeconds, operation, segments, ...(frozenDecision ? { decision: frozenDecision } : {}) }
    trimInputRef.current = input
    busyRef.current = true
    if (!override) {
      addMessage('user', text)
      setInputText('')
    }
    const actionLabel = rhythmEdit ? `节拍剪辑 · ${rhythmEdit.bpm.toFixed(1)} BPM · ${rhythmEdit.pace === 'fast' ? '更快' : rhythmEdit.pace === 'restrained' ? '更克制' : '均衡'}` : visualRepair ? '画面防抖与质量修复' : smartReframe ? `生成三比例跟踪版 · ${smartReframe.subject.description}` : brandPackage ? `品牌包装 · ${brandPackage.template.label}` : visualEffects ? `应用视觉效果 ${visualEffects.length} 类` : autoInspection ? `执行自动体检方案 ${autoInspection.safeRemovals.length} 处` : semanticSelect ? `保留主题“${semanticSelect.topic}”` : semanticLocate ? `从原话“${semanticLocate.query}”开始` : semanticCut ? (semanticCut.target === 'long-pauses' ? `删除长停顿 ${semanticCut.removed.length} 处` : semanticCut.target === 'near-duplicate-and-offtopic' ? `删除语义重复/跑题 ${semanticCut.removed.length} 条` : `删除口头禅/重复句 ${semanticCut.removed.length} 条`) : operation === 'audio-repair' ? '专业音频修复与基础分离' : operation === 'audio-mix' ? `专业多轨混音 · ${frozenDecision?.audioMix?.tracks.length || 0} 条外部轨` : operation === 'music' ? '配乐（对白闪避）' : operation === 'effects' ? '应用专业画面效果' : operation === 'layout' ? '多比例字幕布局' : operation === 'transform' ? '批量字幕变换' : operation === 'subtitle' ? '烧录硬字幕' : operation === 'mux' ? '封装软字幕' : operation === 'translate' ? '翻译字幕' : operation === 'cue-edit' ? '字幕校对' : operation === 'shift' ? '字幕时间调移' : operation === 'concat' ? (sourceCount > 0 ? `按顺序合并 ${sourceCount} 个素材` : `按顺序拼接 ${segments.length} 个片段`) : operation === 'remove' ? `删除 ${startSeconds}–${endSeconds} 秒` : `保留 ${startSeconds}–${endSeconds} 秒`
    executionTaskIdRef.current = startTask({
      kind: 'media', label: actionLabel, phase: 'running',
      status: rhythmEdit ? `正在按真实 ${rhythmEdit.bpm.toFixed(1)} BPM 切镜；高潮区加密，片尾落强拍淡出…` : smartReframe ? `正在按5张冻结关键帧跟踪“${smartReframe.subject.description}”，依次生成16:9、9:16和1:1…` : brandPackage ? `正在按“${brandPackage.template.label}”渲染标题、章节条、人物条、角标和片尾，并逐区核验最终像素…` : visualEffects ? `正在渲染 ${visualEffects.map((item) => item.type).join('、')} 并做尺寸/时长/像素变化核验…` : autoInspection ? `正在按确认方案批量处理 ${autoInspection.safeRemovals.length} 个安全区间，并保留审阅项…` : semanticSelect ? `正在按字幕引用保留主题“${semanticSelect.topic}”并核验成片…` : semanticLocate ? `正在按${semanticLocate.wordTimingEvidence ? 'Whisper DTW逐词' : '字幕'}定位从第 ${semanticLocate.cueIndex} 条原话开始剪辑并核验成片…` : semanticCut ? (semanticCut.target === 'long-pauses' ? `正在按真实音轨证据删除 ${semanticCut.removed.length} 处长停顿并核验成片…` : semanticCut.target === 'near-duplicate-and-offtopic' ? `正在按你确认的模型引用证据删除 ${semanticCut.removed.length} 条语义重复或跑题内容并核验成片…` : `正在按真实字幕证据删除 ${semanticCut.removed.length} 条口头禅或重复句并核验成片…`) : operation === 'audio-mix' ? '正在对齐对白、音乐、环境声与音效，执行分段音量、对白闪避和最终总线复测…' : operation === 'music' ? '正在按音乐选段与循环策略混音，并做两遍响度归一和编码后复测…' : operation === 'layout' ? '正在为横屏、竖屏和方形多分辨率生成ASS，并核验字号、两行上限、断句、遮挡和位置…' : operation === 'transform' ? '正在按冻结原始序号批量改字、合并、精确拆分、调时、翻译和换风格，并逐项复核…' : operation === 'subtitle' ? '正在把字幕逐条烧录进画面并核验成品时长与音轨…' : operation === 'mux' ? '正在把字幕封装成可开关的软字幕轨（不重编码）并核验…' : operation === 'translate' ? '正在逐句翻译字幕并核对译文与条目数…' : operation === 'cue-edit' ? '正在按条目校订字幕并逐条复核…' : operation === 'shift' ? '正在按秒数平移整条字幕时间轴并逐条复核…' : operation === 'concat' ? (sourceCount > 0 ? '正在统一分辨率与音轨、按顺序拼接多个素材并核验成品…' : '正在按口述顺序重排片段、拼接连续音画并核验成片…') : operation === 'remove' ? '正在删除片段、重建连续音画时间线并核验成片…' : '正在按原画面比例精确剪辑，并核验成片…', instruction: executionInstruction, source: sourcePath,
      retry: { kind: 'trim', instruction: executionInstruction, sourcePath }
    })
    if (visualRepair) setTaskStatus('正在执行防抖/旋转/曝光偏色修复，并生成原版与修复版并排对比…')
    if (operation === 'audio-repair') setTaskStatus('正在降噪、去直流、修复短静音底噪并生成带伪影说明的基础人声/伴奏轨…')
    if (operation === 'rhythm') setTaskStatus('正在按冻结节拍生成跳切，核验高潮密度、音乐对齐和片尾画面/声音淡出…')
    const requestId = `trim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'trim'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer.mediaTools.trim({ sourcePath, instruction: executionInstruction, requestId, workspaceTaskId: executionTaskIdRef.current, ...(input.decision ? { decision: input.decision } : {}) })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '视频剪辑失败')
      const timeline = (result.timelineReceipt || []).map((item) => `${item.operation}：${operation === 'music' ? '音乐' : operation === 'audio-mix' || operation === 'audio-repair' || operation === 'rhythm' ? '音频' : '源片'} ${item.sourceRange}；成片 ${item.outputRange}`).join('\n')
      const summary = result.summary || (result.music
        ? `已生成配乐版新视频：音乐音量 ${Math.round((result.music.volume || 0.15) * 100)}%${result.music.duck ? '，人声自动压低音乐（对白闪避）' : ''}；原文件未改动`
        : `已生成 ${Number(result.durationSeconds || 0).toFixed(3)} 秒新视频；原文件未改动`)
      const capsule = result.projectCapsule
      const projectHint = capsule
        ? `\n编辑项目：第 ${capsule.cursor + 1}/${capsule.versionCount} 版；可直接说“撤销刚才的剪辑”。`
        : ''
      const completedOutputs = result.outputs?.length ? result.outputs : [result.outputPath]
      completeExecutionTask({ outputs: completedOutputs, summary })
      addMessage('agent', `${summary}${timeline ? `\n时间线：\n${timeline}` : ''}${projectHint}\n成果：${completedOutputs.join('\n')}`)
      if (isPlayableVideoPath(result.outputPath)) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: result.outputPath }))
      return true
    } catch (error) {
      if (executionWasCancelled()) return true
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
      return true
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runAudioMixAttachmentTask = async (text: string): Promise<boolean> => {
    const sourcePath = usePlayerStore.getState().videoSrc
    const audioFiles = attachments.filter((file) => AUDIO_FILE_EXTENSIONS.has(file.ext) && file.previewPath)
    const rhythmRequested = /(?:按(?:音乐)?节拍|卡点|踩点|高潮对齐|片尾自然收束)/.test(text)
    if (!sourcePath || /^(https?|blob):/i.test(sourcePath) || !audioFiles.length || !window.aiPlayer?.mediaTools?.planEdit || (!rhythmRequested && !/(?:多轨混音|环境声|氛围声|音效|提示音|对白闪避|分段音量)/.test(text))) return false
    if (rhythmRequested) {
      const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: `${text}；音乐 ${audioFiles[0].previewPath}`, sourcePath })
      if (!plan?.matched || plan.decision?.kind !== 'media.rhythm-edit' || !plan.decision.rhythm) {
        addMessage('user', text); setInputText('')
        addMessage('agent', `[错误] ${plan?.error || plan?.review?.summary || '无法从这段音乐形成可验证的节拍剪辑方案'}`)
        return true
      }
      pendingSemanticReviewRef.current = { sourcePath, decision: plan.decision }
      addMessage('user', text); setInputText('')
      addMessage('agent', `${plan.review?.summary || '节拍剪辑方案已完成，尚未执行。'}\n原视频和音乐不会覆盖。请回复“确认执行”或“取消”。`)
      return true
    }
    const roles = [...text.matchAll(/背景音乐|配乐|音乐|环境声|氛围声|音效|提示音/g)].map((match) => /环境声|氛围声/.test(match[0]) ? '环境声' : /音效|提示音/.test(match[0]) ? '音效' : '背景音乐')
    if (roles.length < audioFiles.length) {
      addMessage('user', text)
      setInputText('')
      addMessage('agent', `已收到 ${audioFiles.length} 个音频。请按附件顺序告诉我用途，例如“第1个是背景音乐，第2个是环境声，第3个是音效”；我不会根据文件名猜。`)
      return true
    }
    const enriched = `${text}；${audioFiles.map((file, index) => `${roles[index]} ${file.previewPath}`).join('；')}`
    try {
      const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: enriched, sourcePath })
      if (!plan?.matched || plan.decision?.kind !== 'media.mix-audio') throw new Error(plan?.error || '音频用途仍不明确，请按附件顺序分别说明背景音乐、环境声或音效。')
      addMessage('user', text)
      setInputText('')
      const decision = plan.decision
      return runTrimTask(decision.instruction, { instruction: decision.instruction, sourcePath, startSeconds: 0, endSeconds: 0, operation: 'audio-mix', decision })
    } catch (error) {
      addMessage('user', text)
      setInputText('')
      addMessage('agent', `[错误] ${error instanceof Error ? error.message : String(error)}`)
      return true
    }
  }

  const runCompressTask = async (text: string, override?: CompressInput) => {
    if (!text || busyRef.current) return
    const sourcePath = override?.sourcePath || usePlayerStore.getState().videoSrc
    if (!sourcePath || /^(https?|blob):/i.test(sourcePath)) {
      addMessage('agent', '压缩/转码只支持本地视频文件；请先用「打开」选一个本地视频')
      return
    }
    const mode = override?.mode || (/转码|转成 ?mp4|转换为 ?mp4/.test(text) ? 'remux' : 'compress')
    const targetMb = mode === 'remux' ? 0 : override?.targetMb ?? Math.max(5, Math.min(500, Number(/(\d+)\s*(?:MB|mb|兆)/.exec(text)?.[1]) || 25))
    const input: CompressInput = { instruction: text, sourcePath, targetMb, mode }
    compressInputRef.current = input
    busyRef.current = true
    if (!override) {
      addMessage('user', text)
      setInputText('')
    }
    executionTaskIdRef.current = startTask({
      kind: 'media', label: mode === 'remux' ? '转码为 MP4' : `压缩到 ${targetMb}MB`, phase: 'running',
      status: mode === 'remux' ? '正在转封装（不重编码，秒级）…' : '正在压缩（时长越久越慢）…',
      instruction: text, source: sourcePath,
      retry: { kind: 'compress', instruction: text, sourcePath, targetMb, mode }
    })
    const requestId = `compress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    pendingTaskRef.current = 'compress'
    bindCancelableRequest(requestId)
    try {
      const result = await window.aiPlayer?.mediaTools?.compress({ sourcePath, targetMb, mode, requestId, workspaceTaskId: executionTaskIdRef.current })
      if (!result?.success || !result.outputPath) throw new Error(result?.error || '处理失败')
      const before = ((result.beforeBytes || 0) / 1024 / 1024).toFixed(1)
      const after = ((result.afterBytes || 0) / 1024 / 1024).toFixed(1)
      completeExecutionTask({ outputs: [result.outputPath], summary: '任务已完成' })
      addMessage('agent', `${mode === 'remux' ? '转码' : '压缩'}完成：${before}MB → ${after}MB，已另存为 ${result.outputPath}（原文件未动）`)
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
    }
  }

  const runDedupTask = async (instruction: string, retrying = false, directoryPath = '') => {
    if (!instruction || busyRef.current) return
    busyRef.current = true
    dedupInstructionRef.current = instruction
    pendingTaskRef.current = 'dedup'
    const requestId = crypto.randomUUID()
    executionTaskIdRef.current = startTask({ kind: 'utility', label: '重复文件检查', instruction, retry: { kind: 'dedup', instruction, directoryPath } })
    bindCancelableRequest(requestId)
    if (!retrying) {
      addMessage('user', instruction)
      setInputText('')
    }
    setTaskBusy(true)
    setTaskStatus('正在扫描媒体库找重复文件')
    setTaskOutputs([])
    try {
      const result = await window.aiPlayer?.media?.dedup({ requestId, workspaceTaskId: executionTaskIdRef.current, ...(directoryPath ? { directoryPath } : {}) })
      if (!result) throw new Error('桌面端重复文件扫描不可用')
      if (result.cancelled || executionWasCancelled()) return
      if (!result.success) throw new Error(result.error || '重复文件扫描失败')
      const results = result.duplicates
      if (!results.length) {
        addMessage('agent', '没有发现内容重复的文件 ✓')
        completeExecutionTask({ summary: `已扫描 ${result.filesScanned} 个媒体文件，没有发现内容重复` })
      } else {
        const lines = results.slice(0, 10).map((item, index) => `${index + 1}. ${item.name}`).join('\n')
        const more = results.length > 10 ? `\n…共 ${results.length} 组` : ''
        addMessage('agent', `发现 ${results.length} 组内容重复（下面是重复副本，点开可直接查看）：\n${lines}${more}`)
        completeExecutionTask({ outputs: results.slice(0, 5).map((item) => item.duplicate), summary: `发现 ${results.length} 组内容重复` })
      }
    } catch (error) {
      if (executionWasCancelled()) return
      const message = error instanceof Error ? error.message : String(error)
      failExecutionTask(message)
      addMessage('agent', `[错误] ${message}`)
    } finally {
      releaseCancelableRequest(requestId)
      busyRef.current = false
      setTaskBusy(false)
      setTaskStatus('')
    }
  }

  useEffect(() => {
    const onAgentMediaTask = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; value?: { targetMb?: number; mode?: 'compress' | 'remux'; startSeconds?: number; endSeconds?: number; segments?: Array<{ startSeconds: number; endSeconds: number }>; direction?: 'undo' | 'redo' } }>).detail || {}
      if (detail.action === 'start_batch_transcribe') {
        void runBatchTask('全部转写')
        return
      }
      if (detail.action === 'start_compress_video') {
        const mode = detail.value?.mode === 'remux' ? 'remux' : 'compress'
        const targetMb = Math.max(5, Number(detail.value?.targetMb) || 25)
        void runCompressTask(mode === 'remux' ? '转码成 mp4' : `压缩到 ${targetMb}MB`)
        return
      }
      if (detail.action === 'start_trim_video') {
        const startSeconds = Math.max(0, Number(detail.value?.startSeconds) || 0)
        const endSeconds = Math.max(0, Number(detail.value?.endSeconds) || 0)
        void runTrimTask(`保留第${startSeconds}秒到第${endSeconds}秒`)
        return
      }
      if (detail.action === 'start_remove_video_segment') {
        const startSeconds = Math.max(0, Number(detail.value?.startSeconds) || 0)
        const endSeconds = Math.max(0, Number(detail.value?.endSeconds) || 0)
        void runTrimTask(`删除第${startSeconds}秒到第${endSeconds}秒`)
        return
      }
      if (detail.action === 'start_concat_video_segments') {
        const segments = (detail.value?.segments || []).filter((segment) => Number.isFinite(segment.startSeconds) && Number.isFinite(segment.endSeconds) && segment.startSeconds >= 0 && segment.endSeconds > segment.startSeconds)
        if (segments.length >= 2) void runTrimTask(`按顺序拼接${segments.map((segment) => `第${segment.startSeconds}秒到第${segment.endSeconds}秒`).join('和')}`)
        return
      }
      if (detail.action === 'start_edit_history') {
        void runEditHistoryTask(detail.value?.direction === 'redo' ? '重做刚才撤销的剪辑' : '撤销刚才的剪辑')
        return
      }
      if (detail.action === 'start_duplicate_scan') void runDedupTask('重复文件检查')
    }
    window.addEventListener('ai-player-agent-media-task', onAgentMediaTask)
    return () => window.removeEventListener('ai-player-agent-media-task', onAgentMediaTask)
  })

  const isVideoGenerationIntent = (text: string) => VIDEO_GENERATION_INTENT.test(text) && Boolean(window.aiPlayer?.studio?.generateVideo)

  const retryActiveTask = () => {
    switch (pendingTaskRef.current) {
      case 'recut':
        if (!recutInputRef.current) return false
        void runRecutShort(recutInputRef.current, true)
        return true
      case 'video-gen':
        if (!videoGenInstructionRef.current) return false
        void runVideoGenTask(videoGenInstructionRef.current, true)
        return true
      case 'batch':
        if (!batchInputRef.current.instruction || !batchInputRef.current.targets.length) return false
        void runBatchTask(batchInputRef.current.instruction, batchInputRef.current.targets)
        return true
      case 'compress':
        if (!compressInputRef.current.sourcePath) return false
        void runCompressTask(compressInputRef.current.instruction, compressInputRef.current)
        return true
      case 'trim':
        if (!trimInputRef.current.sourcePath) return false
        void runTrimTask(trimInputRef.current.instruction, trimInputRef.current)
        return true
      case 'versions':
        if (!versionBundleInputRef.current) return false
        void runVersionBundleTask(versionBundleInputRef.current)
        return true
      case 'dedup':
        if (!dedupInstructionRef.current) return false
        void runDedupTask(dedupInstructionRef.current, true)
        return true
      default:
        return false
    }
  }

  const retryStoredTask = (retry: WorkspaceTaskRetry) => {
    if (retry.kind === 'trim' && retry.sourcePath && retry.instruction) {
      const planAndRetry = async () => {
        const plan = await window.aiPlayer?.mediaTools?.planEdit({ instruction: retry.instruction || '', sourcePath: retry.sourcePath || '' })
        const decision = plan?.decision
        if (!plan?.matched || !decision || !['media.trim', 'media.remove-segment', 'media.concat-segments', 'media.add-music', 'media.mix-audio', 'media.repair-audio', 'media.rhythm-edit', 'media.visual-effects', 'media.smart-reframe', 'media.visual-repair', 'media.concat-sources', 'media.burn-subtitles', 'media.shift-subtitles', 'media.mux-subtitles', 'media.translate-subtitles', 'media.edit-subtitle-cues', 'media.transform-subtitles', 'media.subtitle-layout-variants'].includes(decision.kind)) {
          addMessage('agent', '[错误] 原剪辑指令已无法还原成唯一时间线，请从原视频重新说明要保留、删除或按顺序拼接的时间段。')
          return
        }
        void runTrimTask(retry.instruction || '', {
          instruction: retry.instruction || '', sourcePath: retry.sourcePath || '',
          startSeconds: Number(decision.timeline?.startSeconds || decision.timeline?.segments?.[0]?.sourceStartSeconds || 0),
          endSeconds: Number(decision.timeline?.endSeconds || decision.timeline?.segments?.at(-1)?.sourceEndSeconds || 0),
          operation: decision.kind === 'media.rhythm-edit' ? 'rhythm' : decision.kind === 'media.repair-audio' ? 'audio-repair' : decision.kind === 'media.mix-audio' ? 'audio-mix' : decision.kind === 'media.add-music' ? 'music' : decision.kind === 'media.visual-effects' ? 'effects' : decision.kind === 'media.subtitle-layout-variants' ? 'layout' : decision.kind === 'media.transform-subtitles' ? 'transform' : decision.kind === 'media.burn-subtitles' ? 'subtitle' : decision.kind === 'media.mux-subtitles' ? 'mux' : decision.kind === 'media.translate-subtitles' ? 'translate' : decision.kind === 'media.edit-subtitle-cues' ? 'cue-edit' : decision.kind === 'media.shift-subtitles' ? 'shift' : decision.kind === 'media.remove-segment' ? 'remove' : decision.kind === 'media.concat-segments' || decision.kind === 'media.concat-sources' ? 'concat' : 'trim',
          segments: (decision.timeline?.segments || []).map((segment) => ({ startSeconds: segment.sourceStartSeconds, endSeconds: segment.sourceEndSeconds })),
          decision
        })
      }
      void planAndRetry()
      return true
    }
    if (retry.kind === 'versions' && retry.sourcePath && retry.instruction) {
      usePlayerStore.getState().setMedia(retry.sourcePath.split(/[\\/]/).pop() || '待处理视频', retry.sourcePath)
      void runTrimTask(retry.instruction)
      return true
    }
    if (retry.kind === 'compress' && retry.sourcePath) {
      usePlayerStore.getState().setMedia(retry.sourcePath.split(/[\\/]/).pop() || '待处理视频', retry.sourcePath)
      const mode = retry.mode || 'compress'
      const instruction = retry.instruction || (mode === 'remux' ? '转码成 mp4' : `压到 ${retry.targetMb || 25}MB`)
      void runCompressTask(instruction, { instruction, sourcePath: retry.sourcePath, targetMb: retry.targetMb || (mode === 'remux' ? 0 : 25), mode })
      return true
    }
    if (retry.kind === 'video-gen' && retry.instruction) {
      void runVideoGenTask(retry.instruction, true)
      return true
    }
    if (retry.kind === 'dedup') {
      void runDedupTask(retry.instruction || '重复文件检查', true, retry.directoryPath || '')
      return true
    }
    return false
  }

  return {
    isVideoGenerationIntent,
    runRecutShort,
    runVideoGenTask,
    runBatchTask,
    runEditHistoryTask,
    runTrimTask,
    runAudioMixAttachmentTask,
    runCompressTask,
    runDedupTask,
    retryActiveTask,
    retryStoredTask
  }
}
