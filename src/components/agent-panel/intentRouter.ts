import { usePlayerStore } from '../../stores/playerStore'
import { buildLinkChoice } from '../../link-choice-policy.mjs'
import type { LinkChoice } from '../../link-choice-policy.mjs'
import { canDispatchAgentTask } from '../../../electron/agent-runtime-policy.mjs'
import type { AgentMode } from '../../../electron/agent-runtime-policy.mjs'
import type { AgentAttachment } from './types'

type IntentRouterOptions = {
  inputText: string
  attachments: AgentAttachment[]
  agentMode: AgentMode
  addMessage: (role: 'user' | 'agent', text: string) => void
  setInputText: (value: string) => void
  setLinkChoice: (choice: LinkChoice | null) => void
  isVideoGenerationIntent: (text: string) => boolean
  runBatchTask: (text: string) => Promise<void>
  runVideoGenTask: (text: string) => Promise<void>
  runCompressTask: (text: string) => Promise<void>
  runDedupTask: (text: string) => Promise<void>
  runDocumentTask: () => Promise<void>
  setAnalysisFormat: (format: string) => void
  runAnalysisTask: () => Promise<void>
  send: (contextNote?: string) => Promise<void>
}

const BATCH_SCOPE_INTENT = /全部|批量|每个|逐一|一起/
const BATCH_ACTION_INTENT = /压缩|转写/
const COMPRESS_INTENT = /压缩|压到|视频太大|转码|转成 ?mp4|转换为 ?mp4/
const DEDUP_INTENT = /^去重|重复文件|查重/
const LIBRARY_INTENTS: Array<[RegExp, string, string]> = [
  [/屏幕录制|开始录制|录屏/, 'record', '已打开屏幕录制（在媒体库页操作）'],
  [/整理建议|整理素材|素材整理/, 'organize', '正在生成素材整理建议'],
  [/^插件|^插件管理/, 'plugins', '已打开插件列表'],
  [/海报刮削|刮削海报|海报信息/, 'poster', '正在刮削海报信息']
]

export function createIntentRouter(options: IntentRouterOptions) {
  const {
    inputText, attachments, agentMode, addMessage, setInputText, setLinkChoice,
    isVideoGenerationIntent, runBatchTask, runVideoGenTask,
    runCompressTask, runDedupTask, runDocumentTask, setAnalysisFormat,
    runAnalysisTask, send
  } = options

  return async function routeTextSend(textOverride?: string) {
    const text = (textOverride ?? inputText).trim()
    const { videoSrc } = usePlayerStore.getState()
    if (!canDispatchAgentTask(agentMode)) {
      const context = [
        attachments.length > 0 ? `已附加文件：${attachments.map((file) => file.name).join('、')}` : '',
        videoSrc ? `当前媒体：${videoSrc}` : ''
      ].filter(Boolean).join('\n')
      await send(context)
      return
    }
    if (attachments.length > 0 && BATCH_SCOPE_INTENT.test(text) && BATCH_ACTION_INTENT.test(text) && window.aiPlayer?.mediaBatch) {
      await runBatchTask(text)
      return
    }
    if (attachments.length > 0) {
      await runDocumentTask()
      return
    }
    if (isVideoGenerationIntent(text)) {
      await runVideoGenTask(text)
      return
    }
    if (videoSrc && window.aiPlayer?.mediaTools && COMPRESS_INTENT.test(text)) {
      await runCompressTask(text)
      return
    }
    if (DEDUP_INTENT.test(text)) {
      await runDedupTask(text)
      return
    }
    const libraryHit = LIBRARY_INTENTS.find(([pattern]) => pattern.test(text))
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
          addMessage('user', text)
          setInputText('')
          setLinkChoice(buildLinkChoice(detection, text))
          return
        }
      } catch { /* 链接检测失败时继续当前视频分析 */ }
    }
    if (text && videoSrc && !/^(https?|blob):/i.test(videoSrc) && window.aiPlayer?.analysis) {
      try {
        const detection = await window.aiPlayer.analysis.detect(text)
        if (detection?.matched) {
          setAnalysisFormat(detection.outputFormat)
          await runAnalysisTask()
          return
        }
      } catch { /* 视频检测失败时退回普通对话 */ }
    }
    void send()
  }
}
