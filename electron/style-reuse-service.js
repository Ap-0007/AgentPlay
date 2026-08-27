const crypto = require('crypto')

const SHOT_SIZES = ['大全景', '全景', '中景', '近景', '特写', '细节']
const MOVEMENTS = ['固定', '推', '拉', '摇', '移', '跟', '手持', '航拍']
const PALETTES = ['冷色', '暖色', '低饱和', '高饱和', '黑白', '高对比', '低对比', '自然色']
const LIGHTING = ['自然光', '侧光', '逆光', '顶光', '柔光', '硬光', '轮廓光', '低调光', '高调光']
const COMPOSITIONS = ['居中构图', '三分构图', '对称构图', '前景遮挡', '纵深构图', '留白构图']
const FORBIDDEN_COPY = /逐帧|一模一样|完全复刻|照搬|同一人物|原片人物|原片构图|保留\s*logo|复制\s*logo|临摹|像素级复刻/i

function hash(value) { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex') }
function safeText(value, max = 2000) { return String(value || '').replace(/\u0000/g, '').trim().slice(0, max) }

function timestampSeconds(value) {
  const parts = String(value || '').split(':').map(Number)
  if (parts.some((item) => !Number.isFinite(item))) return NaN
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : NaN
}

function repeatedToCount(values, fallback, count) {
  const source = values.length ? values : fallback
  return Array.from({ length: count }, (_, index) => source[index % source.length])
}

function orderedMatches(text, vocabulary) {
  const hits = []
  for (const value of vocabulary) {
    let index = text.indexOf(value)
    while (index >= 0) { hits.push({ value, index }); index = text.indexOf(value, index + value.length) }
  }
  return hits.sort((a, b) => a.index - b.index).map((item) => item.value)
}

function movementMatches(text) {
  const patterns = [
    ['固定', /固定|锁定机位/g], ['推', /推镜|推进|缓慢推/g], ['拉', /拉镜|拉远/g], ['摇', /摇镜|摇摄/g], ['移', /横移|侧移|移动镜头/g], ['跟', /跟拍|跟随镜头/g], ['手持', /手持/g], ['航拍', /航拍/g]
  ]
  const hits = []
  for (const [value, pattern] of patterns) for (const match of text.matchAll(pattern)) hits.push({ value, index: match.index })
  return hits.sort((a, b) => a.index - b.index).map((item) => item.value)
}

function compileStyleBlueprint(reportText, { count = 3 } = {}) {
  const report = String(reportText || '').slice(0, 20000)
  const targetCount = Math.max(2, Math.min(8, Number(count) || 3))
  const durations = [...report.matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:–|—|至|到|-)\s*(\d{1,2}:\d{2}(?::\d{2})?)/g)].map((match) => timestampSeconds(match[2]) - timestampSeconds(match[1])).filter((value) => value >= 1 && value <= 8).slice(0, targetCount)
  const normalizedDurations = repeatedToCount(durations.map((value) => Number(value.toFixed(3))), [2.5, 3, 4], targetCount)
  const shotSizes = repeatedToCount(orderedMatches(report, SHOT_SIZES), ['中景', '近景', '特写'], targetCount)
  const movements = repeatedToCount(movementMatches(report), ['固定', '推', '跟'], targetCount)
  const palette = [...new Set(orderedMatches(report, PALETTES))].slice(0, 6)
  const lighting = [...new Set(orderedMatches(report, LIGHTING))].slice(0, 6)
  const composition = [...new Set(orderedMatches(report, COMPOSITIONS))].slice(0, 6)
  return {
    schemaVersion: 1, strategy: 'abstract-style-blueprint-v1', sourceReportSha256: hash(report), sourceSpecificTextExcluded: true,
    rhythm: { durations: normalizedDurations, cadence: normalizedDurations.map((value) => value <= 2.5 ? 'fast' : value <= 4 ? 'medium' : 'slow') },
    shotSizes, movements,
    visual: { palette: palette.length ? palette : ['自然色'], lighting: lighting.length ? lighting : ['自然光'], composition: composition.length ? composition : ['三分构图'] },
    copyrightBoundary: { reuseOnly: ['节奏', '景别结构', '运镜类别', '光线类别', '色彩类别', '构图原则'], forbidden: ['原片人物', '品牌与Logo', '逐字文案', '独特道具', '独特构图坐标', '参考帧与逐帧画面'], referenceImagesAllowed: false }
  }
}

