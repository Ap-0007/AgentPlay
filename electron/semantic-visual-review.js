const MIN_VISUAL_CONFIDENCE = 0.85

function cueByIndex(cues) {
  return new Map((Array.isArray(cues) ? cues : []).map((cue, index) => [Number(cue.cueIndex) || index + 1, {
    cueIndex: Number(cue.cueIndex) || index + 1,
    startSeconds: Number(cue.startSeconds ?? cue.start), endSeconds: Number(cue.endSeconds ?? cue.end), text: String(cue.text || '')
  }]))
}

function candidateFrameMoments({ cues, candidates, durationSeconds } = {}) {
  const byIndex = cueByIndex(cues)
  const duration = Number(durationSeconds)
  return (Array.isArray(candidates) ? candidates : []).flatMap((candidate, index) => {
    const removed = (candidate.removeCueIndexes || []).map((cueIndex) => byIndex.get(Number(cueIndex))).filter(Boolean)
    if (!removed.length) return []
    const start = Math.min(...removed.map((cue) => cue.startSeconds))
    const end = Math.max(...removed.map((cue) => cue.endSeconds))
    const prefix = `candidate-${index + 1}`
    return [
      { candidateIndex: index + 1, role: 'before', label: `${prefix}-before`, seconds: Number(Math.max(0, start - 0.25).toFixed(3)) },
      { candidateIndex: index + 1, role: 'middle', label: `${prefix}-middle`, seconds: Number(((start + end) / 2).toFixed(3)) },
      { candidateIndex: index + 1, role: 'after', label: `${prefix}-after`, seconds: Number(Math.min(Number.isFinite(duration) ? duration : end + 0.25, end + 0.25).toFixed(3)) }
    ]
  })
}

function parseVisualReviewJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('视觉审阅模型没有返回JSON对象')
  return JSON.parse(raw.slice(start, end + 1))
}

function validateVisualReview(payload, moments, candidates) {
  const availableLabels = new Set((moments || []).map((item) => item.label))
  const validations = []
  for (let index = 0; index < (candidates || []).length; index += 1) {
    const candidateIndex = index + 1
    const raw = (payload?.validations || []).find((item) => Number(item.candidateIndex) === candidateIndex)
    const expected = ['before', 'middle', 'after'].map((role) => `candidate-${candidateIndex}-${role}`)
    if (!raw) { validations.push({ candidateIndex, verdict: 'uncertain', confidence: 0, reason: '视觉模型没有返回该候选', evidenceLabels: [] }); continue }
    const verdict = ['safe', 'unsafe', 'uncertain'].includes(raw.verdict) ? raw.verdict : 'uncertain'
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0))
    const evidenceLabels = [...new Set((Array.isArray(raw.evidenceLabels) ? raw.evidenceLabels : []).map(String).filter((label) => availableLabels.has(label)))]
    if (verdict === 'safe' && !expected.every((label) => evidenceLabels.includes(label))) throw new Error(`候选${candidateIndex}的安全结论必须引用候选前中后三帧`)
    validations.push({ candidateIndex, verdict, confidence: Number(confidence.toFixed(3)), reason: String(raw.reason || '').trim().slice(0, 300), evidenceLabels })
  }
  const safeCandidateIndexes = validations.filter((item) => item.verdict === 'safe' && item.confidence >= MIN_VISUAL_CONFIDENCE).map((item) => item.candidateIndex)
  const blockedCandidateIndexes = validations.filter((item) => !safeCandidateIndexes.includes(item.candidateIndex)).map((item) => item.candidateIndex)
  return { validations, safeCandidateIndexes, blockedCandidateIndexes }
}

function buildVisualReviewPrompt(candidates, moments) {
  const lines = (candidates || []).map((candidate, index) => `候选${index + 1}：${candidate.type}；建议删除字幕${(candidate.removeCueIndexes || []).join('、')}；文本理由：${candidate.reason}；帧标签：candidate-${index + 1}-before / candidate-${index + 1}-middle / candidate-${index + 1}-after`)
  return [
    '你只负责检查删除候选是否会破坏画面与叙事连续性，不重新判断字幕语义。',
    'safe：前后场景可连续衔接，候选中没有独有的产品演示、操作动作、图表证据、关键手势、人物反应或场景转折。',
    'unsafe：删除会丢失上述独有视觉信息或造成明显跳切。uncertain：画面不足以判断。宁可uncertain，不可猜。',
    '每个safe结论必须同时引用对应before/middle/after三帧标签。只返回JSON：{"validations":[{"candidateIndex":1,"verdict":"safe|unsafe|uncertain","confidence":0.9,"reason":"观察","evidenceLabels":["candidate-1-before","candidate-1-middle","candidate-1-after"]}]}',
    ...lines,
    `本次共提供${(moments || []).length}张带标签图片。`
  ].join('\n')
}

async function reviewSemanticCandidateVisuals({ sourcePath, cues, review, durationSeconds, readFrame, completeVisionMulti, model, signal } = {}) {
  if (typeof readFrame !== 'function' || typeof completeVisionMulti !== 'function') return { available: false, reason: '没有可用的镜头抽帧或视觉模型' }
  const moments = candidateFrameMoments({ cues, candidates: review?.candidates, durationSeconds })
  const images = []
  for (const moment of moments) {
    const data = await readFrame(sourcePath, moment.seconds, { signal })
    if (Buffer.isBuffer(data) && data.length >= 4) images.push({ label: moment.label, dataUrl: `data:image/jpeg;base64,${data.toString('base64')}` })
  }
  const completeCandidateIndexes = [...new Set(moments.map((item) => item.candidateIndex))].filter((candidateIndex) => ['before', 'middle', 'after'].every((role) => images.some((image) => image.label === `candidate-${candidateIndex}-${role}`)))
  if (!completeCandidateIndexes.length) return { available: false, reason: '没有候选取得完整的前中后三帧' }
  const result = await completeVisionMulti({ systemPrompt: '你是视频剪辑镜头连续性审阅器。只依据给定图片和标签判断，不能编造画面。', prompt: buildVisualReviewPrompt(review.candidates, moments), images, signal, timeoutMs: 180000, maxTokens: 1800 })
  const validated = validateVisualReview(parseVisualReviewJson(result?.text), moments, review.candidates)
  for (const candidateIndex of moments.map((item) => item.candidateIndex)) {
    if (!completeCandidateIndexes.includes(candidateIndex) && !validated.blockedCandidateIndexes.includes(candidateIndex)) validated.blockedCandidateIndexes.push(candidateIndex)
  }
  return { available: true, ...validated, frameMoments: moments, model: { providerId: String(model?.providerId || ''), providerName: String(model?.providerName || ''), model: String(model?.model || ''), local: Boolean(model?.local) } }
}

module.exports = { MIN_VISUAL_CONFIDENCE, buildVisualReviewPrompt, candidateFrameMoments, parseVisualReviewJson, reviewSemanticCandidateVisuals, validateVisualReview }
