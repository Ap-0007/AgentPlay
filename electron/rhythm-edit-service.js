const fs = require('fs')
const path = require('path')

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])

function median(values) {
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function pcmStats(buffer) {
  const count = Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (!count) return { rms: 0, meanAbs: 0 }
  let power = 0; let sumAbs = 0
  for (let index = 0; index < count; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768
    power += value * value; sumAbs += Math.abs(value)
  }
  return { rms: Math.sqrt(power / count), meanAbs: sumAbs / count }
}

function alignedCorrelation(left, right, maxLag = 160) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return 0
  const a = new Int16Array(left.buffer, left.byteOffset, Math.floor(left.length / 2))
  const b = new Int16Array(right.buffer, right.byteOffset, Math.floor(right.length / 2))
  const size = Math.min(a.length, b.length)
  if (size < 64) return 0
  let best = -1
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    let dot = 0; let aa = 0; let bb = 0; let count = 0
    for (let index = 0; index < size; index += 4) {
      const other = index + lag
      if (other < 0 || other >= size) continue
      const av = a[index]; const bv = b[other]
      dot += av * bv; aa += av * av; bb += bv * bv; count += 1
    }
    if (count >= 16 && aa > 0 && bb > 0) best = Math.max(best, dot / Math.sqrt(aa * bb))
  }
  return Number(Math.max(0, best).toFixed(4))
}

