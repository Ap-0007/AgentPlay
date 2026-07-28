// 对话流视频深度解剖（拉片收编）：意图识别、输出格式推断、解剖提示词与报告组装。
// 执行入口 runChatAnalysis 复用 analysis-studio-service 的证据读取与离线结构稿，
// 报告落盘复用 DocumentWorkspaceService.writeGenerated/recordHistory，原文件不被改动。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { getType } = require('./file-service')
const { buildOfflineAnalysis, formatTime, loadAnalysisContext } = require('./analysis-studio-service')

const ANALYSIS_INTENT = /(拉片|深度解剖|解剖(这个|这段|当前|这部|该|一下)?视频|视频解剖|镜头分析|逐镜|拆解(这个|这段|当前|这部|该)?视频|视频分析|分析(这个|这段|当前|这部|该)?视频|analy[sz]e (this )?video|video analysis|shot breakdown)/i

function detectAnalysisIntent(text) {
  return ANALYSIS_INTENT.test(String(text || ''))
}

function resolveAnalysisOutput(instruction) {
  const text = String(instruction || '')
  if (/pdf/i.test(text)) return 'pdf'
  if (/pptx?|演示稿|幻灯片/i.test(text)) return 'pptx'
  if (/markdown|\bmd\b/i.test(text)) return 'md'
  if (/txt|纯文本/i.test(text)) return 'txt'
  return 'docx'
}

const DEEP_ANALYSIS_SYSTEM = '你是 AgentPlay 的视频拉片与深度解剖助手。只能依据用户提供的字幕正文与离线结构底稿作答，没有画面证据时必须明说“缺少画面证据”，不得编造未出现的镜头、表演或数据。输出结构化中文 Markdown，结论要具体、可执行。'

// 多模态拉片：画面关键帧（标注 t=MM:SS）与字幕同为一手证据，镜头/构图/节奏只看画面
const DEEP_ANALYSIS_VISION_SYSTEM = '你是 AgentPlay 的视频拉片与深度解剖助手。用户会给你按时间顺序排列的视频关键帧（每张标注 t=MM:SS）与口播字幕，两者都是一手证据：镜头、构图、节奏只能依据画面，台词与观点只能依据字幕，两者冲突以画面为准，不得编造未出现的镜头、表演或数据。输出结构化中文 Markdown，结论要具体、可执行。'

function buildDeepAnalysisPrompt({ mediaName, duration, instruction, offlineDraft, transcript }) {
  const systemPrompt = DEEP_ANALYSIS_SYSTEM
  const prompt = [
    `视频：《${mediaName || '当前视频'}》（时长 ${formatTime(duration)}）`,
    instruction ? `用户的解剖要求：${String(instruction).slice(0, 500)}` : '用户的解剖要求：做一次完整的深度解剖。',
    '',
    '离线结构底稿（由字幕与统计线索生成）：',
    offlineDraft.slice(0, 12000),
    '',
    `字幕正文（共若干条，截断保留前 20000 字）：`,
    transcript ? transcript.slice(0, 20000) : '（无字幕证据）',
    '',
    '请输出以下章节的 Markdown 报告：',
    '## 叙事结构（开端钩子/推进/高潮/结尾行动点，引用字幕原句做证据）',
    '## 内容与信息密度（哪些段落信息重复或可压缩）',
    '## 镜头与节奏（仅在字幕能推断时下结论，否则明说缺少画面证据）',
    '## 传播钩子与受众（开头 15 秒是否抓人，适合什么平台与受众）',
    '## 缺陷清单与二次创作建议（逐条可执行）'
  ].join('\n')
  return { systemPrompt, prompt }
}

