const fs = require('node:fs')
const path = require('node:path')
const { parseSrt, parseSrtTimestamp } = require('./subtitle-bilingual-service')

const STOP_WORDS = new Set(['我们', '你们', '他们', '这个', '那个', '就是', '然后', '现在', '今天', '一个', '可以', '还是', 'the', 'and', 'that', 'this', 'with', 'from'])
const SPEAKER_COLOURS = ['&H00FFFFFF', '&H00FFF0A8', '&H00B7FFD8', '&H00D7C2FF']

function bounded(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number(value) || 0)) }
function rounded(value, digits = 4) { return Number(Number(value).toFixed(digits)) }
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—\-（）()【】\[\]{}\\/]+/g, '') }

function acousticWindowEmbedding(buffer, sampleRate = 8000) {
  const samples = Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (samples < 320) return { pitchHz: 0, pitchConfidence: 0, zeroCrossingRate: 0, rms: 0 }
  const values = new Float64Array(samples)
  let power = 0; let crossings = 0
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768
    values[index] = value; power += value * value
    if (index && (value >= 0) !== (values[index - 1] >= 0)) crossings += 1
  }
  const rms = Math.sqrt(power / samples)
  let bestLag = 0; let bestCorrelation = 0; const correlations = []
  const minimumLag = Math.max(2, Math.floor(sampleRate / 380)); const maximumLag = Math.min(samples / 3, Math.ceil(sampleRate / 75))
  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let dot = 0; let leftPower = 0; let rightPower = 0
    for (let index = 0; index < samples - lag; index += 2) {
      const left = values[index]; const right = values[index + lag]
      dot += left * right; leftPower += left * left; rightPower += right * right
    }
    const correlation = leftPower > 0 && rightPower > 0 ? dot / Math.sqrt(leftPower * rightPower) : 0
    correlations.push({ lag, correlation })
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag }
  }
  const fundamental = correlations.find((item) => item.correlation >= Math.max(0.15, bestCorrelation * 0.98))
  if (fundamental) bestLag = fundamental.lag
  return {
    pitchHz: bestLag ? rounded(sampleRate / bestLag, 2) : 0,
    pitchConfidence: rounded(Math.max(0, bestCorrelation)),
    zeroCrossingRate: rounded(crossings / Math.max(1, samples - 1)),
    rms: rounded(rms, 6)
  }
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function acousticEmbedding(buffer, sampleRate = 8000) {
  const samples = Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (samples < 320) return { pitchHz: 0, pitchConfidence: 0, zeroCrossingRate: 0, rms: 0 }
  const windowSamples = Math.min(samples, Math.max(640, Math.round(sampleRate * 0.32)))
  const hopSamples = Math.max(320, Math.floor(windowSamples / 2))
  const windows = []
  for (let start = 0; start + windowSamples <= samples; start += hopSamples) windows.push(acousticWindowEmbedding(buffer.subarray(start * 2, (start + windowSamples) * 2), sampleRate))
  if (!windows.length) windows.push(acousticWindowEmbedding(buffer, sampleRate))
  const maximumRms = Math.max(...windows.map((item) => item.rms))
  const voiced = windows.filter((item) => item.pitchHz > 0 && item.pitchConfidence >= 0.15 && item.rms >= Math.max(0.001, maximumRms * 0.35))
  if (!voiced.length) return acousticWindowEmbedding(buffer, sampleRate)
  return {
    pitchHz: rounded(median(voiced.map((item) => item.pitchHz)), 2),
    pitchConfidence: rounded(median(voiced.map((item) => item.pitchConfidence))),
    zeroCrossingRate: rounded(median(voiced.map((item) => item.zeroCrossingRate))),
    rms: rounded(median(voiced.map((item) => item.rms)), 6)
  }
}

function speakerDistance(left, right) {
  if (!(left?.pitchHz > 0) || !(right?.pitchHz > 0)) return 1
  const pitch = Math.abs(Math.log2(left.pitchHz / right.pitchHz))
  const zcr = Math.abs(Number(left.zeroCrossingRate) - Number(right.zeroCrossingRate)) * 2
  return pitch * 0.7 + zcr * 0.3
}

