const SAMPLE_WIDTH = 32
const SAMPLE_HEIGHT = 18
const MAX_SAMPLE_FRAMES = 240

const AUTO_INSPECTION_PATTERN = /(?:自动|全面|完整)?(?:检查|检测|体检|扫描)[^，。；]{0,18}(?:视频|静音|口头禅|重复镜头|黑帧|失焦)|(?:静音|口头禅|重复镜头|黑帧|失焦)[^，。；]{0,24}(?:检查|检测|体检|扫描|剪辑方案)/
const CONSULTATION_PATTERN = /能不能|可不可以|可以吗|是否|怎么|如何/

function matchesAutoInspectionInstruction(instruction) {
  const text = String(instruction || '').trim()
  return Boolean(text && !CONSULTATION_PATTERN.test(text) && AUTO_INSPECTION_PATTERN.test(text) && /方案|自动|全面|完整|检查|检测|体检|扫描/.test(text))
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function groupSamples(samples, { stepSeconds, score, baseline } = {}) {
  if (!samples.length) return []
  const groups = []
  for (const sample of samples) {
    const previous = groups.at(-1)
    if (previous && sample.timeSeconds - previous.at(-1).timeSeconds <= stepSeconds * 1.25) previous.push(sample)
    else groups.push([sample])
  }
  return groups.map((group) => {
    const startSeconds = Number(group[0].timeSeconds.toFixed(3))
    const endSeconds = Number((group.at(-1).timeSeconds + stepSeconds).toFixed(3))
    return {
      startSeconds, endSeconds, durationSeconds: Number((endSeconds - startSeconds).toFixed(3)),
      score: Number(score(group).toFixed(4)), ...(Number.isFinite(baseline) ? { baseline: Number(baseline.toFixed(4)) } : {})
    }
  })
}

function parseVisualInspectionLog(stderr) {
  const text = String(stderr || '')
  const blackRanges = [...text.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/g)].map((match) => ({
    startSeconds: Number(Number(match[1]).toFixed(3)), endSeconds: Number(Number(match[2]).toFixed(3)), durationSeconds: Number(Number(match[3]).toFixed(3)), score: 1
  })).filter((item) => item.durationSeconds >= 0.4)
  const blurSamples = []
  let currentTime = null
  for (const line of text.split(/\r?\n/)) {
    const frame = /pts_time:([\d.]+)/.exec(line)
    if (frame) currentTime = Number(frame[1])
    const blur = /lavfi\.blur=([^\s]+)/.exec(line)
    if (blur && Number.isFinite(currentTime)) {
      const value = String(blur[1]).toLowerCase() === 'nan' ? Number.POSITIVE_INFINITY : Number(blur[1])
      blurSamples.push({ timeSeconds: currentTime, score: value })
    }
  }
  const finiteScores = blurSamples.map((item) => item.score).filter(Number.isFinite)
  const baseline = median(finiteScores)
  const threshold = Math.max(8, baseline * 1.8)
  const times = blurSamples.map((item) => item.timeSeconds)
  const steps = times.slice(1).map((value, index) => value - times[index]).filter((value) => value > 0)
  const stepSeconds = median(steps) || 0.5
  const blurry = blurSamples.filter((item) => !Number.isFinite(item.score) || item.score >= threshold)
  const blurRanges = groupSamples(blurry, {
    stepSeconds,
    score: (group) => group.some((item) => !Number.isFinite(item.score)) ? 999 : group.reduce((sum, item) => sum + item.score, 0) / group.length,
    baseline
  }).filter((item) => item.durationSeconds >= Math.max(0.5, stepSeconds * 2 - 0.01))
  return { blackRanges, blurRanges, blurBaseline: Number(baseline.toFixed(4)), blurThreshold: Number(threshold.toFixed(4)) }
}

function meanAbsDiff(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return Number.POSITIVE_INFINITY
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index])
  return total / left.length
}

