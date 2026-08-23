const path = require('path')

const PAUSE_EDIT_PATTERN = /(?:删除|删掉|剪掉|去掉|移除|自动剪掉)[^，。；]{0,12}(?:长)?(?:停顿|静音)|(?:长)?(?:停顿|静音)[^，。；]{0,12}(?:删除|删掉|剪掉|去掉|移除)/
const TEXT_CLEANUP_PATTERN = /(?:删除|删掉|剪掉|去掉|移除)[^，。；]{0,12}(?:口头禅|废话|重复(?:的话|内容|句子)?)|(?:口头禅|废话|重复(?:的话|内容|句子)?)[^，。；]{0,12}(?:删除|删掉|剪掉|去掉|移除)/
const SEMANTIC_REVIEW_PATTERN = /(?:跑题|偏题|离题)|(?:(?:意思|语义)[^，。；]{0,6}(?:重复|相似|差不多))|(?:(?:重复|相似)[^，。；]{0,6}(?:意思|语义))|(?:内容[^，。；]{0,6}(?:相似|雷同))|(?:(?:相似|雷同)[^，。；]{0,6}内容)/
const FILLER_ONLY_PATTERN = /^(?:嗯+|呃+|额+|啊+|那个|这个|就是|然后|怎么说|你知道吧|对吧|是吧)$/i
const EMBEDDED_FILLER_PATTERN = /(?:^|[\s，,、。！？!?；;：:])((?:嗯+|呃+|额+|啊+|那个|这个|就是|然后|怎么说|你知道吧|对吧|是吧))(?=$|[\s，,、。！？!?；;：:])/gi
const DEFAULT_MIN_SILENCE_SECONDS = 0.9
const DEFAULT_KEEP_PADDING_SECONDS = 0.12
const MAX_RETAINED_SEGMENTS = 24

function portableBasename(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || ''
}

function matchesPauseEditInstruction(instruction) {
  return PAUSE_EDIT_PATTERN.test(String(instruction || ''))
}

function matchesTextCleanupInstruction(instruction) {
  return TEXT_CLEANUP_PATTERN.test(String(instruction || ''))
}

function matchesSemanticReviewInstruction(instruction) {
  const text = String(instruction || '')
  return SEMANTIC_REVIEW_PATTERN.test(text) && /删除|删掉|剪掉|去掉|移除|找出|检查|审阅|分析/.test(text)
}

function normalizedCueText(text) {
  return String(text || '').toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—-]+/g, '')
}

function standaloneFiller(text) {
  return FILLER_ONLY_PATTERN.test(normalizedCueText(text))
}

function embeddedFillers(text) {
  if (standaloneFiller(text)) return []
  return [...String(text || '').matchAll(EMBEDDED_FILLER_PATTERN)].map((match) => match[1]).filter(Boolean)
}

function requestedMinimumSilence(instruction) {
  const text = String(instruction || '')
  const direct = /(?:超过|大于|至少|长于|持续)?\s*(\d+(?:\.\d+)?)\s*秒(?:以上)?(?:的)?(?:长)?(?:停顿|静音)/.exec(text)
    || /(?:长)?(?:停顿|静音)[^\d]{0,8}(\d+(?:\.\d+)?)\s*秒/.exec(text)
  return Math.max(0.5, Math.min(5, Number(direct?.[1]) || DEFAULT_MIN_SILENCE_SECONDS))
}

function parseSilenceEvents(stderr) {
  const events = []
  let openStart = null
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (start) openStart = Math.max(0, Number(start[1]))
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)(?:\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?))?/.exec(line)
    if (!end) continue
    const endSeconds = Math.max(0, Number(end[1]))
    const duration = Number(end[2])
    const startSeconds = Number.isFinite(openStart) ? openStart : Number.isFinite(duration) ? Math.max(0, endSeconds - duration) : NaN
    if (Number.isFinite(startSeconds) && endSeconds > startSeconds) {
      events.push({
        startSeconds: Number(startSeconds.toFixed(3)),
        endSeconds: Number(endSeconds.toFixed(3)),
        durationSeconds: Number((endSeconds - startSeconds).toFixed(3))
      })
    }
    openStart = null
  }
  return events
}