function clusterSpeakers(embeddings, { maximumSpeakers = 4, distanceThreshold = 0.18 } = {}) {
  const values = Array.isArray(embeddings) ? embeddings : []
  if (!values.length) throw new Error('没有可用于说话人聚类的音频证据')
  const clusters = []
  const assignments = []
  const cueDistances = []
  for (const embedding of values) {
    let nearest = -1; let nearestDistance = Infinity
    clusters.forEach((cluster, index) => {
      const distance = speakerDistance(embedding, cluster.centroid)
      if (distance < nearestDistance) { nearest = index; nearestDistance = distance }
    })
    if (nearest < 0 || (nearestDistance > distanceThreshold && clusters.length < maximumSpeakers)) {
      clusters.push({ members: [embedding], centroid: { ...embedding } })
      assignments.push(clusters.length - 1); cueDistances.push(0)
      continue
    }
    const cluster = clusters[nearest]; cluster.members.push(embedding)
    const fields = ['pitchHz', 'pitchConfidence', 'zeroCrossingRate', 'rms']
    cluster.centroid = Object.fromEntries(fields.map((field) => [field, cluster.members.reduce((sum, item) => sum + Number(item[field] || 0), 0) / cluster.members.length]))
    assignments.push(nearest); cueDistances.push(nearestDistance)
  }
  // 一个孤立标签夹在同一说话人的两个相邻字幕之间时，优先保持连续说话轮次。
  for (let index = 1; index < assignments.length - 1; index += 1) {
    if (assignments[index - 1] === assignments[index + 1] && assignments[index] !== assignments[index - 1] && clusters[assignments[index]].members.length === 1) assignments[index] = assignments[index - 1]
  }
  const used = [...new Set(assignments)]
  const remap = new Map(used.map((value, index) => [value, index]))
  const normalizedAssignments = assignments.map((value) => remap.get(value))
  const confidence = values.length === 1 ? 1 : 1 - cueDistances.reduce((sum, value) => sum + Math.min(distanceThreshold, value), 0) / (values.length * distanceThreshold)
  return {
    speakerCount: used.length,
    assignments: normalizedAssignments,
    confidence: rounded(bounded(confidence, 0, 1)),
    anonymousLabels: true,
    method: 'decoded-pcm-acoustic-cluster-v1',
    cues: values.map((embedding, index) => ({ cueIndex: index + 1, speakerIndex: normalizedAssignments[index], pitchHz: embedding.pitchHz, pitchConfidence: embedding.pitchConfidence, zeroCrossingRate: embedding.zeroCrossingRate, rms: embedding.rms }))
  }
}

function bandComplexity(frame, zone) {
  if (!Buffer.isBuffer(frame) || frame.length < 32 * 32) return null
  const start = zone === 'top' ? 2 : 22; const end = zone === 'top' ? 10 : 30
  let total = 0; let count = 0
  for (let y = start; y < end; y += 1) for (let x = 1; x < 32; x += 1) {
    total += Math.abs(frame[y * 32 + x] - frame[y * 32 + x - 1]); count += 1
  }
  return count ? total / count / 255 : 0
}

function bandDifference(left, right, zone) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length < 32 * 32 || right.length < 32 * 32) return 0
  const start = zone === 'top' ? 2 : 22; const end = zone === 'top' ? 10 : 30
  let total = 0; let count = 0
  for (let y = start; y < end; y += 1) for (let x = 0; x < 32; x += 1) { total += Math.abs(left[y * 32 + x] - right[y * 32 + x]); count += 1 }
  return count ? total / count / 255 : 0
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor((centiseconds % 360000) / 6000)
  const secs = Math.floor((centiseconds % 6000) / 100)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

function escapeAssText(value) {
  return String(value || '').replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N')
}

