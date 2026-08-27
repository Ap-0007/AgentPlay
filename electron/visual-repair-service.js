const path = require('path')

const CONSULTATION_PATTERN = /能不能|可不可以|可以吗|是否|怎么|如何/
const REPAIR_PATTERN = /防抖|稳定画面|画面稳定|旋转\s*(?:90|180|270)|顺时针|逆时针|自动(?:修复|校正|调整)?(?:曝光|亮度|色彩|偏色|白平衡)|(?:修复|校正)(?:曝光|偏色|白平衡)|低质量片段|问题片段/

function matchesVisualRepairInstruction(instruction) {
  const text = String(instruction || '').trim()
  return Boolean(text && !CONSULTATION_PATTERN.test(text) && REPAIR_PATTERN.test(text))
}

function parseVisualRepairInstruction(instruction) {
  const text = String(instruction || '').trim()
  let rotationDegrees = 0
  if (/逆时针[^，。；]{0,8}90|向左[^，。；]{0,8}90/.test(text)) rotationDegrees = -90
  else if (/顺时针[^，。；]{0,8}90|向右[^，。；]{0,8}90|旋转\s*90/.test(text)) rotationDegrees = 90
  else if (/180/.test(text)) rotationDegrees = 180
  else if (/270/.test(text)) rotationDegrees = -90
  const stabilize = /防抖|稳定画面|画面稳定/.test(text)
  const autoColor = /自动[^，。；]{0,8}(?:曝光|亮度|色彩|偏色|白平衡)|(?:修复|校正)[^，。；]{0,8}(?:曝光|偏色|白平衡)/.test(text)
  const inspectQuality = /低质量片段|问题片段|画面质量|提示低质量/.test(text)
  return { stabilize, rotationDegrees, autoColor, inspectQuality, comparison: stabilize || rotationDegrees !== 0 || autoColor }
}

function average(values) { const finite = values.filter(Number.isFinite); return finite.length ? finite.reduce((sum, item) => sum + item, 0) / finite.length : 0 }
function bounded(value, min, max) { return Math.max(min, Math.min(max, Number(value))) }

