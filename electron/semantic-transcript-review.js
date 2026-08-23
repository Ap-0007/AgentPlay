const MIN_SEMANTIC_CONFIDENCE = 0.85
const MAX_REVIEW_CUES = 80
const MAX_REVIEW_CANDIDATES = 8

function parseSemanticReviewJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    // 常见模型错误：quote值把原文装饰引号写成两个未转义双引号；只在quote字段删掉多出的第一个。
    .replace(/("quote"\s*:\s*)""([^"\r\n]+)"/g, '$1"$2"')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('语义审阅模型没有返回JSON对象')
  return JSON.parse(raw.slice(start, end + 1))
}

function normalizeReviewCues(cues) {
  return (Array.isArray(cues) ? cues : []).slice(0, MAX_REVIEW_CUES).map((cue, index) => ({
    cueIndex: Number(cue.cueIndex) || index + 1,
    startSeconds: Number(cue.startSeconds ?? cue.start),
    endSeconds: Number(cue.endSeconds ?? cue.end),
    text: String(cue.text || '').trim()
  })).filter((cue) => Number.isFinite(cue.startSeconds) && Number.isFinite(cue.endSeconds) && cue.endSeconds > cue.startSeconds && cue.text)
}

function validateSemanticReview(payload, cues) {
  const normalizedCues = normalizeReviewCues(cues)
  const byIndex = new Map(normalizedCues.map((cue) => [cue.cueIndex, cue]))
  const topicSummary = String(payload?.topicSummary || '').trim().slice(0, 300)
  if (!topicSummary) throw new Error('语义审阅缺少主旨摘要')
  const candidates = []
  for (const raw of (Array.isArray(payload?.candidates) ? payload.candidates : []).slice(0, MAX_REVIEW_CANDIDATES)) {
    let type = raw?.type === 'near_duplicate' ? 'near_duplicate' : raw?.type === 'off_topic' ? 'off_topic' : ''
    const confidence = Number(raw?.confidence)
    if (!type || !Number.isFinite(confidence) || confidence < MIN_SEMANTIC_CONFIDENCE || confidence > 1) continue
    const cueIndexes = [...new Set((Array.isArray(raw.cueIndexes) ? raw.cueIndexes : []).map(Number).filter((item) => byIndex.has(item)))]
    const removeCueIndexes = [...new Set((Array.isArray(raw.removeCueIndexes) ? raw.removeCueIndexes : []).map(Number).filter((item) => cueIndexes.includes(item)))]
    const normalizedTexts = cueIndexes.map((cueIndex) => byIndex.get(cueIndex).text.toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—-]+/g, ''))
    const hasExactDuplicate = normalizedTexts.some((text, index) => normalizedTexts.indexOf(text) !== index)
    if (type === 'off_topic' && hasExactDuplicate) type = 'near_duplicate'
    let characterSimilarity = 0
    for (let left = 0; left < normalizedTexts.length; left += 1) {
      for (let right = left + 1; right < normalizedTexts.length; right += 1) {
        const leftSet = new Set(normalizedTexts[left]); const rightSet = new Set(normalizedTexts[right])
        const overlap = [...leftSet].filter((char) => rightSet.has(char)).length / Math.max(1, new Set([...leftSet, ...rightSet]).size)
        characterSimilarity = Math.max(characterSimilarity, overlap)
      }
    }
    if (type === 'near_duplicate' && !hasExactDuplicate && characterSimilarity < 0.35) continue
    if (type === 'near_duplicate' && cueIndexes.length < 2) throw new Error('语义近似重复候选至少需要两条字幕证据')
    if (type === 'off_topic' && cueIndexes.length < 1) throw new Error('跑题候选缺少字幕证据')
    if (!removeCueIndexes.length || (type === 'near_duplicate' && removeCueIndexes.length >= cueIndexes.length)) throw new Error('语义候选的删除条目不安全')
    const evidence = hasExactDuplicate
      ? cueIndexes.map((cueIndex) => ({ cueIndex, quote: byIndex.get(cueIndex).text }))
      : (Array.isArray(raw.evidence) ? raw.evidence : []).map((item) => ({ cueIndex: Number(item?.cueIndex), quote: String(item?.quote || '').trim().slice(0, 240) }))
    for (const cueIndex of cueIndexes) {
      const item = evidence.find((entry) => entry.cueIndex === cueIndex)
      const cue = byIndex.get(cueIndex)
      if (!item?.quote || !cue.text.includes(item.quote)) throw new Error(`第${cueIndex}条引句不在原字幕中`)
    }
    candidates.push({ type, cueIndexes, removeCueIndexes, confidence: Number(confidence.toFixed(3)), reason: String(raw.reason || '').trim().slice(0, 300), evidence })
  }
  const removeCount = new Set(candidates.flatMap((item) => item.removeCueIndexes)).size
  const maxRemoveCount = Math.max(1, Math.floor(normalizedCues.length * 0.35))
  if (removeCount > maxRemoveCount) throw new Error(`语义候选删除比例过高（${removeCount}/${normalizedCues.length}）`)
  return { topicSummary, candidates, cueCount: normalizedCues.length }
}

