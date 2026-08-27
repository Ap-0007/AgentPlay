const test = require('node:test')
const assert = require('node:assert/strict')
const { parseSemanticReviewJson, reviewSemanticTranscript, validateSemanticReview } = require('../electron/semantic-transcript-review')

const cues = [
  { cueIndex: 1, startSeconds: 0.5, endSeconds: 2, text: '这款产品的价格是一百元' },
  { cueIndex: 2, startSeconds: 2.2, endSeconds: 3.8, text: '这款产品卖一百块钱' },
  { cueIndex: 3, startSeconds: 4, endSeconds: 5.5, text: '顺便说我昨晚吃了火锅' },
  { cueIndex: 4, startSeconds: 5.7, endSeconds: 7, text: '接下来介绍产品功能' },
  { cueIndex: 5, startSeconds: 7.2, endSeconds: 8.5, text: '第一个功能是自动字幕' },
  { cueIndex: 6, startSeconds: 8.7, endSeconds: 10, text: '最后总结产品价值' }
]

const payload = {
  topicSummary: '产品价格、功能与价值介绍',
  candidates: [
    { type: 'near_duplicate', cueIndexes: [1, 2], removeCueIndexes: [2], confidence: 0.94, reason: '两句表达相同价格信息', evidence: [{ cueIndex: 1, quote: '价格是一百元' }, { cueIndex: 2, quote: '卖一百块钱' }] },
    { type: 'off_topic', cueIndexes: [3], removeCueIndexes: [3], confidence: 0.96, reason: '与产品介绍主题无关', evidence: [{ cueIndex: 3, quote: '昨晚吃了火锅' }] }
  ]
}

test('semantic review accepts only cited high-confidence model candidates', () => {
  assert.deepEqual(parseSemanticReviewJson(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``), payload)
  const result = validateSemanticReview(payload, cues)
  assert.equal(result.candidates.length, 2)
  assert.deepEqual(result.candidates.flatMap((item) => item.removeCueIndexes), [2, 3])
})

test('semantic review rejects forged quotes and excessive deletion scope', () => {
  const forged = structuredClone(payload)
  forged.candidates[1].evidence[0].quote = '字幕中不存在的句子'
  assert.throws(() => validateSemanticReview(forged, cues), /引句不在原字幕/)
  const excessive = structuredClone(payload)
  excessive.candidates = [{ type: 'off_topic', cueIndexes: [2, 3, 4], removeCueIndexes: [2, 3, 4], confidence: 0.99, reason: '全部跑题', evidence: [2, 3, 4].map((cueIndex) => ({ cueIndex, quote: cues[cueIndex - 1].text })) }]
  assert.throws(() => validateSemanticReview(excessive, cues), /候选删除比例过高/)
})

test('model reviewer receives numbered evidence and returns frozen model identity', async () => {
  let prompt = ''
  const result = await reviewSemanticTranscript({
    cues,
    model: { providerId: 'vllm', providerName: '本机模型', model: 'semantic-reviewer', local: true },
    complete: async (input) => { prompt = input.prompt; return { text: JSON.stringify(payload) } }
  })
  assert.match(prompt, /\[1\]\[0\.50-2\.00\]/)
  assert.match(prompt, /只能引用以上字幕序号/)
  assert.equal(result.model.model, 'semantic-reviewer')
  assert.equal(result.candidates.length, 2)
})

test('semantic review repairs decorative quote JSON and normalizes exact duplicates mislabelled off-topic', () => {
  const quoted = '```json\n{"topicSummary":"主题","candidates":[{"type":"off_topic","cueIndexes":[1,2],"removeCueIndexes":[2],"confidence":0.95,"reason":"重复","evidence":[{"cueIndex":1,"quote":""价格是一百元"},{"cueIndex":2,"quote":""价格是一百元"}]}]}\n```'
  const parsed = parseSemanticReviewJson(quoted)
  const result = validateSemanticReview(parsed, [
    { cueIndex: 1, startSeconds: 0, endSeconds: 1, text: '“价格是一百元”' },
    { cueIndex: 2, startSeconds: 1, endSeconds: 2, text: '“价格是一百元”' },
    { cueIndex: 3, startSeconds: 2, endSeconds: 3, text: '其他内容' }
  ])
  assert.equal(result.candidates[0].type, 'near_duplicate')
})

test('adjacent non-identical cues are treated as continuation, not semantic duplication', () => {
  const result = validateSemanticReview({ topicSummary: '产品介绍', candidates: [{ type: 'near_duplicate', cueIndexes: [1, 2], removeCueIndexes: [2], confidence: 0.95, reason: '相似', evidence: [{ cueIndex: 1, quote: 'API已经开放' }, { cueIndex: 2, quote: '权重下周开放' }] }] }, [
    { cueIndex: 1, startSeconds: 0, endSeconds: 1, text: 'API已经开放' },
    { cueIndex: 2, startSeconds: 1, endSeconds: 2, text: '权重下周开放' },
    { cueIndex: 3, startSeconds: 2, endSeconds: 3, text: '结束' }
  ])
  assert.equal(result.candidates.length, 0)
})

test('distant cues sharing one fact but adding a new conclusion lack enough lexical anchoring to delete', () => {
  const result = validateSemanticReview({ topicSummary: '数据争议', candidates: [{ type: 'near_duplicate', cueIndexes: [1, 3], removeCueIndexes: [3], confidence: 0.92, reason: '都提到200万', evidence: [{ cueIndex: 1, quote: '200万条音乐被抓取' }, { cueIndex: 3, quote: '200万只是开头' }] }] }, [
    { cueIndex: 1, startSeconds: 0, endSeconds: 1, text: '200万条音乐被抓取' },
    { cueIndex: 2, startSeconds: 1, endSeconds: 2, text: '中间解释过程' },
    { cueIndex: 3, startSeconds: 2, endSeconds: 3, text: '200万只是开头，后面还有更多证据' },
    { cueIndex: 4, startSeconds: 3, endSeconds: 4, text: '结束' }
  ])
  assert.equal(result.candidates.length, 0)
})

test('exact duplicates rebuild evidence from source cues instead of trusting a cross-cue quote', () => {
  const result = validateSemanticReview({ topicSummary: '访谈', candidates: [{ type: 'near_duplicate', cueIndexes: [1, 2], removeCueIndexes: [2], confidence: 0.95, reason: '重复', evidence: [{ cueIndex: 1, quote: '前一句拼接后的错误引句' }, { cueIndex: 2, quote: '另一个错误引句' }] }] }, [
    { cueIndex: 1, startSeconds: 0, endSeconds: 1, text: '完全相同的一句话' },
    { cueIndex: 2, startSeconds: 1, endSeconds: 2, text: '完全相同的一句话' },
    { cueIndex: 3, startSeconds: 2, endSeconds: 3, text: '结束' }
  ])
  assert.deepEqual(result.candidates[0].evidence, [{ cueIndex: 1, quote: '完全相同的一句话' }, { cueIndex: 2, quote: '完全相同的一句话' }])
})

test('semantic reviewer repairs one malformed model response and stops there', async () => {
  let calls = 0
  const result = await reviewSemanticTranscript({ cues, model: { model: 'agnes-2.5-flash' }, complete: async () => {
    calls += 1
    return calls === 1 ? { text: '{"topicSummary":"坏"引号","candidates":[]}' } : { text: JSON.stringify({ topicSummary: '产品介绍', candidates: [] }) }
  } })
  assert.equal(calls, 2)
  assert.equal(result.topicSummary, '产品介绍')
})