function parseSignalStatsLog(stderr) {
  const text = String(stderr || '')
  const values = (key) => [...text.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=(-?\\d+(?:\\.\\d+)?)`, 'g'))].map((match) => Number(match[1]))
  const y = values('YAVG'); const u = values('UAVG'); const v = values('VAVG'); const sat = values('SATAVG')
  const sampleCount = Math.min(y.length, u.length, v.length, sat.length)
  if (!sampleCount) return { sampleCount: 0, yAvg: 0, uAvg: 128, vAvg: 128, satAvg: 0 }
  return { sampleCount, yAvg: Number(average(y.slice(0, sampleCount)).toFixed(3)), uAvg: Number(average(u.slice(0, sampleCount)).toFixed(3)), vAvg: Number(average(v.slice(0, sampleCount)).toFixed(3)), satAvg: Number(average(sat.slice(0, sampleCount)).toFixed(3)) }
}

function recommendColorCorrection(stats) {
  const y = Number(stats?.yAvg) || 0; const u = Number(stats?.uAvg) || 128; const v = Number(stats?.vAvg) || 128; const sat = Number(stats?.satAvg) || 0
  const brightness = bounded((118 - y) / 255 * 0.75, -0.2, 0.2)
  const contrast = y < 75 ? 1.08 : y > 180 ? 0.94 : 1.03
  const saturation = sat < 60 ? 1.2 : sat > 125 ? 0.9 : 1
  const blueShift = bounded((128 - u) / 128 * 0.35, -0.2, 0.2)
  const redShift = bounded((128 - v) / 128 * 0.35, -0.2, 0.2)
  return { brightness: Number(brightness.toFixed(3)), contrast: Number(contrast.toFixed(3)), saturation: Number(saturation.toFixed(3)), redShift: Number(redShift.toFixed(3)), blueShift: Number(blueShift.toFixed(3)) }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function shakeScoreFromTransforms(text) {
  const magnitudes = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^Frame\s+\d+/.test(line)) continue
    const vectors = [...line.matchAll(/\(LM\s+(-?\d+)\s+(-?\d+)\s/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
    if (!vectors.length) continue
    const x = median(vectors.map((item) => item.x)); const y = median(vectors.map((item) => item.y))
    magnitudes.push(Math.hypot(x, y))
  }
  return { frameCount: magnitudes.length, averageMagnitude: Number(average(magnitudes).toFixed(3)), maximumMagnitude: Number(Math.max(0, ...magnitudes).toFixed(3)) }
}

function expectedDimensions(width, height, rotationDegrees) {
  const even = (value) => Math.max(2, Math.floor(Number(value) / 2) * 2)
  return Math.abs(Number(rotationDegrees)) === 90 ? { width: even(height), height: even(width) } : { width: even(width), height: even(height) }
}

function lowQualityFindings(inspection) {
  return [
    ...(inspection?.blackRanges || []).map((item) => ({ type: 'black', startSeconds: item.startSeconds, endSeconds: item.endSeconds, reason: '明显黑帧，仅提示，不自动删除', action: 'review-only' })),
    ...(inspection?.blurRanges || []).map((item) => ({ type: 'blur', startSeconds: item.startSeconds, endSeconds: item.endSeconds, reason: '明显失焦可能是创作意图，仅提示', action: 'review-only' })),
    ...(inspection?.duplicateRanges || []).map((item) => ({ type: 'duplicate', startSeconds: item.startSeconds, endSeconds: item.endSeconds, reason: '疑似重复镜头可能承载不同对白，仅提示', action: 'review-only' }))
  ].slice(0, 30)
}

function buildVisualRepairDecision({ instruction, sourcePath, width, height, durationSeconds, request, signalStats, inspection } = {}) {
  const source = path.resolve(String(sourcePath || ''))
  const parsed = request || parseVisualRepairInstruction(instruction)
  if (!source || !(Number(width) > 0) || !(Number(height) > 0) || !(Number(durationSeconds) > 0)) throw new Error('画面修复缺少有效源视频信息')
  if (!parsed.stabilize && !parsed.rotationDegrees && !parsed.autoColor) throw new Error('没有需要执行的画面修复动作')
  const correction = parsed.autoColor ? recommendColorCorrection(signalStats) : null
  return {
    schemaVersion: 1, kind: 'media.visual-repair', instruction: String(instruction || '').trim(), source: { path: source, name: path.basename(source) },
    repair: {
      strategy: 'ffmpeg-visual-repair-v1', confirmationRequired: true,
      sourceDimensions: { width: Number(width), height: Number(height) }, expectedDimensions: expectedDimensions(width, height, parsed.rotationDegrees), durationSeconds: Number(Number(durationSeconds).toFixed(3)),
      stabilize: Boolean(parsed.stabilize), rotationDegrees: Number(parsed.rotationDegrees) || 0, autoColor: Boolean(parsed.autoColor), correction,
      signalStats: parsed.autoColor ? signalStats : null, lowQualityFindings: parsed.inspectQuality ? lowQualityFindings(inspection) : [],
      comparison: { enabled: true, layout: 'side-by-side', originalLabel: '处理前原版', repairedLabel: '处理后版本' }
    },
    output: { container: 'mp4', overwrite: false, suffix: '画面修复版' },
    verification: { toleranceSeconds: 0.35, expectedOutputs: ['repaired', 'comparison'], requireSourceUnchanged: true }
  }
}

class VisualRepairPlanner {
  constructor({ frames, inspectMedia } = {}) { this.frames = frames; this.inspectMedia = inspectMedia }
  async signalStats(sourcePath, durationSeconds, signal) {
    const fps = Math.max(0.2, Math.min(2, 60 / Number(durationSeconds)))
    const result = await this.frames.run(['-hide_banner', '-nostats', '-i', sourcePath, '-vf', `fps=${fps.toFixed(4)},signalstats,metadata=print:key=lavfi.signalstats.YAVG,metadata=print:key=lavfi.signalstats.UAVG,metadata=print:key=lavfi.signalstats.VAVG,metadata=print:key=lavfi.signalstats.SATAVG`, '-an', '-f', 'null', '-'], { timeoutMs: Math.max(120000, Math.min(10 * 60 * 1000, Number(durationSeconds) * 800)), signal })
    return parseSignalStatsLog(result.stderr)
  }
  async plan({ instruction, sourcePath, signal } = {}) {
    if (!matchesVisualRepairInstruction(instruction)) return { matched: false }
    const request = parseVisualRepairInstruction(instruction)
    if (!request.stabilize && !request.rotationDegrees && !request.autoColor) return { matched: true, review: { kind: 'visual-repair-review', summary: '已识别为画面质量检查，但没有明确要执行的防抖、旋转或曝光/偏色修复动作。', candidates: [] } }
    if (!this.frames?.availability?.().available) return { matched: true, review: { kind: 'visual-repair-unavailable', summary: '缺少FFmpeg画面修复组件，未创建任务。', candidates: [] } }
    const durationSeconds = await this.frames.probeDuration(sourcePath, { signal }); const dimensions = await this.frames.probeDimensions(sourcePath, { signal })
    const [signalStats, inspection] = await Promise.all([
      request.autoColor ? this.signalStats(sourcePath, durationSeconds, signal) : null,
      request.inspectQuality && typeof this.inspectMedia === 'function' ? this.inspectMedia({ sourcePath, durationSeconds, signal }) : null
    ])
    return { matched: true, decision: buildVisualRepairDecision({ instruction, sourcePath, width: dimensions.width, height: dimensions.height, durationSeconds, request, signalStats, inspection }) }
  }
}

module.exports = { VisualRepairPlanner, buildVisualRepairDecision, expectedDimensions, lowQualityFindings, matchesVisualRepairInstruction, parseSignalStatsLog, parseVisualRepairInstruction, recommendColorCorrection, shakeScoreFromTransforms }