function buildVisionAnalysisPrompt({ mediaName, duration, instruction, offlineDraft, transcript, frameCount }) {
  const systemPrompt = DEEP_ANALYSIS_VISION_SYSTEM
  const prompt = [
    `视频：《${mediaName || '当前视频'}》（时长 ${formatTime(duration)}）`,
    `画面证据：随附 ${frameCount} 张关键帧（镜头切换感知抽取、已去重），每张标注拍摄时间点 t=MM:SS。`,
    instruction ? `用户的解剖要求：${String(instruction).slice(0, 500)}` : '用户的解剖要求：做一次完整的拉片拆解。',
    '',
    '离线结构底稿（字幕统计线索，仅供对照）：',
    offlineDraft.slice(0, 8000),
    '',
    '口播字幕正文（截断保留前 15000 字）：',
    transcript ? transcript.slice(0, 15000) : '（无字幕证据）',
    '',
    '请输出以下章节的 Markdown 报告：',
    '## 一句话定位（这是什么内容、为谁服务、靠什么留人）',
    '## 钩子拆解（0-3 秒画面与第一句台词如何抓人，引用画面与字幕证据）',
    '## 镜头与节奏（镜头数量与切换密度、景别与构图、节奏快慢变化，引用 t=MM:SS）',
    '## 结构时间轴（按 t=MM:SS 划分段落：钩子/推进/高潮/行动点）',
    '## 口播文案要点（核心观点与金句，引用字幕原句）',
    '## 营销话术剥离（哪些是套路化表达，真正的信息增量是什么）',
    '## 可复用套路与二次创作建议（逐条可执行）'
  ].join('\n')
  return { systemPrompt, prompt }
}

function buildAnalysisReport({ mediaName, duration, cueCount, frameCount = 0, provider, model, aiText, offlineDraft, visionNote = '' }) {
  const name = mediaName || '当前视频'
  const lines = [
    `# 《${name}》深度解剖报告`,
    '',
    '## 证据范围',
    `- 时长：${formatTime(duration)}；字幕证据：${cueCount} 条${frameCount ? `；画面证据：关键帧 ${frameCount} 张（标注 t=MM:SS）` : ''}。`,
    aiText
      ? `- 分析方式：${frameCount ? '多模态拉片（画面关键帧＋字幕）' : '云端/本地模型深度解剖'}（${provider || '已配置模型'}${model ? ` / ${model}` : ''}）＋离线结构底稿。`
      : '- 分析方式：离线结构底稿（未配置模型；配置模型后可升级为 AI 深度解剖）。',
    frameCount
      ? '- 画面结论仅依据随附关键帧，未抽取的片段不做编造。'
      : '- 本报告只依据字幕与统计线索，未观察的画面不做编造。'
  ]
  if (visionNote) lines.push(`- 画面降级说明：${visionNote}`)
  lines.push('')
  if (aiText) {
    lines.push('## AI 深度解剖', '', aiText.trim(), '', '---', '', '## 附录：离线结构底稿', '', offlineDraft)
  } else {
    lines.push('## 离线结构底稿', '', offlineDraft)
  }
  return lines.join('\n')
}

function assertAnalyzableVideo(sourcePath) {
  const value = String(sourcePath || '')
  if (!value || /^(https?|blob):/i.test(value)) throw new Error('当前没有可解剖的本地视频（网络流和在线播放源不支持）')
  if (!fs.existsSync(value)) throw new Error('视频文件不存在或已被移动')
  if (getType(path.extname(value).toLowerCase()) !== 'video') throw new Error('当前文件不是可解剖的视频')
  return path.resolve(value)
}