function extractProtectedFragments(reportText, mediaName = '') {
  const text = String(reportText || '').slice(0, 20000)
  const values = []
  for (const match of text.matchAll(/[“"'‘]([^”"'’]{4,120})[”"'’]/g)) values.push(match[1])
  for (const match of text.matchAll(/《([^》]{2,80})》/g)) values.push(match[1])
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9-]{2,30}\b/g)) values.push(match[0])
  for (const match of text.matchAll(/(?:人物叫|品牌为|品牌是|Logo为)\s*([^，。；\s]{2,40})/g)) values.push(match[1])
  if (String(mediaName || '').trim().length >= 3) values.push(String(mediaName).replace(/\.[^.]+$/, ''))
  return [...new Set(values.map((item) => safeText(item, 120)).filter((item) => item.length >= 3))].slice(0, 80)
}

function buildStyleShotPrompt({ blueprint, originalGoal, count } = {}) {
  if (blueprint?.strategy !== 'abstract-style-blueprint-v1') throw new Error('缺少抽象风格蓝图')
  const targetCount = Math.max(2, Math.min(8, Number(count) || blueprint.rhythm?.durations?.length || 3))
  return [
    '请依据抽象风格蓝图，为全新主题设计原创镜头。你看不到也不需要猜参考作品正文。',
    `新主题与信息目标：${safeText(originalGoal, 1000)}`,
    `抽象蓝图：${JSON.stringify(blueprint)}`,
    `正好返回${targetCount}个镜头。每个镜头的duration、shotSize、movement必须与蓝图同序一致。`,
    '禁止逐帧复制、照搬人物/品牌/Logo/逐字文案/独特道具/独特构图坐标；禁止要求生成画面文字。',
    '只返回JSON：{"shots":[{"prompt":"全新场景与动作","duration":2,"shotSize":"中景","movement":"固定","originalityDeclaration":"原创重构，不复制原片专有表达"}]}'
  ].join('\n\n')
}

function normalized(value) { return String(value || '').toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—-]+/g, '') }

function validateStyleShots(rawShots, { blueprint, protectedFragments = [], count } = {}) {
  const targetCount = Math.max(2, Math.min(8, Number(count) || blueprint?.rhythm?.durations?.length || 3))
  const list = Array.isArray(rawShots) ? rawShots : []
  if (blueprint?.strategy !== 'abstract-style-blueprint-v1' || list.length !== targetCount) throw new Error('原创镜头数量或风格蓝图无效')
  const protectedNormalized = protectedFragments.map(normalized).filter((item) => item.length >= 3)
  const shots = list.map((shot, index) => {
    const prompt = safeText(shot?.prompt, 2000)
    const duration = Number(shot?.duration); const shotSize = safeText(shot?.shotSize, 20); const movement = safeText(shot?.movement, 20); const declaration = safeText(shot?.originalityDeclaration, 80)
    if (prompt.length < 12 || FORBIDDEN_COPY.test(prompt) || /画面文字|显示文字|字幕内容|logo/i.test(prompt)) throw new Error(`第${index + 1}镜头触发版权或复制风险`)
    const promptNormalized = normalized(prompt)
    if (protectedNormalized.some((fragment) => promptNormalized.includes(fragment))) throw new Error(`第${index + 1}镜头包含参考作品专有表达`)
    if (Math.abs(duration - Number(blueprint.rhythm.durations[index])) > 0.001 || shotSize !== blueprint.shotSizes[index] || movement !== blueprint.movements[index]) throw new Error(`第${index + 1}镜头没有遵循冻结的节奏/景别/运镜结构`)
    if (declaration !== '原创重构，不复制原片专有表达') throw new Error(`第${index + 1}镜头缺少原创声明`)
    return { prompt, duration, shotSize, movement, originalityDeclaration: declaration }
  })
  return {
    shots,
    receipt: {
      schemaVersion: 1, strategy: blueprint.strategy, blueprintSha256: hash(JSON.stringify(blueprint)), sourceReportSha256: blueprint.sourceReportSha256,
      rawReportSentToShotModel: false, referenceImagesSent: 0, protectedFragmentCount: protectedFragments.length,
      structureMatched: true, promptSafetyPassed: true, promptSha256: shots.map((item) => hash(item.prompt))
    }
  }
}

module.exports = { buildStyleShotPrompt, compileStyleBlueprint, extractProtectedFragments, hash, validateStyleShots }