function detectBeatGrid(buffer, { sampleRate = 11025, durationSeconds = 0 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < sampleRate * 4) throw new Error('音乐PCM太短，无法识别真实节拍')
  const samples = Math.floor(buffer.length / 2)
  const frameSize = 512; const hopSize = 256
  const rms = []
  for (let start = 0; start + frameSize <= samples; start += hopSize) {
    let power = 0
    for (let index = 0; index < frameSize; index += 1) {
      const value = buffer.readInt16LE((start + index) * 2) / 32768
      power += value * value
    }
    rms.push(Math.sqrt(power / frameSize))
  }
  const onset = rms.map((value, index) => {
    const history = rms.slice(Math.max(0, index - 8), index)
    const baseline = history.length ? history.reduce((sum, item) => sum + item, 0) / history.length : value
    return Math.max(0, value - baseline)
  })
  const onsetMedian = median(onset)
  const onsetMad = median(onset.map((value) => Math.abs(value - onsetMedian)))
  const threshold = onsetMedian + Math.max(0.004, onsetMad * 3)
  const candidates = []
  const minimumFrames = Math.max(1, Math.round(0.18 * sampleRate / hopSize))
  let last = -minimumFrames
  for (let index = 1; index < onset.length - 1; index += 1) {
    if (onset[index] < threshold || onset[index] < onset[index - 1] || onset[index] < onset[index + 1]) continue
    if (index - last < minimumFrames) {
      if (candidates.length && onset[index] > candidates.at(-1).strength) candidates[candidates.length - 1] = { index, timeSeconds: index * hopSize / sampleRate, strength: onset[index] }
      continue
    }
    candidates.push({ index, timeSeconds: index * hopSize / sampleRate, strength: onset[index] }); last = index
  }
  if (candidates.length < 8) throw new Error('没有检测到足够稳定的音乐起音，无法冒充节拍卡点')

  const bins = new Map()
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < Math.min(candidates.length, left + 5); right += 1) {
      const raw = candidates[right].timeSeconds - candidates[left].timeSeconds
      const subdivisions = right - left
      const interval = raw / subdivisions
      if (interval < 0.3 || interval > 1) continue
      const bin = Math.round(interval / 0.005)
      const weight = Math.sqrt(candidates[left].strength * candidates[right].strength) / subdivisions
      bins.set(bin, (bins.get(bin) || 0) + weight)
    }
  }
  if (!bins.size) throw new Error('起音间隔不能形成60–200 BPM的稳定网格')
  const bestBin = [...bins.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const periodSeconds = bestBin * 0.005
  const bpm = 60 / periodSeconds
  const phases = [...new Set(candidates.map((item) => Number((item.timeSeconds % periodSeconds).toFixed(3))))]
  let best = null
  for (const phase of phases) {
    const distances = candidates.map((item) => {
      const position = ((item.timeSeconds - phase) % periodSeconds + periodSeconds) % periodSeconds
      return Math.min(position, periodSeconds - position)
    })
    const tolerance = Math.min(0.08, periodSeconds * 0.18)
    const matched = distances.filter((value) => value <= tolerance).length
    const error = distances.filter((value) => value <= tolerance).reduce((sum, value) => sum + value, 0)
    const score = matched - error
    if (!best || score > best.score) best = { phase, matched, score }
  }
  const duration = Math.min(Number(durationSeconds) || samples / sampleRate, samples / sampleRate)
  const beatTimes = []
  for (let time = best.phase; time <= duration + 0.001; time += periodSeconds) {
    if (time >= 0.05) beatTimes.push(Number(time.toFixed(3)))
  }
  const supportRatio = beatTimes.length ? best.matched / Math.min(beatTimes.length, candidates.length) : 0
  if (beatTimes.length < 8 || supportRatio < 0.45 || bpm < 60 || bpm > 200) throw new Error('音乐节拍网格支持率不足，无法安全卡点')

  const windowSeconds = Math.min(4, Math.max(2.5, duration / 5))
  const windowFrames = Math.max(2, Math.round(windowSeconds * sampleRate / hopSize))
  const stepFrames = Math.max(1, Math.round(0.25 * sampleRate / hopSize))
  const rmsMedian = Math.max(0.000001, median(rms))
  let highlight = null
  for (let start = Math.round(sampleRate / hopSize); start + windowFrames < rms.length - Math.round(sampleRate / hopSize); start += stepFrames) {
    const slice = rms.slice(start, start + windowFrames)
    const averageRms = slice.reduce((sum, value) => sum + value, 0) / slice.length
    const onsetStrength = onset.slice(start, start + windowFrames).reduce((sum, value) => sum + value, 0)
    const score = averageRms / rmsMedian + onsetStrength * 8
    if (!highlight || score > highlight.score) highlight = { startSeconds: start * hopSize / sampleRate, endSeconds: (start + windowFrames) * hopSize / sampleRate, score }
  }
  if (!highlight) throw new Error('无法定位音乐高潮区间')
  return {
    schemaVersion: 1,
    method: 'decoded-pcm-onset-grid-v1',
    sampleRate,
    bpm: Number(bpm.toFixed(2)),
    periodSeconds: Number(periodSeconds.toFixed(3)),
    phaseSeconds: Number(best.phase.toFixed(3)),
    onsetCount: candidates.length,
    supportRatio: Number(Math.min(1, supportRatio).toFixed(3)),
    beatTimes,
    highlight: {
      startSeconds: Number(highlight.startSeconds.toFixed(3)),
      endSeconds: Number(Math.min(duration, highlight.endSeconds).toFixed(3)),
      score: Number(highlight.score.toFixed(3))
    }
  }
}