function buildSemanticReviewPrompt(cues) {
  const lines = normalizeReviewCues(cues).map((cue) => `[${cue.cueIndex}][${cue.startSeconds.toFixed(2)}-${cue.endSeconds.toFixed(2)}] ${cue.text}`)
  return [
    '分析下面完整字幕，找出两类可供用户审阅的候选：',
    '1. near_duplicate：相隔较远但表达同一事实、论点或信息的字幕；保留表达更完整的一条。',
    '2. off_topic：明显偏离视频主旨、删除后不破坏主线的字幕。',
    '不要把正常举例、必要铺垫、强调、承上启下或不同细节误判为重复/跑题。',
    `只接受置信度不低于${MIN_SEMANTIC_CONFIDENCE}的候选。只能引用以上字幕序号和原文中的连续引句，不能发明时间或文本。`,
    '只返回JSON：{"topicSummary":"主旨","candidates":[{"type":"near_duplicate|off_topic","cueIndexes":[1,2],"removeCueIndexes":[2],"confidence":0.9,"reason":"理由","evidence":[{"cueIndex":1,"quote":"原文引句"}]}]}',
    '',
    ...lines
  ].join('\n')
}

async function reviewSemanticTranscript({ cues, complete, model, signal } = {}) {
  if (typeof complete !== 'function') return { available: false, reason: '没有可用的语义审阅模型' }
  const systemPrompt = '你是专业视频文字剪辑审阅器。你只能提出有原字幕证据的候选，不执行剪辑，不猜测不存在的信息。'
  const basePrompt = buildSemanticReviewPrompt(cues)
  let previousText = ''
  let previousError = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n\n上一版未通过合同：${String(previousError?.message || previousError).slice(0, 300)}\n只修正JSON语法、候选类型、序号和引句，不新增候选。上一版：\n${previousText.slice(0, 5000)}`
    const result = await complete({ systemPrompt, prompt, signal, timeoutMs: 120000, maxTokens: 2200 })
    previousText = String(result?.text || '')
    try {
      const validated = validateSemanticReview(parseSemanticReviewJson(previousText), cues)
      return { available: true, ...validated, model: { providerId: String(model?.providerId || ''), providerName: String(model?.providerName || ''), model: String(model?.model || ''), local: Boolean(model?.local) } }
    } catch (error) {
      previousError = error
      if (attempt === 2) throw error
    }
  }
  throw previousError
}

module.exports = { MAX_REVIEW_CANDIDATES, MAX_REVIEW_CUES, MIN_SEMANTIC_CONFIDENCE, buildSemanticReviewPrompt, parseSemanticReviewJson, reviewSemanticTranscript, validateSemanticReview }
