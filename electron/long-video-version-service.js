const path = require('path')
const crypto = require('crypto')

const MAX_VERSION_CUES = 240
const MIN_IMPORTANCE = 0.5
const LONG_VERSION_PATTERN = /(?:长视频|视频)[^，。；]{0,28}(?:短版|精华版|章节版|平台(?:时长)?版|平台版本)|(?:生成|制作|做成)[^，。；]{0,20}(?:15秒|30秒|60秒|短版|精华版|章节版)[^，。；]{0,20}(?:版本|平台版|短版|精华版|章节版)/
const CONSULTATION_PATTERN = /能不能|可不可以|可以吗|是否|怎么|如何/

function matchesLongVersionInstruction(instruction) {
  const text = String(instruction || '').trim()
  return Boolean(text && !CONSULTATION_PATTERN.test(text) && LONG_VERSION_PATTERN.test(text))
}

function normalizeCues(cues) {
  return (Array.isArray(cues) ? cues : []).slice(0, MAX_VERSION_CUES).map((cue, index) => ({
    cueIndex: Number(cue.cueIndex) || index + 1,
    startSeconds: Number(cue.startSeconds ?? cue.start), endSeconds: Number(cue.endSeconds ?? cue.end), text: String(cue.text || '').trim()
  })).filter((cue) => Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds) && cue.endSeconds > cue.startSeconds && cue.text)
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('长视频版本模型没有返回JSON对象')
  return JSON.parse(raw.slice(start, end + 1))
}

function evidenceForRange(rawEvidence, byIndex, startCueIndex, endCueIndex, label) {
  const evidence = (Array.isArray(rawEvidence) ? rawEvidence : []).map((item) => ({ cueIndex: Number(item?.cueIndex), quote: String(item?.quote || '').trim().slice(0, 240) }))
  for (const cueIndex of [...new Set([startCueIndex, endCueIndex])]) {
    const cue = byIndex.get(cueIndex); const item = evidence.find((entry) => entry.cueIndex === cueIndex)
    if (!item?.quote || !cue?.text.includes(item.quote)) throw new Error(`${label}第${cueIndex}条引句不在原字幕中`)
  }
  return evidence.filter((item) => item.cueIndex >= startCueIndex && item.cueIndex <= endCueIndex && byIndex.get(item.cueIndex)?.text.includes(item.quote))
}

function validateLongVideoPlan(payload, cues) {
  const normalized = normalizeCues(cues)
  if (normalized.length < 6) throw new Error('长视频版本至少需要6条带时间轴字幕')
  const byIndex = new Map(normalized.map((cue) => [cue.cueIndex, cue]))
  const summary = String(payload?.summary || '').trim().slice(0, 500)
  if (!summary) throw new Error('长视频版本计划缺少内容摘要')
  const chapters = (Array.isArray(payload?.chapters) ? payload.chapters : []).slice(0, 12).map((raw, index) => {
    const startCueIndex = Number(raw?.startCueIndex); const endCueIndex = Number(raw?.endCueIndex); const importance = Number(raw?.importance)
    if (!byIndex.has(startCueIndex) || !byIndex.has(endCueIndex) || endCueIndex < startCueIndex) throw new Error(`第${index + 1}章字幕范围无效`)
    if (!Number.isFinite(importance) || importance < MIN_IMPORTANCE || importance > 1) throw new Error(`第${index + 1}章重要度无效`)
    return { title: String(raw?.title || `第${index + 1}章`).trim().slice(0, 60), startCueIndex, endCueIndex, importance: Number(importance.toFixed(3)), reason: String(raw?.reason || '').trim().slice(0, 300), evidence: evidenceForRange(raw?.evidence, byIndex, startCueIndex, endCueIndex, `第${index + 1}章`) }
  })
  if (chapters.length < 2) throw new Error('长视频至少需要2个章节')
  if (chapters[0].startCueIndex !== normalized[0].cueIndex || chapters.at(-1).endCueIndex !== normalized.at(-1).cueIndex) throw new Error('章节必须连续覆盖全部字幕')
  for (let index = 1; index < chapters.length; index += 1) if (chapters[index].startCueIndex !== chapters[index - 1].endCueIndex + 1) throw new Error('章节必须连续覆盖且不能重叠')
  const highlights = (Array.isArray(payload?.highlights) ? payload.highlights : []).slice(0, 24).map((raw, index) => {
    const startCueIndex = Number(raw?.startCueIndex); const endCueIndex = Number(raw?.endCueIndex); const importance = Number(raw?.importance)
    if (!byIndex.has(startCueIndex) || !byIndex.has(endCueIndex) || endCueIndex < startCueIndex) throw new Error(`第${index + 1}个高光范围无效`)
    if (!Number.isFinite(importance) || importance < MIN_IMPORTANCE || importance > 1) throw new Error(`第${index + 1}个高光重要度无效`)
    return { startCueIndex, endCueIndex, importance: Number(importance.toFixed(3)), reason: String(raw?.reason || '').trim().slice(0, 300), evidence: evidenceForRange(raw?.evidence, byIndex, startCueIndex, endCueIndex, `第${index + 1}个高光`) }
  })
  if (highlights.length < 2) throw new Error('长视频版本至少需要2个高光片段')
  return { summary, chapters, highlights, cueCount: normalized.length }
}