function buildRhythmPlan({ analysis, policy, sourceDuration, musicDuration }) {
  if (analysis?.method !== 'decoded-pcm-onset-grid-v1' || !Array.isArray(analysis.beatTimes)) throw new Error('节拍分析证据无效')
  const maximumDuration = Math.min(Number(sourceDuration), Number(musicDuration))
  if (!(maximumDuration >= 6)) throw new Error('视频或音乐短于6秒，无法形成可验收的节拍剪辑')
  const beats = analysis.beatTimes.filter((time) => time >= policy.minimumCutSeconds && time <= maximumDuration - 0.05)
  if (beats.length < 5) throw new Error('可用节拍不足，无法形成至少4个真实切镜区间')
  const highlightStart = analysis.highlight.startSeconds
  const highlightEnd = analysis.highlight.endSeconds
  const forcedHighlight = beats.reduce((best, time) => Math.abs(time - highlightStart) < Math.abs(best - highlightStart) ? time : best, beats[0])
  const selected = []
  let index = 0
  while (index < beats.length && selected.length < policy.maximumCuts + 1) {
    const time = beats[index]
    selected.push(time)
    const inHighlight = time >= highlightStart - analysis.periodSeconds && time < highlightEnd
    const step = inHighlight ? policy.highlightBeatsPerCut : policy.baseBeatsPerCut
    index += Math.max(1, step)
  }
  selected.push(forcedHighlight)
  const forcedIndex = beats.indexOf(forcedHighlight)
  for (let cursor = forcedIndex; cursor >= 0 && cursor < beats.length && beats[cursor] <= highlightEnd; cursor += Math.max(1, policy.highlightBeatsPerCut)) selected.push(beats[cursor])
  let boundaries = [...new Set(selected.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b)
  boundaries = boundaries.filter((value, index) => index === 0 || value - boundaries[index - 1] >= policy.minimumCutSeconds - 0.01)
  while (boundaries.length >= 4) {
    const outputEnd = boundaries.at(-1)
    const gapCount = boundaries.length - 1
    if (outputEnd + gapCount * policy.jumpGapSeconds <= sourceDuration + 0.001) break
    boundaries.pop()
  }
  if (boundaries.length < 4 || boundaries.at(-1) < 6) throw new Error('源片长度不足以在节拍间加入可验证跳切')
  const targets = [0, ...boundaries]
  const segments = []
  for (let index = 0; index < boundaries.length; index += 1) {
    const targetStartSeconds = targets[index]
    const targetEndSeconds = targets[index + 1]
    const sourceStartSeconds = targetStartSeconds + index * policy.jumpGapSeconds
    const sourceEndSeconds = sourceStartSeconds + (targetEndSeconds - targetStartSeconds)
    segments.push({
      index: index + 1,
      sourceStartSeconds: Number(sourceStartSeconds.toFixed(3)),
      sourceEndSeconds: Number(sourceEndSeconds.toFixed(3)),
      targetStartSeconds: Number(targetStartSeconds.toFixed(3)),
      targetEndSeconds: Number(targetEndSeconds.toFixed(3))
    })
  }
  const outputDurationSeconds = boundaries.at(-1)
  const cutTimes = boundaries.slice(0, -1)
  const intervalRows = segments.map((segment) => ({
    seconds: segment.targetEndSeconds - segment.targetStartSeconds,
    midpoint: (segment.targetStartSeconds + segment.targetEndSeconds) / 2
  }))
  const highlightIntervals = intervalRows.filter((item) => item.midpoint >= highlightStart && item.midpoint <= highlightEnd).map((item) => item.seconds)
  const outsideIntervals = intervalRows.filter((item) => item.midpoint < highlightStart || item.midpoint > highlightEnd).map((item) => item.seconds)
  const highlightAverage = highlightIntervals.length ? highlightIntervals.reduce((sum, value) => sum + value, 0) / highlightIntervals.length : 0
  const outsideAverage = outsideIntervals.length ? outsideIntervals.reduce((sum, value) => sum + value, 0) / outsideIntervals.length : 0
  const densityRatio = highlightAverage > 0 && outsideAverage > 0 ? highlightAverage / outsideAverage : 1
  const highlightAlignedCut = cutTimes.some((time) => Math.abs(time - forcedHighlight) <= 0.001)
  if (!highlightAlignedCut || !highlightIntervals.length || !outsideIntervals.length || densityRatio > 0.8) throw new Error('高潮区没有形成比普通段更密的真实节拍切镜')
  return {
    schemaVersion: 1,
    strategy: 'beat-synced-jump-cut-v1',
    pace: policy.pace,
    bpm: analysis.bpm,
    supportRatio: analysis.supportRatio,
    analysisMethod: analysis.method,
    sourceDurationSeconds: Number(sourceDuration.toFixed(3)),
    musicDurationSeconds: Number(musicDuration.toFixed(3)),
    outputDurationSeconds: Number(outputDurationSeconds.toFixed(3)),
    cutTimes,
    segments,
    highlight: {
      ...analysis.highlight,
      alignedBeatSeconds: Number(forcedHighlight.toFixed(3)),
      highlightAverageCutSeconds: Number(highlightAverage.toFixed(3)),
      outsideAverageCutSeconds: Number(outsideAverage.toFixed(3)),
      densityRatio: Number(densityRatio.toFixed(3))
    },
    tail: {
      endBeatSeconds: Number(outputDurationSeconds.toFixed(3)),
      fadeSeconds: Number(Math.min(policy.tailFadeSeconds, outputDurationSeconds / 3).toFixed(3)),
      videoFade: true,
      audioFade: true
    },
    confirmationRequired: true
  }
}

class RhythmEditPlanner {
  constructor({ frames, authorizePath = (value) => value, fsImpl = fs } = {}) {
    if (!frames) throw new Error('节拍剪辑规划器缺少FFmpeg执行器')
    this.frames = frames; this.authorizePath = authorizePath; this.fs = fsImpl
  }

  async plan(request, { signal } = {}) {
    if (request?.kind !== 'media.rhythm-edit-request' || request?.policy?.strategy !== 'pcm-beat-highlight-edit-v1') throw new Error('节拍剪辑请求无效')
    const source = path.resolve(String(request.source?.path || ''))
    const music = path.resolve(String(this.authorizePath(request.music?.path || '')))
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()) || !this.fs.existsSync(source)) throw new Error('节拍剪辑源视频不存在或格式不支持')
    if (!AUDIO_EXTENSIONS.has(path.extname(music).toLowerCase()) || !this.fs.existsSync(music)) throw new Error('节拍剪辑音乐不存在或格式不支持')
    const [sourceDuration, musicDuration] = await Promise.all([
      this.frames.probeDuration(source, { signal }),
      this.frames.probeDuration(music, { signal })
    ])
    if (!(sourceDuration >= 6) || !(musicDuration >= 6)) throw new Error('视频和音乐都必须至少6秒')
    const pcmDuration = Math.min(musicDuration, 600)
    const pcm = typeof this.frames.readAudioPcm === 'function'
      ? await this.frames.readAudioPcm(music, { durationSeconds: pcmDuration, sampleRateHz: 11025, signal })
      : await this.frames.readRawFrameBuffer([
        '-v', 'error', '-i', music, '-t', pcmDuration.toFixed(3), '-map', '0:a:0', '-vn',
        '-ac', '1', '-ar', '11025', '-c:a', 'pcm_s16le', '-f', 's16le', '-'
      ], { signal })
    if (!pcm) throw new Error('无法解码音乐PCM，不能分析真实节拍')
    const analysis = detectBeatGrid(pcm, { sampleRate: 11025, durationSeconds: pcmDuration })
    const rhythm = buildRhythmPlan({ analysis, policy: request.policy, sourceDuration, musicDuration })
    const decision = {
      schemaVersion: 1,
      kind: 'media.rhythm-edit',
      instruction: request.instruction,
      source: { path: source, name: path.basename(source) },
      music: { path: music, name: path.basename(music) },
      policy: JSON.parse(JSON.stringify(request.policy)),
      rhythm,
      output: { container: 'mp4', overwrite: false, suffix: `节拍剪辑-${request.policy.pace}` },
      verification: {
        toleranceSeconds: 0.2,
        requireDecodedBeatProof: true,
        minimumVisibleCutRatio: 0.5,
        requireHighlightDensity: true,
        requireNaturalTail: true
      }
    }
    return {
      matched: true,
      decision,
      review: {
        kind: 'rhythm-edit-plan',
        summary: `已从解码PCM识别 ${analysis.bpm.toFixed(1)} BPM（网格支持率 ${Math.round(analysis.supportRatio * 100)}%），计划 ${rhythm.segments.length} 个镜头；高潮 ${rhythm.highlight.startSeconds.toFixed(2)}–${rhythm.highlight.endSeconds.toFixed(2)} 秒切镜更密，片尾在 ${rhythm.tail.endBeatSeconds.toFixed(2)} 秒强拍处做画面和声音淡出。尚未执行。`,
        candidates: rhythm.cutTimes
      }
    }
  }
}