function mergeRanges(ranges) {
  const merged = []
  for (const range of ranges.sort((a, b) => a.startSeconds - b.startSeconds)) {
    const previous = merged.at(-1)
    if (previous && range.startSeconds <= previous.endSeconds + 0.03) {
      previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds)
      previous.durationSeconds = Number((previous.endSeconds - previous.startSeconds).toFixed(3))
    } else merged.push({ ...range })
  }
  return merged
}

function buildPauseRemovalDecision({ instruction, sourcePath, durationSeconds, silences, minimumSilenceSeconds, keepPaddingSeconds = DEFAULT_KEEP_PADDING_SECONDS } = {}) {
  const duration = Number(durationSeconds)
  const minimum = Number(minimumSilenceSeconds) || DEFAULT_MIN_SILENCE_SECONDS
  const padding = Math.max(0.05, Math.min(0.3, Number(keepPaddingSeconds) || DEFAULT_KEEP_PADDING_SECONDS))
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，不能生成去停顿方案')
  const detected = (Array.isArray(silences) ? silences : []).filter((item) => Number(item.durationSeconds) + 0.02 >= minimum)
  const removed = mergeRanges(detected.map((item) => ({
    startSeconds: Number((Number(item.startSeconds) + padding).toFixed(3)),
    endSeconds: Number((Number(item.endSeconds) - padding).toFixed(3)),
    reason: `长停顿 ${Number(item.durationSeconds).toFixed(2)} 秒`,
    detectedRange: { startSeconds: Number(item.startSeconds), endSeconds: Number(item.endSeconds) }
  })).filter((item) => item.endSeconds - item.startSeconds >= 0.1 && item.detectedRange.startSeconds > 0.05 && item.detectedRange.endSeconds < duration - 0.05).map((item) => ({
    ...item, durationSeconds: Number((item.endSeconds - item.startSeconds).toFixed(3))
  })))
  if (!removed.length) throw new Error(`没有检测到片中超过 ${minimum.toFixed(1)} 秒、可安全删除的长停顿`)

  const retained = []
  let cursor = 0
  for (const range of removed) {
    if (range.startSeconds - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: range.startSeconds })
    cursor = range.endSeconds
  }
  if (duration - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: duration })
  if (retained.length < 2) throw new Error('去停顿后没有形成可安全拼接的多个保留片段')
  if (retained.length > MAX_RETAINED_SEGMENTS) throw new Error(`检测到 ${removed.length} 处长停顿，超过单次安全处理上限；请提高停顿秒数或分段处理`)

  let targetCursor = 0
  const segments = retained.map((item) => {
    const segmentDuration = item.sourceEndSeconds - item.sourceStartSeconds
    const segment = {
      sourceStartSeconds: Number(item.sourceStartSeconds.toFixed(3)),
      sourceEndSeconds: Number(item.sourceEndSeconds.toFixed(3)),
      durationSeconds: Number(segmentDuration.toFixed(3)),
      targetStartSeconds: Number(targetCursor.toFixed(3)),
      targetEndSeconds: Number((targetCursor + segmentDuration).toFixed(3))
    }
    targetCursor += segmentDuration
    return segment
  })
  const totalRemovedSeconds = Number(removed.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3))
  return {
    schemaVersion: 1,
    kind: 'media.concat-segments',
    instruction: String(instruction || '').trim(),
    source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    timeline: { segments, durationSeconds: Number(targetCursor.toFixed(3)) },
    semanticCut: {
      schemaVersion: 1,
      strategy: 'audio-silencedetect-v1',
      target: 'long-pauses',
      minimumSilenceSeconds: minimum,
      keepPaddingSeconds: padding,
      sourceDurationSeconds: Number(duration.toFixed(3)),
      detected,
      removed,
      totalRemovedSeconds
    },
    output: { container: 'mp4', overwrite: false, suffix: '去停顿版' },
    verification: {
      toleranceSeconds: 0.25,
      semanticEvidence: { strategy: 'audio-silencedetect-v1', removedCount: removed.length, totalRemovedSeconds }
    }
  }
}