// 对话流一键解剖：读取字幕证据 → 离线结构稿 →（可选）模型深度解剖 → 报告另存。
// model = { configured, local, provider, model }；complete = llmComplete；workspace = DocumentWorkspaceService。
async function runChatAnalysis({
  sourcePath, mediaName, duration, instruction = '', outputFormat = 'auto',
  cloudApproved = false, signal, onStatus = () => {}, workspace, complete, completeVisionMulti, frames, model = {}
}) {
  const resolved = assertAnalyzableVideo(sourcePath)
  const format = outputFormat && outputFormat !== 'auto' ? outputFormat : resolveAnalysisOutput(instruction)
  const displayName = mediaName || path.basename(resolved)
  onStatus('正在读取字幕与上下文')
  const context = loadAnalysisContext(resolved)
  const offlineDraft = buildOfflineAnalysis({ mediaName: displayName, duration, markers: [], cues: context.cues })
  let aiText = ''
  let frameCount = 0
  let visionNote = ''
  if (model.configured) {
    if (!model.local && cloudApproved !== true) {
      return { success: false, requiresApproval: true, cueCount: context.cues.length }
    }
    // 多模态拉片：抽关键帧随字幕一起给视觉模型；模型不收图片则如实降级为纯文本解剖
    if (!model.local && frames && completeVisionMulti) {
      onStatus('正在抽取关键画面帧')
      let shots = []
      try {
        shots = await frames.extract({ sourcePath: resolved, durationSec: duration, outDir: path.join(os.tmpdir(), `agentplay-frames-${Date.now()}`) })
      } catch { shots = [] }
      if (shots.length) {
        onStatus(`AI 正在观看 ${shots.length} 张关键画面并拆解…`)
        try {
          const images = shots.map((shot) => ({
            label: shot.label,
            dataUrl: `data:image/jpeg;base64,${fs.readFileSync(shot.path).toString('base64')}`
          }))
          const { systemPrompt, prompt } = buildVisionAnalysisPrompt({
            mediaName: displayName, duration, instruction, offlineDraft,
            transcript: context.transcript, frameCount: shots.length
          })
          const result = await completeVisionMulti({ systemPrompt, prompt, images, signal })
          aiText = result.text
          frameCount = shots.length
        } catch (error) {
          const message = String(error?.message || '')
          // 只有"模型能力上不收图"才降级纯文本；超时/网络错误直接抛出，不再白等一轮
          if (/multimodal|does not support|unsupported.*(image|vision|media| modality)|invalid.*(image|image_url|content)|image.*(unsupported|invalid|not supported)|(不支持|不接受).{0,4}(图|图片|图像|多模态)/i.test(message)) {
            visionNote = '当前模型不支持图片输入，本次仅基于字幕与结构线索（想看画面：到模型接入中心换视觉模型，如 doubao-vision 系列）'
            onStatus(`${visionNote}，退回纯文本解剖`)
          } else {
            throw error
          }
        } finally {
          try { fs.rmSync(path.dirname(shots[0].path), { recursive: true, force: true }) } catch { /* 忽略 */ }
        }
      }
    }
    if (!aiText) {
      onStatus('AI 正在结合字幕证据做深度解剖…')
      const { systemPrompt, prompt } = buildDeepAnalysisPrompt({
        mediaName: displayName, duration, instruction, offlineDraft, transcript: context.transcript
      })
      const result = await complete({ systemPrompt, prompt, signal })
      aiText = result.text
    }
  }
  onStatus('正在写出解剖报告')
  const summary = aiText
    ? frameCount
      ? `已完成《${displayName}》多模态拉片（${frameCount} 张关键帧 + ${context.cues.length} 条字幕证据）`
      : `已完成《${displayName}》AI 深度解剖（${context.cues.length} 条字幕证据）${visionNote ? `；${visionNote}` : ''}`
    : `已生成《${displayName}》离线解剖结构稿（${context.cues.length} 条字幕证据；配置模型可升级为 AI 解剖）`
  const plan = {
    kind: 'video-analysis', instruction, summary, outputFormat: format,
    files: [{ name: displayName, path: resolved, ext: path.extname(resolved).toLowerCase() }]
  }
  const aiPlan = {
    title: `${displayName}·深度解剖`, summary, outputFormat: format,
    content: buildAnalysisReport({
      mediaName: displayName, duration, cueCount: context.cues.length, frameCount,
      provider: model.provider, model: model.model, aiText, offlineDraft, visionNote
    }),
    slides: [], sheets: []
  }
  const written = await workspace.writeGenerated(plan, aiPlan)
  const historyId = workspace.recordHistory(plan, written)
  return { success: true, outputs: written.outputs, summary, historyId, usedAi: Boolean(aiText), cueCount: context.cues.length, frameCount, visionNote }
}

module.exports = {
  DEEP_ANALYSIS_SYSTEM,
  DEEP_ANALYSIS_VISION_SYSTEM,
  buildAnalysisReport,
  buildDeepAnalysisPrompt,
  buildVisionAnalysisPrompt,
  detectAnalysisIntent,
  resolveAnalysisOutput,
  runChatAnalysis
}