function grayMean(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return 0
  let sum = 0
  for (const value of buffer) sum += value
  return sum / buffer.length
}

function grayDiff(left, right) {
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) || left.length !== right.length || !left.length) return 0
  let sum = 0
  for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index])
  return sum / left.length
}

class RhythmEditService {
  constructor({ frames, fsImpl = fs } = {}) {
    if (!frames) throw new Error('节拍剪辑服务缺少FFmpeg执行器')
    this.frames = frames; this.fs = fsImpl
  }

  assertDecision(source, music, decision) {
    const rhythm = decision?.rhythm
    if (decision?.schemaVersion !== 1 || decision?.kind !== 'media.rhythm-edit' || rhythm?.schemaVersion !== 1 || rhythm?.strategy !== 'beat-synced-jump-cut-v1') throw new Error('冻结的节拍剪辑决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source || path.resolve(String(decision.music?.path || '')) !== music) throw new Error('节拍剪辑素材与冻结决策不一致')
    if (!Array.isArray(rhythm.segments) || rhythm.segments.length < 4 || !Array.isArray(rhythm.cutTimes)) throw new Error('节拍剪辑时间线不完整')
    return rhythm
  }

  filterGraph({ decision, hasSourceAudio }) {
    const rhythm = decision.rhythm; const segments = rhythm.segments; const count = segments.length
    const parts = [`[0:v]split=${count}${segments.map((_, index) => `[vsrc-${index}]`).join('')}`]
    segments.forEach((segment, index) => {
      parts.push(`[vsrc-${index}]trim=start=${segment.sourceStartSeconds.toFixed(3)}:end=${segment.sourceEndSeconds.toFixed(3)},setpts=PTS-STARTPTS[v-${index}]`)
    })
    const tailStart = Math.max(0, rhythm.outputDurationSeconds - rhythm.tail.fadeSeconds)
    parts.push(`${segments.map((_, index) => `[v-${index}]`).join('')}concat=n=${count}:v=1:a=0,fade=t=out:st=${tailStart.toFixed(3)}:d=${rhythm.tail.fadeSeconds.toFixed(3)},pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`)
    if (hasSourceAudio) {
      parts.push(`[0:a]asplit=${count}${segments.map((_, index) => `[asrc-${index}]`).join('')}`)
      segments.forEach((segment, index) => {
        const duration = segment.targetEndSeconds - segment.targetStartSeconds
        const fade = Math.min(0.02, duration / 4)
        parts.push(`[asrc-${index}]atrim=start=${segment.sourceStartSeconds.toFixed(3)}:end=${segment.sourceEndSeconds.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, duration - fade).toFixed(3)}:d=${fade.toFixed(3)}[a-${index}]`)
      })
      parts.push(`${segments.map((_, index) => `[a-${index}]`).join('')}concat=n=${count}:v=0:a=1,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[dialogue]`)
    }
    parts.push(`[1:a]atrim=start=0:end=${rhythm.outputDurationSeconds.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${Number(decision.policy.musicVolume).toFixed(3)}[music]`)
    if (hasSourceAudio && decision.policy.dialogueDucking) {
      parts.push('[dialogue]asplit=2[dialogue-main][duck-key]')
      parts.push('[music][duck-key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[music-duck]')
      parts.push(`[dialogue-main][music-duck]amix=inputs=2:duration=longest:normalize=0,afade=t=out:st=${tailStart.toFixed(3)}:d=${rhythm.tail.fadeSeconds.toFixed(3)},alimiter=limit=0.850:level=0[aout]`)
    } else if (hasSourceAudio) {
      parts.push(`[dialogue][music]amix=inputs=2:duration=longest:normalize=0,afade=t=out:st=${tailStart.toFixed(3)}:d=${rhythm.tail.fadeSeconds.toFixed(3)},alimiter=limit=0.850:level=0[aout]`)
    } else {
      parts.push(`[music]afade=t=out:st=${tailStart.toFixed(3)}:d=${rhythm.tail.fadeSeconds.toFixed(3)},alimiter=limit=0.850:level=0[aout]`)
    }
    return parts.join(';')
  }

  async proof({ source, music, output, decision, signal }) {
    const rhythm = this.assertDecision(source, music, decision)
    const duration = await this.frames.probeDuration(output, { signal })
    const visible = []
    for (const cut of rhythm.cutTimes.slice(0, 16)) {
      const [before, after] = await Promise.all([
        this.frames.readGrayFrame(output, Math.max(0.01, cut - 0.06), { signal }),
        this.frames.readGrayFrame(output, Math.min(duration - 0.01, cut + 0.06), { signal })
      ])
      const difference = grayDiff(before, after)
      visible.push({ cutSeconds: cut, difference: Number(difference.toFixed(3)), visible: difference >= 0.8 })
    }
    const visibleCutRatio = visible.length ? visible.filter((item) => item.visible).length / visible.length : 0
    const musicAt = Math.min(rhythm.highlight.alignedBeatSeconds + 0.05, duration - 0.5)
    const [musicPcm, outputPcm] = await Promise.all([
      this.frames.readPcmWindow(music, musicAt, { durationSeconds: 0.35, sampleRateHz: 16000, signal }),
      this.frames.readPcmWindow(output, musicAt, { durationSeconds: 0.35, sampleRateHz: 16000, signal })
    ])
    const musicCorrelation = alignedCorrelation(musicPcm, outputPcm)
    const tailStart = Math.max(0, duration - rhythm.tail.fadeSeconds)
    const [audioBefore, audioEnd, videoBefore, videoEnd] = await Promise.all([
      this.frames.readPcmWindow(output, Math.max(0, tailStart + 0.05), { durationSeconds: 0.2, sampleRateHz: 16000, signal }),
      this.frames.readPcmWindow(output, Math.max(0, duration - 0.22), { durationSeconds: 0.18, sampleRateHz: 16000, signal }),
      this.frames.readGrayFrame(output, Math.max(0, tailStart + 0.05), { signal }),
      this.frames.readGrayFrame(output, Math.max(0, duration - 0.05), { signal })
    ])
    const beforeAudioRms = pcmStats(audioBefore).rms; const endAudioRms = pcmStats(audioEnd).rms
    const beforeVideoMean = grayMean(videoBefore); const endVideoMean = grayMean(videoEnd)
    const audioFaded = beforeAudioRms < 0.0001 ? endAudioRms <= 0.0001 : endAudioRms <= beforeAudioRms * 0.65
    const videoFaded = beforeVideoMean < 2 ? endVideoMean <= 2 : endVideoMean <= beforeVideoMean * 0.65
    const beatProof = {
      schemaVersion: 1,
      method: 'decoded-beat-cut-proof-v1',
      bpm: rhythm.bpm,
      supportRatio: rhythm.supportRatio,
      cutCount: rhythm.cutTimes.length,
      visibleCuts: visible,
      visibleCutRatio: Number(visibleCutRatio.toFixed(3)),
      musicCorrelation,
      highlight: {
        alignedBeatSeconds: rhythm.highlight.alignedBeatSeconds,
        densityRatio: rhythm.highlight.densityRatio,
        denserThanOutside: rhythm.highlight.densityRatio <= 0.8
      },
      tail: {
        endBeatSeconds: rhythm.tail.endBeatSeconds,
        audioBeforeRms: Number(beforeAudioRms.toFixed(6)),
        audioEndRms: Number(endAudioRms.toFixed(6)),
        videoBeforeMean: Number(beforeVideoMean.toFixed(3)),
        videoEndMean: Number(endVideoMean.toFixed(3)),
        audioFaded,
        videoFaded
      }
    }
    if (Math.abs(duration - rhythm.outputDurationSeconds) > Number(decision.verification.toleranceSeconds || 0.2)) throw new Error('节拍剪辑成片时长与冻结时间线不一致')
    if (visibleCutRatio < Number(decision.verification.minimumVisibleCutRatio || 0.5)) throw new Error('节拍切点没有形成足够可验证的画面变化')
    if (musicCorrelation < 0.02) throw new Error('成片高潮区没有检测到冻结音乐的对齐证据')
    if (!beatProof.highlight.denserThanOutside) throw new Error('音乐高潮区切镜密度没有高于普通段')
    if (!audioFaded || !videoFaded) throw new Error('片尾画面或声音没有完成可验证的自然收束')
    return { duration, beatProof }
  }

  receipt({ output, decision, beatProof }) {
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      durationSeconds: decision.rhythm.outputDurationSeconds,
      rhythmReceipt: {
        schemaVersion: 1,
        strategy: decision.rhythm.strategy,
        pace: decision.rhythm.pace,
        bpm: decision.rhythm.bpm,
        supportRatio: decision.rhythm.supportRatio,
        cutTimes: decision.rhythm.cutTimes,
        segments: decision.rhythm.segments,
        highlight: decision.rhythm.highlight,
        tail: decision.rhythm.tail
      },
      beatProof,
      summary: `已按真实 ${decision.rhythm.bpm.toFixed(1)} BPM 节拍生成 ${decision.rhythm.segments.length} 个镜头；高潮区切镜更密，片尾在强拍处完成画面与声音淡出，原文件未改动`
    }
  }

