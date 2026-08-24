const path = require('path')

const VISUAL_EFFECT_PATTERN = /裁成|裁剪画面|放大\s*\d|缩小\s*\d|画中画|关键帧|缓慢推近|缓慢拉远|从左到右|从右到左|转场|叠化|遮罩|打码|模糊|亮度|对比度|饱和度|暖色|冷色/
const CONSULTATION_PATTERN = /能不能|可不可以|可以吗|是否|怎么|如何/
const VIDEO_PATH_PATTERN = /([A-Za-z]:\\[^，；。\n]+?\.(?:mp4|mkv|mov|webm|m4v|wmv|avi))/i

function matchesVisualEffectInstruction(instruction) {
  const text = String(instruction || '').trim()
  return Boolean(text && !CONSULTATION_PATTERN.test(text) && VISUAL_EFFECT_PATTERN.test(text))
}

function bounded(value, min, max) { return Math.max(min, Math.min(max, Number(value))) }

function timeRange(text) {
  const match = /第?\s*(\d+(?:\.\d+)?)\s*秒\s*(?:到|至|—|－|-)\s*第?\s*(\d+(?:\.\d+)?)\s*秒/.exec(text)
  if (!match) return null
  const startSeconds = Number(match[1]); const endSeconds = Number(match[2])
  return endSeconds > startSeconds ? { startSeconds, endSeconds } : null
}

function timeRangeNear(text, pattern) {
  const match = pattern.exec(text)
  if (!match) return null
  const separators = /[；;。\n]/g
  let start = 0
  let end = text.length
  for (const separator of text.matchAll(separators)) {
    if (separator.index < match.index) start = separator.index + separator[0].length
    else { end = separator.index; break }
  }
  return timeRange(text.slice(start, end))
}

function positionOf(text) {
  if (/左上/.test(text)) return 'top-left'
  if (/左下/.test(text)) return 'bottom-left'
  if (/右下/.test(text)) return 'bottom-right'
  if (/中间|中央|居中/.test(text)) return 'center'
  return 'top-right'
}

function signedPercent(text, label, base, scale) {
  const increase = new RegExp(`${label}(?:提高|增加|调高|\\+)\\s*(\\d+(?:\\.\\d+)?)%`).exec(text)
  const decrease = new RegExp(`${label}(?:降低|减少|调低|-)\\s*(\\d+(?:\\.\\d+)?)%`).exec(text)
  if (increase) return base + Number(increase[1]) / 100 * scale
  if (decrease) return base - Number(decrease[1]) / 100 * scale
  return base
}

function compileVisualEffectDecision({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  if (!matchesVisualEffectInstruction(text)) return { matched: false }
  const source = String(sourcePath || '').trim()
  const effects = []
  const aspectMatch = /裁(?:成|剪成)?\s*(16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1)/.exec(text)
  if (aspectMatch) effects.push({ type: 'crop', aspect: aspectMatch[1].replace(/\s|：/g, ':') })
  const scaleUp = /放大(?:到)?\s*(\d+(?:\.\d+)?)\s*倍/.exec(text)
  const scaleDown = /缩小(?:到)?\s*(\d+(?:\.\d+)?)\s*倍/.exec(text)
  if (scaleUp || scaleDown) effects.push({ type: 'scale', factor: Number(bounded(Number((scaleUp || scaleDown)[1]), 0.5, 3).toFixed(3)) })
  if (/画中画/.test(text)) {
    const pipPath = VIDEO_PATH_PATTERN.exec(text)?.[1]
    if (!pipPath) return { matched: true, review: { kind: 'visual-effect-clarification', summary: '画中画需要明确的本地画中画素材路径，例如“把 D:\\素材\\演示.mp4 作为右上角画中画”。', candidates: [] } }
    const size = /占(?:画面)?\s*(\d+(?:\.\d+)?)%/.exec(text)
    const range = timeRangeNear(text, /画中画/)
    effects.push({ type: 'pip', path: pipPath, position: positionOf(text), scale: Number(bounded(Number(size?.[1] || 28) / 100, 0.1, 0.6).toFixed(3)), ...(range ? { timeRange: range } : {}) })
  }
  if (/关键帧|缓慢推近|缓慢拉远|从左到右|从右到左/.test(text)) {
    const range = timeRangeNear(text, /关键帧|缓慢推近|缓慢拉远|从左到右|从右到左/)
    const kind = /拉远/.test(text) ? 'zoom-out' : /从左到右/.test(text) ? 'pan-left-right' : /从右到左/.test(text) ? 'pan-right-left' : 'zoom-in'
    effects.push({ type: 'motion', kind, amount: /轻微|缓慢/.test(text) ? 0.15 : 0.25, ...(range ? { timeRange: range } : {}) })
  }
  if (/转场|叠化/.test(text)) {
    const at = /(?:在)?第\s*(\d+(?:\.\d+)?)\s*秒(?:处)?[^，；。]{0,16}(?:转场|叠化)/.exec(text)
    if (!at) return { matched: true, review: { kind: 'visual-effect-clarification', summary: '请说明转场发生在第几秒，例如“在第10秒加0.6秒叠化转场”。', candidates: [] } }
    const duration = /(?:加|做)\s*(\d+(?:\.\d+)?)\s*秒(?:的)?(?:淡化|叠化|转场)/.exec(text)
    effects.push({ type: 'transition', kind: 'fade', atSeconds: Number(at[1]), durationSeconds: Number(bounded(Number(duration?.[1] || 0.5), 0.2, 2).toFixed(3)) })
  }
  if (/遮罩|打码/.test(text)) {
    const range = timeRangeNear(text, /遮罩|打码/)
    effects.push({ type: 'mask', kind: /打码/.test(text) ? 'privacy' : 'solid', position: positionOf(text), width: 0.3, height: 0.2, opacity: 0.88, ...(range ? { timeRange: range } : {}) })
  }
  if (/模糊/.test(text)) {
    const range = timeRangeNear(text, /模糊/)
    effects.push({ type: 'blur', strength: /强模糊|重度模糊/.test(text) ? 12 : /轻微模糊/.test(text) ? 4 : 8, ...(range ? { timeRange: range } : {}) })
  }
  if (/亮度|对比度|饱和度|暖色|冷色/.test(text)) {
    const brightness = bounded(signedPercent(text, '亮度', 0, 1), -0.5, 0.5)
    const contrast = bounded(signedPercent(text, '对比度', 1, 1), 0.5, 2)
    const saturation = bounded(signedPercent(text, '饱和度', 1, 1), 0, 3)
    const temperature = /暖色/.test(text) ? 0.15 : /冷色/.test(text) ? -0.15 : 0
    effects.push({ type: 'color', brightness: Number(brightness.toFixed(3)), contrast: Number(contrast.toFixed(3)), saturation: Number(saturation.toFixed(3)), temperature })
  }
  if (!effects.length) return { matched: false }
  const pipSources = effects.filter((item) => item.type === 'pip').map((item) => ({ path: item.path, name: path.basename(item.path) }))
  return {
    matched: true,
    decision: {
      schemaVersion: 1, kind: 'media.visual-effects', instruction: text,
      source: { path: source, name: path.basename(source) }, ...(pipSources.length ? { effectSources: pipSources } : {}), effects,
      output: { container: 'mp4', overwrite: false, suffix: '视觉效果版' },
      verification: { toleranceSeconds: 0.35, expectedEffectKinds: effects.map((item) => item.type) }
    }
  }
}

module.exports = { compileVisualEffectDecision, matchesVisualEffectInstruction, positionOf, timeRange, timeRangeNear }