function buildPrompt(cues) {
  const lines = normalizeCues(cues).map((cue) => `[${cue.cueIndex}][${cue.startSeconds.toFixed(2)}-${cue.endSeconds.toFixed(2)}] ${cue.text}`)
  return [
    '基于下面完整编号字幕，只规划一份共享章节与高光证据，后续所有短版、精华版、章节版和平台时长版都必须复用它。',
    'chapters必须2-12章、按字幕顺序连续覆盖全部字幕且不重叠；highlights必须选择最有信息密度、结论、冲突、案例或可行动价值的2-24段。',
    '每个章节和高光都必须引用范围首尾字幕中的连续原文；不能发明时间、字幕或事实。importance范围0.5-1。',
    '只返回JSON：{"summary":"摘要","chapters":[{"title":"章节","startCueIndex":1,"endCueIndex":4,"importance":0.8,"reason":"理由","evidence":[{"cueIndex":1,"quote":"原文"},{"cueIndex":4,"quote":"原文"}]}],"highlights":[{"startCueIndex":2,"endCueIndex":3,"importance":0.95,"reason":"理由","evidence":[{"cueIndex":2,"quote":"原文"},{"cueIndex":3,"quote":"原文"}]}]}',
    '', ...lines
  ].join('\n')
}

async function planLongVideoVersions({ cues, complete, model, signal } = {}) {
  if (typeof complete !== 'function') return { available: false, reason: '没有可用的长视频版本规划模型' }
  const basePrompt = buildPrompt(cues)
  let previous = ''; let previousError = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\n上一版未通过合同：${String(previousError?.message || previousError).slice(0, 300)}\n只修正JSON、章节连续性、字幕序号和引句，不新增事实。上一版：\n${previous.slice(0, 6000)}`
    const response = await complete({ systemPrompt: '你是长视频多版本剪辑规划器。只引用给定字幕，不执行剪辑，不生成新画面。', prompt, signal, timeoutMs: 150000, maxTokens: 3000 })
    previous = String(response?.text || '')
    try {
      const validated = validateLongVideoPlan(parseJson(previous), cues)
      return { available: true, ...validated, model: { providerId: String(model?.providerId || ''), providerName: String(model?.providerName || ''), model: String(model?.model || ''), local: Boolean(model?.local) } }
    } catch (error) { previousError = error; if (attempt === 2) throw error }
  }
  throw previousError
}

function rangeFromCues(item, byIndex) {
  const first = byIndex.get(item.startCueIndex); const last = byIndex.get(item.endCueIndex)
  return { sourceStartSeconds: Number(first.startSeconds.toFixed(3)), sourceEndSeconds: Number(last.endSeconds.toFixed(3)), durationSeconds: Number((last.endSeconds - first.startSeconds).toFixed(3)), importance: item.importance, reason: item.reason, cueIndexes: [item.startCueIndex, item.endCueIndex], evidence: item.evidence }
}

function selectForBudget(ranges, targetSeconds) {
  let remaining = Number(targetSeconds)
  const selected = []
  for (const range of [...ranges].sort((left, right) => right.importance - left.importance || left.sourceStartSeconds - right.sourceStartSeconds)) {
    if (remaining < 1) break
    const duration = Math.min(range.durationSeconds, remaining)
    if (duration < 1) continue
    selected.push({ ...range, sourceEndSeconds: Number((range.sourceStartSeconds + duration).toFixed(3)), durationSeconds: Number(duration.toFixed(3)) })
    remaining -= duration
  }
  return selected.sort((left, right) => left.sourceStartSeconds - right.sourceStartSeconds)
}

function compileLongVideoVersionBundle({ instruction, sourcePath, subtitlePath, durationSeconds, cues, reviewed } = {}) {
  const duration = Number(durationSeconds)
  if (!reviewed?.available || !Number.isFinite(duration) || duration < 30) throw new Error('长视频多版本需要至少30秒素材和有效共享证据')
  const normalized = normalizeCues(cues); const byIndex = new Map(normalized.map((cue) => [cue.cueIndex, cue]))
  const highlightRanges = reviewed.highlights.map((item) => rangeFromCues(item, byIndex))
  const profileDefs = [['short-30', '短版', 30], ['highlight-90', '精华版', 90], ['platform-15', '15秒平台版', 15], ['platform-30', '30秒平台版', 30], ['platform-60', '60秒平台版', 60]]
  const variants = profileDefs.map(([id, label, target]) => {
    const targetSeconds = Math.min(Number(target), duration)
    const segments = selectForBudget(highlightRanges, targetSeconds)
    return { id, label, targetSeconds, durationSeconds: Number(segments.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3)), segments }
  }).filter((item) => item.segments.length)
  const chapters = reviewed.chapters.map((item, index) => ({ id: `chapter-${index + 1}`, label: `章节${index + 1}-${item.title}`, title: item.title, ...rangeFromCues(item, byIndex) }))
  return {
    schemaVersion: 1, strategy: 'shared-evidence-long-video-versions-v1', confirmationRequired: true,
    instruction: String(instruction || '').trim(), source: { path: String(sourcePath || ''), name: path.basename(String(sourcePath || '')) }, subtitlePath: String(subtitlePath || ''), sourceDurationSeconds: Number(duration.toFixed(3)),
    summary: reviewed.summary, model: reviewed.model, sharedEvidence: { chapters: reviewed.chapters, highlights: reviewed.highlights }, variants, chapters
  }
}

function freezeLongVideoVersionPlan(plan) {
  const frozen = JSON.parse(JSON.stringify(plan || {}))
  delete frozen.planHash
  return { ...frozen, planHash: crypto.createHash('sha256').update(JSON.stringify(frozen)).digest('hex') }
}

function assertLongVideoVersionPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.strategy !== 'shared-evidence-long-video-versions-v1') throw new Error('长视频版本方案无效')
  const actual = String(plan.planHash || '')
  const frozen = JSON.parse(JSON.stringify(plan)); delete frozen.planHash
  const expected = crypto.createHash('sha256').update(JSON.stringify(frozen)).digest('hex')
  if (!actual || actual !== expected) throw new Error('长视频版本方案已变化，请重新规划')
  return plan
}

module.exports = { MAX_VERSION_CUES, assertLongVideoVersionPlan, buildLongVideoVersionPrompt: buildPrompt, compileLongVideoVersionBundle, freezeLongVideoVersionPlan, matchesLongVersionInstruction, planLongVideoVersions, selectForBudget, validateLongVideoPlan }