function buildAssDocument({ dimensions, safeArea, cues }) {
  const width = Math.max(320, Number(dimensions?.width) || 1920); const height = Math.max(180, Number(dimensions?.height) || 1080)
  const fontSize = Math.max(24, Math.round(height * 0.055)); const outline = Math.max(2, Math.round(fontSize * 0.09)); const alignment = safeArea.chosenZone === 'top' ? 8 : 2
  const marginV = Math.max(24, Math.round(Number(safeArea.marginV) || height * 0.12)); const marginH = Math.max(24, Math.round(width * 0.08))
  const styles = SPEAKER_COLOURS.map((colour, index) => `Style: Speaker${index + 1},Microsoft YaHei,${fontSize},${colour},&H0000D7FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${outline},1,${alignment},${marginH},${marginH},${marginV},1`).join('\n')
  const dialogues = cues.map((cue) => {
    const style = `Speaker${Number(cue.speakerIndex) + 1}`
    let cursor = Number(cue.startSeconds); let body = `【${escapeAssText(cue.speakerLabel)}】 `
    cue.words.forEach((word, index) => {
      const gap = Math.max(0, Number(word.startSeconds) - cursor)
      if (gap >= 0.01) body += `{\\k${Math.max(1, Math.round(gap * 100))}}\u00a0`
      const duration = Math.max(1, Math.round((Number(word.endSeconds) - Number(word.startSeconds)) * 100))
      const separator = index > 0 && /[A-Za-z0-9]$/.test(String(cue.words[index - 1].text)) && /^[A-Za-z0-9]/.test(String(word.text)) ? '\u00a0' : ''
      body += separator
      if (word.keyword) body += `{\\1c&H004DFFFF&\\b1\\kf${duration}}${escapeAssText(word.text)}{\\r${style}}`
      else body += `{\\kf${duration}}${escapeAssText(word.text)}`
      cursor = Number(word.endSeconds)
    })
    return `Dialogue: 0,${assTime(cue.startSeconds)},${assTime(cue.endSeconds)},${style},,0,0,0,,${body}`
  }).join('\n')
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${styles}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues}\n`
}

function keywordTerms(explicit, words) {
  const chosen = (Array.isArray(explicit) ? explicit : []).map(normalizeText).filter(Boolean)
  if (chosen.length) return [...new Set(chosen)].slice(0, 8)
  const counts = new Map()
  for (const word of words) {
    const value = normalizeText(word.text)
    if (value.length < 2 || STOP_WORDS.has(value)) continue
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] * b[0].length - a[1] * a[0].length || a[0].localeCompare(b[0])).slice(0, 6).map(([value]) => value)
}

class ProfessionalSubtitleService {
  constructor({ frames, transcription, fsImpl = fs } = {}) {
    if (!frames || !transcription) throw new Error('专业动态字幕缺少音视频或逐词转写服务')
    this.frames = frames; this.transcription = transcription; this.fs = fsImpl
  }

  async safeAreaPlan(source, cues, dimensions, signal) {
    const samples = []
    for (const cue of cues.slice(0, 12)) {
      const seconds = (cue.startSeconds + cue.endSeconds) / 2
      const frame = await this.frames.readGrayFrame(source, seconds, { signal })
      const top = bandComplexity(frame, 'top'); const bottom = bandComplexity(frame, 'bottom')
      if (top == null || bottom == null) throw new Error('字幕安全区画面证据不可用')
      samples.push({ cueIndex: cue.index, seconds: rounded(seconds, 3), topComplexity: rounded(top), bottomComplexity: rounded(bottom) })
    }
    if (!samples.length) throw new Error('字幕安全区没有可采样的字幕时刻')
    const topScore = samples.reduce((sum, item) => sum + item.topComplexity, 0) / samples.length
    const bottomScore = samples.reduce((sum, item) => sum + item.bottomComplexity, 0) / samples.length
    const chosenZone = topScore + 0.02 < bottomScore ? 'top' : 'bottom'
    const verticalRatio = Number(dimensions.height) > Number(dimensions.width) ? 0.18 : 0.12
    return { schemaVersion: 1, strategy: 'frame-band-complexity-v1', chosenZone, marginV: Math.max(24, Math.round(dimensions.height * verticalRatio)), topComplexity: rounded(topScore), bottomComplexity: rounded(bottomScore), sampledFrames: samples }
  }

  async prepare({ sourcePath, subtitlePath, outputAssPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const subtitle = path.resolve(String(subtitlePath || ''))
    const professional = decision?.subtitle?.professional
    if (professional?.enabled !== true || professional.strategy !== 'acoustic-speaker-karaoke-v1') throw new Error('专业动态字幕决策无效')
    if (path.extname(subtitle).toLowerCase() !== '.srt') throw new Error('专业动态字幕当前需要标准SRT字幕，以便核验真实逐词时间')
    const entries = parseSrt(this.fs.readFileSync(subtitle, 'utf8')).map((entry) => ({ ...entry, startSeconds: parseSrtTimestamp(entry.start), endSeconds: parseSrtTimestamp(entry.end) })).filter((entry) => Number.isFinite(entry.startSeconds) && Number.isFinite(entry.endSeconds) && entry.endSeconds > entry.startSeconds && normalizeText(entry.text))
    if (!entries.length || entries.length > 500) throw new Error('专业动态字幕条目为空或超过500条上限')
    const availability = this.transcription.availability?.() || { available: false, reason: '逐词转写组件不可用' }
    if (!availability.available) throw new Error(`${availability.reason || '逐词转写组件不可用'}，专业字幕不会按字符平均猜时间`)
    const transcribed = await this.transcription.transcribeWords({ sourcePath: source, lang: 'auto', model: 'ggml-tiny.bin', signal, timeoutMs: 60 * 60 * 1000 })
    const allWords = (transcribed.words || []).filter((word) => Number(word.confidence) >= Number(professional.wordHighlight.minimumConfidence || 0.15) && Number(word.endSeconds) > Number(word.startSeconds))
    const cues = []
    for (const entry of entries) {
      const selected = allWords.filter((word) => {
        const midpoint = (Number(word.startSeconds) + Number(word.endSeconds)) / 2
        return midpoint >= entry.startSeconds - 0.08 && midpoint <= entry.endSeconds + 0.08
      }).sort((a, b) => a.startSeconds - b.startSeconds)
      if (!selected.length || normalizeText(selected.map((word) => word.text).join('')) !== normalizeText(entry.text)) throw new Error(`第${entry.index}条字幕的逐词时间无法与字幕逐字对齐；已停止，不能按字符比例猜测`)
      cues.push({ index: entry.index, startSeconds: entry.startSeconds, endSeconds: entry.endSeconds, text: entry.text, words: selected.map((word) => ({ text: String(word.text).trim(), startSeconds: rounded(Math.max(entry.startSeconds, Number(word.startSeconds)), 3), endSeconds: rounded(Math.min(entry.endSeconds, Number(word.endSeconds)), 3), confidence: rounded(word.confidence) })) })
    }
    const embeddings = []
    for (const cue of cues) {
      const speechStartSeconds = Number(cue.words[0].startSeconds)
      const speechEndSeconds = Number(cue.words.at(-1).endSeconds)
      const durationSeconds = Math.min(3.5, Math.max(0.35, speechEndSeconds - speechStartSeconds))
      const pcm = await this.frames.readPcmWindow(source, speechStartSeconds, { durationSeconds, sampleRateHz: 8000, signal })
      const embedding = acousticEmbedding(pcm, 8000)
      if (!(embedding.rms > 0.0001) || !(embedding.pitchHz > 0) || embedding.pitchConfidence < 0.15) throw new Error(`第${cue.index}条字幕没有形成可信声纹证据`)
      embeddings.push(embedding)
    }
    const speakers = clusterSpeakers(embeddings, { maximumSpeakers: professional.speakers.maximumSpeakers || 4, distanceThreshold: professional.speakers.distanceThreshold || 0.18 })
    cues.forEach((cue, index) => { cue.speakerIndex = speakers.assignments[index]; cue.speakerLabel = `说话人${speakers.assignments[index] + 1}` })
    const terms = keywordTerms(professional.keywords.explicit, cues.flatMap((cue) => cue.words))
    let emphasisCount = 0
    cues.forEach((cue) => cue.words.forEach((word) => { word.keyword = terms.includes(normalizeText(word.text)); if (word.keyword) emphasisCount += 1 }))
    if (professional.keywords.enabled && (!terms.length || emphasisCount < 1)) throw new Error('关键词强调没有找到可与真实逐词时间绑定的词')
    const dimensions = await this.frames.probeDimensions(source, { signal })
    if (!(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error('无法读取专业字幕画布尺寸')
    const safeArea = await this.safeAreaPlan(source, cues, dimensions, signal)
    const plan = {
      schemaVersion: 1,
      strategy: 'acoustic-speaker-karaoke-v1',
      speakers,
      wordTiming: { method: transcribed.timingMethod || 'whisper.cpp-dtw-v1', model: transcribed.model || 'ggml-tiny.bin', wordCount: cues.reduce((sum, cue) => sum + cue.words.length, 0), minimumConfidence: Math.min(...cues.flatMap((cue) => cue.words.map((word) => word.confidence))) },
      karaoke: { mode: 'ass-kf', tagCount: cues.reduce((sum, cue) => sum + cue.words.length, 0) },
      keywords: { terms, emphasisCount },
      safeArea,
      dimensions: { width: Number(dimensions.width), height: Number(dimensions.height) },
      cues
    }
    const document = buildAssDocument({ dimensions: plan.dimensions, safeArea, cues })
    const temp = `${outputAssPath}.${process.pid}.tmp`
    try { this.fs.writeFileSync(temp, document, 'utf8'); this.fs.renameSync(temp, outputAssPath) } finally { if (this.fs.existsSync(temp)) this.fs.rmSync(temp, { force: true }) }
    return plan
  }

  async verifyRender({ sourcePath, outputPath, plan, signal } = {}) {
    if (plan?.schemaVersion !== 1 || plan?.strategy !== 'acoustic-speaker-karaoke-v1') throw new Error('专业字幕渲染证明缺少冻结方案')
    let chosen = 0; let opposite = 0; let samples = 0
    for (const cue of plan.cues.slice(0, 8)) {
      const seconds = (cue.startSeconds + cue.endSeconds) / 2
      const [sourceFrame, outputFrame] = await Promise.all([this.frames.readGrayFrame(sourcePath, seconds, { signal }), this.frames.readGrayFrame(outputPath, seconds, { signal })])
      chosen += bandDifference(sourceFrame, outputFrame, plan.safeArea.chosenZone)
      opposite += bandDifference(sourceFrame, outputFrame, plan.safeArea.chosenZone === 'top' ? 'bottom' : 'top')
      samples += 1
    }
    const chosenBandDiff = samples ? chosen / samples : 0; const oppositeBandDiff = samples ? opposite / samples : 0
    const subtitleInChosenZone = chosenBandDiff >= 0.005 && chosenBandDiff >= Math.max(0.001, oppositeBandDiff * 1.5)
    if (!subtitleInChosenZone) throw new Error(`专业字幕像素没有落在冻结安全区：选择区差异${rounded(chosenBandDiff)}，对侧差异${rounded(oppositeBandDiff)}`)
    return {
      schemaVersion: 1,
      method: 'professional-subtitle-render-proof-v1',
      verdict: 'matched',
      speakerEvidence: { method: plan.speakers.method, speakerCount: plan.speakers.speakerCount, confidence: plan.speakers.confidence, anonymousLabels: true },
      wordTimingEvidence: { method: plan.wordTiming.method, model: plan.wordTiming.model, wordCount: plan.wordTiming.wordCount, minimumConfidence: plan.wordTiming.minimumConfidence, exactCueAlignment: true },
      karaokeEvidence: { mode: plan.karaoke.mode, tagCount: plan.karaoke.tagCount, matchedWordCount: plan.wordTiming.wordCount },
      keywordEvidence: { terms: plan.keywords.terms, emphasisCount: plan.keywords.emphasisCount },
      safeArea: { strategy: plan.safeArea.strategy, chosenZone: plan.safeArea.chosenZone, marginV: plan.safeArea.marginV, chosenBandDiff: rounded(chosenBandDiff), oppositeBandDiff: rounded(oppositeBandDiff), sampledFrames: samples, subtitleInChosenZone }
    }
  }
}

module.exports = { ProfessionalSubtitleService, acousticEmbedding, bandComplexity, buildAssDocument, clusterSpeakers, normalizeText }