  async run({ sourcePath, musicPath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const music = path.resolve(String(musicPath || '')); const output = path.resolve(String(outputPath || ''))
    this.assertDecision(source, music, decision)
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()) || !AUDIO_EXTENSIONS.has(path.extname(music).toLowerCase()) || !this.fs.existsSync(source) || !this.fs.existsSync(music)) throw new Error('节拍剪辑素材不存在或格式不支持')
    if (source === output || this.fs.existsSync(output)) throw new Error('节拍剪辑禁止覆盖源文件或既有成果')
    const hasSourceAudio = await this.frames.probeHasAudio(source, { signal })
    const sourceBefore = this.fs.statSync(source); const musicBefore = this.fs.statSync(music)
    const parsed = path.parse(output); const temp = path.join(parsed.dir, `.${parsed.name}.agentplay-rhythm-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-i', music, '-filter_complex', this.filterGraph({ decision, hasSourceAudio }), '-map', '[vout]', '-map', '[aout]', '-t', decision.rhythm.outputDurationSeconds.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', temp], { timeoutMs: 60 * 60 * 1000, signal })
      const proof = await this.proof({ source, music, output: temp, decision, signal })
      const sourceAfter = this.fs.statSync(source); const musicAfter = this.fs.statSync(music)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs) || musicBefore.size !== musicAfter.size || Math.trunc(musicBefore.mtimeMs) !== Math.trunc(musicAfter.mtimeMs)) throw new Error('节拍剪辑期间源视频或音乐发生变化')
      this.fs.renameSync(temp, output)
      return this.receipt({ output, decision, beatProof: proof.beatProof })
    } catch (error) {
      if (this.fs.existsSync(temp)) this.fs.rmSync(temp, { force: true })
      throw error
    }
  }

  async verify({ sourcePath, musicPath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const music = path.resolve(String(musicPath || '')); const output = path.resolve(String(outputPath || ''))
    this.assertDecision(source, music, decision)
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('节拍剪辑成果不存在或不完整')
    const proof = await this.proof({ source, music, output, decision, signal })
    return this.receipt({ output, decision, beatProof: proof.beatProof })
  }
}

module.exports = { RhythmEditPlanner, RhythmEditService, alignedCorrelation, buildRhythmPlan, detectBeatGrid, pcmStats }