function detectDuplicateSequences(frames, { sampleFps = 2, minimumSeconds = 1.5, minimumGapSeconds = 2, matchThreshold = 3, variationThreshold = 6 } = {}) {
  const list = Array.isArray(frames) ? frames : []
  const minimumFrames = Math.max(2, Math.ceil(minimumSeconds * sampleFps))
  const gapFrames = Math.max(minimumFrames, Math.ceil(minimumGapSeconds * sampleFps))
  const candidates = []
  for (let later = gapFrames; later <= list.length - minimumFrames; later += 1) {
    if (candidates.some((item) => later / sampleFps < item.endSeconds)) continue
    let best = null
    for (let earlier = 0; earlier <= later - gapFrames; earlier += 1) {
      let length = 0
      let score = 0
      while (later + length < list.length && earlier + length < later) {
        const difference = meanAbsDiff(list[earlier + length], list[later + length])
        if (difference > matchThreshold) break
        score += difference
        length += 1
      }
      if (length < minimumFrames) continue
      let changing = false
      for (let offset = 1; offset < length; offset += 1) {
        if (meanAbsDiff(list[earlier + offset - 1], list[earlier + offset]) >= variationThreshold) { changing = true; break }
      }
      if (!changing) continue
      if (!best || length > best.length || (length === best.length && score < best.score)) best = { earlier, later, length, score }
    }
    if (best) {
      const durationSeconds = best.length / sampleFps
      candidates.push({
        startSeconds: Number((best.later / sampleFps).toFixed(3)), endSeconds: Number(((best.later + best.length) / sampleFps).toFixed(3)), durationSeconds: Number(durationSeconds.toFixed(3)),
        referenceStartSeconds: Number((best.earlier / sampleFps).toFixed(3)), referenceEndSeconds: Number(((best.earlier + best.length) / sampleFps).toFixed(3)), score: Number((best.score / best.length).toFixed(4))
      })
    }
  }
  return candidates
}

class MediaAutoInspection {
  constructor({ frames } = {}) { this.frames = frames }

  async inspect({ sourcePath, durationSeconds, signal } = {}) {
    const duration = Number(durationSeconds)
    if (!this.frames?.availability?.().available || !Number.isFinite(duration) || duration <= 0) throw new Error('缺少可用的ffmpeg视频体检组件')
    const sampleFps = Math.max(0.2, Math.min(2, MAX_SAMPLE_FRAMES / duration))
    const logResult = await this.frames.run([
      '-hide_banner', '-nostats', '-i', sourcePath,
      '-vf', `blackdetect=d=0.4:pic_th=0.98:pix_th=0.1,fps=${sampleFps.toFixed(4)},scale=320:-2,blurdetect=block_width=32:block_height=32:block_pct=80,metadata=print:key=lavfi.blur`,
      '-an', '-f', 'null', '-'
    ], { timeoutMs: Math.max(120000, Math.min(10 * 60 * 1000, duration * 800)), signal })
    const visual = parseVisualInspectionLog(logResult.stderr)
    let duplicateRanges = []
    const raw = await this.frames.readRawFrameBuffer?.([
      '-v', 'error', '-i', sourcePath, '-vf', `fps=${sampleFps.toFixed(4)},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=gray`,
      '-frames:v', String(MAX_SAMPLE_FRAMES), '-f', 'rawvideo', '-'
    ], { signal })
    if (raw) {
      const frameSize = SAMPLE_WIDTH * SAMPLE_HEIGHT
      const samples = []
      for (let offset = 0; offset + frameSize <= raw.length; offset += frameSize) samples.push(raw.subarray(offset, offset + frameSize))
      duplicateRanges = detectDuplicateSequences(samples, { sampleFps })
    }
    return { schemaVersion: 1, strategy: 'ffmpeg-media-auto-inspection-v1', sampleFps: Number(sampleFps.toFixed(4)), ...visual, duplicateRanges }
  }
}

module.exports = { MediaAutoInspection, detectDuplicateSequences, matchesAutoInspectionInstruction, meanAbsDiff, parseVisualInspectionLog }