function analyzeTextCleanupCues(cues, durationSeconds) {
  const duration = Number(durationSeconds)
  const normalized = (Array.isArray(cues) ? cues : []).map((cue, index) => ({
    cueIndex: index + 1,
    startSeconds: Number(cue.startSeconds ?? cue.start),
    endSeconds: Number(cue.endSeconds ?? cue.end),
    text: String(cue.text || '').trim()
  })).filter((cue) => Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds) && cue.startSeconds >= 0 && cue.endSeconds > cue.startSeconds && cue.endSeconds <= duration + 0.25 && cue.text)
  const detected = []
  const reviewOnly = []
  const firstSeen = new Map()
  for (const cue of normalized) {
    const normalizedText = normalizedCueText(cue.text)
    if (standaloneFiller(cue.text) && cue.endSeconds - cue.startSeconds <= 2.5) {
      detected.push({ ...cue, reason: '独立口头禅', normalizedText })
      continue
    }
    const matches = embeddedFillers(cue.text)
    if (matches.length) reviewOnly.push({ ...cue, reason: '句中疑似口头禅', matches: [...new Set(matches)] })
    if (normalizedText.length < 4) continue
    const previous = firstSeen.get(normalizedText)
    if (!previous) {
      firstSeen.set(normalizedText, { ...cue, normalizedText })
      continue
    }
    const adjacent = cue.startSeconds - previous.endSeconds <= 3
    detected.push({
      ...cue,
      reason: adjacent ? `相邻重复第${previous.cueIndex}条` : `非紧邻完全重复第${previous.cueIndex}条`,
      normalizedText
    })
  }
  return { normalized, detected, reviewOnly }
}

function textCleanupReviewSummary(reviewOnly) {
  const lines = reviewOnly.slice(0, 8).map((item) => `第${item.cueIndex}条（${item.startSeconds.toFixed(2)}–${item.endSeconds.toFixed(2)}秒）“${item.text}”：${item.reason}“${item.matches.join('、')}”`)
  return `已定位 ${reviewOnly.length} 条需要人工核对的字幕：\n${lines.join('\n')}\n这些字幕没有逐词时间戳，AgentPlay 不会删除整句；请先生成逐词字幕或给出明确时间段。`
}

function buildSemanticModelDecision({ instruction, sourcePath, durationSeconds, subtitlePath, cues, review } = {}) {
  const duration = Number(durationSeconds)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，不能生成语义审阅剪辑方案')
  const normalized = analyzeTextCleanupCues(cues, duration).normalized
  const byIndex = new Map(normalized.map((cue) => [cue.cueIndex, cue]))
  const removeByIndex = new Map()
  for (const candidate of review?.candidates || []) {
    for (const cueIndex of candidate.removeCueIndexes || []) {
      const cue = byIndex.get(cueIndex)
      if (!cue) continue
      const previous = removeByIndex.get(cueIndex)
      if (!previous || candidate.confidence > previous.confidence) removeByIndex.set(cueIndex, { cue, candidate })
    }
  }
  const removed = mergeRanges([...removeByIndex.values()].map(({ cue, candidate }) => ({
    startSeconds: Number((cue.startSeconds + 0.04).toFixed(3)), endSeconds: Number((cue.endSeconds - 0.04).toFixed(3)),
    durationSeconds: Number(Math.max(0, cue.endSeconds - cue.startSeconds - 0.08).toFixed(3)), cueIndex: cue.cueIndex, text: cue.text,
    reason: `${candidate.type === 'near_duplicate' ? '语义近似重复' : '疑似跑题'}：${candidate.reason}`,
    candidateType: candidate.type, confidence: candidate.confidence, evidence: candidate.evidence
  })).filter((item) => item.durationSeconds >= 0.1 && item.startSeconds > 0.05 && item.endSeconds < duration - 0.05))
  if (!removed.length) throw new Error('模型没有给出可安全整段删除的中间字幕候选')
  const retained = []
  let cursor = 0
  for (const range of removed) { if (range.startSeconds - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: range.startSeconds }); cursor = range.endSeconds }
  if (duration - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: duration })
  if (retained.length < 2 || retained.length > MAX_RETAINED_SEGMENTS) throw new Error('语义审阅后的保留片段超出单次安全拼接范围')
  let targetCursor = 0
  const segments = retained.map((item) => { const segmentDuration = item.sourceEndSeconds - item.sourceStartSeconds; const segment = { sourceStartSeconds: Number(item.sourceStartSeconds.toFixed(3)), sourceEndSeconds: Number(item.sourceEndSeconds.toFixed(3)), durationSeconds: Number(segmentDuration.toFixed(3)), targetStartSeconds: Number(targetCursor.toFixed(3)), targetEndSeconds: Number((targetCursor + segmentDuration).toFixed(3)) }; targetCursor += segmentDuration; return segment })
  const totalRemovedSeconds = Number(removed.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3))
  const modelEvidence = { topicSummary: review.topicSummary, model: review.model, candidates: review.allCandidates || review.candidates }
  const visualEvidence = review.visualEvidence
  return {
    schemaVersion: 1, kind: 'media.concat-segments', instruction: String(instruction || '').trim(), source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    timeline: { segments, durationSeconds: Number(targetCursor.toFixed(3)) },
    semanticCut: { schemaVersion: 1, strategy: 'model-semantic-review-v1', target: 'near-duplicate-and-offtopic', subtitlePath: String(subtitlePath || ''), sourceDurationSeconds: Number(duration.toFixed(3)), detected: review.candidates, removed, reviewOnly: [], confirmationRequired: true, modelEvidence, visualEvidence, totalRemovedSeconds },
    output: { container: 'mp4', overwrite: false, suffix: '语义精简版' },
    verification: { toleranceSeconds: 0.25, semanticEvidence: { strategy: 'model-semantic-review-v1', removedCount: removed.length, totalRemovedSeconds, modelEvidence, visualEvidence } }
  }
}

