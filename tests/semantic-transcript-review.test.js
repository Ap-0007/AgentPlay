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