function buildTextCleanupDecision({ instruction, sourcePath, durationSeconds, subtitlePath, cues, analysis: suppliedAnalysis } = {}) {
  const duration = Number(durationSeconds)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，不能生成字幕语义剪辑方案')
  const analysis = suppliedAnalysis || analyzeTextCleanupCues(cues, duration)
  const { normalized, detected, reviewOnly } = analysis
  if (!normalized.length) throw new Error('字幕里没有可定位的有效时间轴条目')
  const removed = mergeRanges(detected.map((cue) => ({
    startSeconds: Number(((Number.isFinite(cue.preciseStartSeconds) ? cue.preciseStartSeconds : cue.startSeconds) + (Number.isFinite(cue.preciseStartSeconds) ? 0.02 : 0.04)).toFixed(3)),
    endSeconds: Number(((Number.isFinite(cue.preciseEndSeconds) ? cue.preciseEndSeconds : cue.endSeconds) - (Number.isFinite(cue.preciseEndSeconds) ? 0.02 : 0.04)).toFixed(3)),
    durationSeconds: Number(Math.max(0, (Number.isFinite(cue.preciseEndSeconds) ? cue.preciseEndSeconds : cue.endSeconds) - (Number.isFinite(cue.preciseStartSeconds) ? cue.preciseStartSeconds : cue.startSeconds) - (Number.isFinite(cue.preciseStartSeconds) ? 0.04 : 0.08)).toFixed(3)),
    cueIndex: cue.cueIndex,
    text: cue.text,
    reason: cue.reason,
    ...(cue.timingMethod ? { timingMethod: cue.timingMethod, timingConfidence: cue.timingConfidence, model: cue.model, match: cue.match } : {})
  })).filter((item) => item.durationSeconds >= 0.1 && item.startSeconds > 0.05 && item.endSeconds < duration - 0.05))
  if (!removed.length) throw new Error('字幕中没有检测到可安全整段删除的独立口头禅或相邻重复句')

  const retained = []
  let cursor = 0
  for (const range of removed) {
    if (range.startSeconds - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: range.startSeconds })
    cursor = range.endSeconds
  }
  if (duration - cursor >= 0.08) retained.push({ sourceStartSeconds: cursor, sourceEndSeconds: duration })
  if (retained.length < 2 || retained.length > MAX_RETAINED_SEGMENTS) throw new Error('字幕清理后的保留片段超出单次安全拼接范围')
  let targetCursor = 0
  const segments = retained.map((item) => {
    const segmentDuration = item.sourceEndSeconds - item.sourceStartSeconds
    const segment = {
      sourceStartSeconds: Number(item.sourceStartSeconds.toFixed(3)), sourceEndSeconds: Number(item.sourceEndSeconds.toFixed(3)),
      durationSeconds: Number(segmentDuration.toFixed(3)), targetStartSeconds: Number(targetCursor.toFixed(3)), targetEndSeconds: Number((targetCursor + segmentDuration).toFixed(3))
    }
    targetCursor += segmentDuration
    return segment
  })
  const totalRemovedSeconds = Number(removed.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3))
  const confirmationRequired = detected.some((item) => item.reason.startsWith('非紧邻完全重复') || item.reason.startsWith('逐词对齐口头禅'))
  const wordTimingEvidence = detected.filter((item) => item.timingMethod).map((item) => ({
    cueIndex: item.cueIndex, text: item.text, match: item.match,
    startSeconds: item.preciseStartSeconds, endSeconds: item.preciseEndSeconds,
    confidence: item.timingConfidence, method: item.timingMethod, model: item.model
  }))
  return {
    schemaVersion: 1, kind: 'media.concat-segments', instruction: String(instruction || '').trim(),
    source: { path: String(sourcePath || '').trim(), name: portableBasename(sourcePath) },
    timeline: { segments, durationSeconds: Number(targetCursor.toFixed(3)) },
    semanticCut: {
      schemaVersion: 1, strategy: 'subtitle-cue-cleanup-v1', target: 'filler-and-adjacent-repeat',
      subtitlePath: String(subtitlePath || ''), sourceDurationSeconds: Number(duration.toFixed(3)), detected, removed, reviewOnly,
      confirmationRequired, wordTimingEvidence, totalRemovedSeconds
    },
    output: { container: 'mp4', overwrite: false, suffix: '去口头禅重复版' },
    verification: {
      toleranceSeconds: 0.25,
      semanticEvidence: {
        strategy: 'subtitle-cue-cleanup-v1', removedCount: removed.length, totalRemovedSeconds,
        wordTimingEvidence: wordTimingEvidence.map((item) => ({ cueIndex: item.cueIndex, match: item.match, startSeconds: item.startSeconds, endSeconds: item.endSeconds, confidence: item.confidence, method: item.method, model: item.model }))
      }
    }
  }
}

class SemanticEditService {
  constructor({ frames, loadTranscript = null, loadWordTimings = null, analyzeSemanticCues = null, analyzeVisualCandidates = null } = {}) { this.frames = frames; this.loadTranscript = loadTranscript; this.loadWordTimings = loadWordTimings; this.analyzeSemanticCues = analyzeSemanticCues; this.analyzeVisualCandidates = analyzeVisualCandidates }

  setSemanticAnalyzer(analyzeSemanticCues) { this.analyzeSemanticCues = analyzeSemanticCues }
  setVisualAnalyzer(analyzeVisualCandidates) { this.analyzeVisualCandidates = analyzeVisualCandidates }

  matches(instruction) { return matchesPauseEditInstruction(instruction) || matchesTextCleanupInstruction(instruction) || matchesSemanticReviewInstruction(instruction) }

  async plan({ instruction, sourcePath, signal } = {}) {
    if (!this.matches(instruction)) return { matched: false }
    if (!this.frames?.availability?.().available) throw new Error('缺少 ffmpeg 组件，无法分析音轨停顿')
    if (matchesSemanticReviewInstruction(instruction)) {
      const transcript = await this.loadTranscript?.(sourcePath)
      if (!transcript?.path || !Array.isArray(transcript.cues) || transcript.cues.length < 2) throw new Error('没有找到足够的带时间轴字幕，请先生成字幕后再检查语义重复或跑题')
      const durationSeconds = await this.frames.probeDuration(sourcePath, { signal })
      if (!this.analyzeSemanticCues) return { matched: true, review: { kind: 'semantic-model-review', summary: '当前没有可用的语义审阅模型，没有创建剪辑任务。请先在模型接入中心连接工作模型。', candidates: [] } }
      try {
        const review = await this.analyzeSemanticCues({ cues: analyzeTextCleanupCues(transcript.cues, durationSeconds).normalized, signal })
        if (!review?.available) return { matched: true, review: { kind: 'semantic-model-review', summary: `${review?.reason || '当前没有可用的语义审阅模型'}；没有创建剪辑任务。`, candidates: [] } }
        if (!review.candidates?.length) return { matched: true, review: { kind: 'semantic-model-review', summary: `工作模型围绕“${review.topicSummary}”完成审阅，没有找到置信度达到0.85且引用有效的语义重复或跑题候选；没有创建剪辑任务。`, candidates: [] } }
        if (!this.analyzeVisualCandidates) return { matched: true, review: { kind: 'semantic-model-review', summary: '语义候选已经生成，但没有可用的镜头证据交叉验证；没有创建剪辑任务。', candidates: review.candidates } }
        const visual = await this.analyzeVisualCandidates({ sourcePath, cues: analyzeTextCleanupCues(transcript.cues, durationSeconds).normalized, review, durationSeconds, signal })
        if (!visual?.available) return { matched: true, review: { kind: 'semantic-model-review', summary: `${visual?.reason || '镜头证据交叉验证不可用'}；没有创建剪辑任务。`, candidates: review.candidates } }
        const safeIndexes = new Set(visual.safeCandidateIndexes || [])
        const safeCandidates = review.candidates.filter((_, index) => safeIndexes.has(index + 1))
        if (!safeCandidates.length) return { matched: true, review: { kind: 'semantic-model-review', summary: `字幕模型提出${review.candidates.length}个候选，但镜头交叉验证全部判为不安全或不确定；没有创建剪辑任务。`, candidates: review.candidates } }
        const verifiedReview = { ...review, allCandidates: review.candidates, candidates: safeCandidates, visualEvidence: visual }
        return { matched: true, decision: buildSemanticModelDecision({ instruction, sourcePath, durationSeconds, subtitlePath: transcript.path, cues: transcript.cues, review: verifiedReview }) }
      } catch (error) {
        if (signal?.aborted || error?.message === '已取消') throw error
        return { matched: true, review: { kind: 'semantic-model-review', summary: `模型候选未通过证据校验：${error instanceof Error ? error.message : String(error)}；没有创建剪辑任务。`, candidates: [] } }
      }
    }
    if (matchesTextCleanupInstruction(instruction)) {
      const transcript = await this.loadTranscript?.(sourcePath)
      if (!transcript?.path || !Array.isArray(transcript.cues) || !transcript.cues.length) throw new Error('没有找到带时间轴的现成字幕，请先生成字幕后再删除口头禅或重复句')
      const durationSeconds = await this.frames.probeDuration(sourcePath, { signal })
      let analysis = analyzeTextCleanupCues(transcript.cues, durationSeconds)
      if (analysis.reviewOnly.length && this.loadWordTimings) {
        const wordTiming = await this.loadWordTimings(sourcePath, analysis.reviewOnly, { signal })
        const resolved = (wordTiming?.resolved || []).map((item) => ({ ...item, reason: `逐词对齐口头禅“${item.match}”` }))
        analysis = { ...analysis, detected: [...analysis.detected, ...resolved], reviewOnly: wordTiming?.unresolved || analysis.reviewOnly }
      }
      if (!analysis.detected.length && analysis.reviewOnly.length) {
        return { matched: true, review: { kind: 'semantic-text-review', summary: textCleanupReviewSummary(analysis.reviewOnly), candidates: analysis.reviewOnly } }
      }
      return { matched: true, decision: buildTextCleanupDecision({ instruction, sourcePath, durationSeconds, subtitlePath: transcript.path, cues: transcript.cues, analysis }) }
    }
    if (!await this.frames.probeHasAudio(sourcePath, { signal })) throw new Error('这个视频没有可分析的音轨，无法检测停顿')
    const durationSeconds = await this.frames.probeDuration(sourcePath, { signal })
    const minimumSilenceSeconds = requestedMinimumSilence(instruction)
    const result = await this.frames.run([
      '-hide_banner', '-nostats', '-i', sourcePath, '-map', '0:a:0',
      '-af', `silencedetect=noise=-35dB:d=${minimumSilenceSeconds.toFixed(3)}`,
      '-f', 'null', '-'
    ], { timeoutMs: Math.max(120000, Math.min(10 * 60 * 1000, Number(durationSeconds) * 500)), signal })
    const decision = buildPauseRemovalDecision({
      instruction, sourcePath, durationSeconds,
      silences: parseSilenceEvents(result.stderr), minimumSilenceSeconds
    })
    return { matched: true, decision }
  }
}

module.exports = {
  SemanticEditService, analyzeTextCleanupCues, buildPauseRemovalDecision, buildSemanticModelDecision, buildTextCleanupDecision, embeddedFillers,
  matchesPauseEditInstruction, matchesSemanticReviewInstruction, matchesTextCleanupInstruction, normalizedCueText,
  parseSilenceEvents, requestedMinimumSilence, standaloneFiller
}
