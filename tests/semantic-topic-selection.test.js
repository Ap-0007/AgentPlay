const test = require('node:test')
const assert = require('node:assert/strict')

const { reviewTopicSelection, validateTopicSelection } = require('../electron/semantic-transcript-review')

const cues = [
  { cueIndex: 1, startSeconds: 0, endSeconds: 1.8, text: '先介绍产品定位' },
  { cueIndex: 2, startSeconds: 2, endSeconds: 3.6, text: '基础版价格是一百元' },
  { cueIndex: 3, startSeconds: 3.8, endSeconds: 5.2, text: '专业版每月三百元' },
  { cueIndex: 4, startSeconds: 5.4, endSeconds: 7, text: '接下来演示自动字幕' },
  { cueIndex: 5, startSeconds: 7.2, endSeconds: 8.6, text: '最后总结产品价值' }
]

const payload = {
  topic: '产品价格', confidence: 0.94, selectedCueIndexes: [2, 3], reason: '两条字幕直接说明不同版本价格',
  evidence: [{ cueIndex: 2, quote: '基础版价格是一百元' }, { cueIndex: 3, quote: '专业版每月三百元' }]
}

test('topic selection accepts only high-confidence cited cues for the requested topic', () => {
  const result = validateTopicSelection(payload, cues, '产品价格')
  assert.equal(result.topic, '产品价格')
  assert.deepEqual(result.selectedCueIndexes, [2, 3])
  assert.equal(result.confidence, 0.94)
})

test('topic selection rejects a changed topic, forged quote, whole-video selection and fragmented spam', () => {
  assert.throws(() => validateTopicSelection({ ...payload, topic: '产品功能' }, cues, '产品价格'), /主题不一致/)
  assert.throws(() => validateTopicSelection({ ...payload, evidence: [{ cueIndex: 2, quote: '字幕里不存在' }, payload.evidence[1]] }, cues, '产品价格'), /引句不在原字幕/)
  assert.throws(() => validateTopicSelection({ ...payload, selectedCueIndexes: [1, 2, 3, 4, 5], evidence: cues.map((cue) => ({ cueIndex: cue.cueIndex, quote: cue.text })) }, cues, '产品价格'), /整段都匹配/)
  const scattered = Array.from({ length: 13 }, (_, index) => ({ cueIndex: index + 1, startSeconds: index, endSeconds: index + 0.5, text: `价格证据${index + 1}` }))
  assert.throws(() => validateTopicSelection({ topic: '价格', confidence: 0.99, selectedCueIndexes: scattered.map((cue) => cue.cueIndex), reason: '过多', evidence: scattered.map((cue) => ({ cueIndex: cue.cueIndex, quote: cue.text })) }, scattered, '价格'), /超过12条/)
})

test('topic selector sends numbered evidence, repairs once and freezes model identity', async () => {
  let calls = 0
  let firstPrompt = ''
  const result = await reviewTopicSelection({
    cues, requestedTopic: '产品价格', model: { providerId: 'agnes', providerName: 'Agnes', model: 'agnes-2.5-flash', local: false },
    complete: async (input) => { calls += 1; if (calls === 1) { firstPrompt = input.prompt; return { text: '{坏JSON' } }; return { text: JSON.stringify(payload) } }
  })
  assert.equal(calls, 2)
  assert.match(firstPrompt, /只选择直接回答“产品价格”的字幕/)
  assert.match(firstPrompt, /\[2\]\[2\.00-3\.60\]/)
  assert.equal(result.model.model, 'agnes-2.5-flash')
  assert.deepEqual(result.selectedCueIndexes, [2, 3])
})

test('an empty first topic result gets one bounded cross-language recheck', async () => {
  let calls = 0
  const result = await reviewTopicSelection({ cues, requestedTopic: '产品价格', model: { model: 'reviewer' }, complete: async () => {
    calls += 1
    return { text: JSON.stringify(calls === 1 ? { topic: '产品价格', confidence: 0, selectedCueIndexes: [], reason: '未找到', evidence: [] } : payload) }
  } })
  assert.equal(calls, 2)
  assert.deepEqual(result.selectedCueIndexes, [2, 3])
})

test('an exact topic phrase in subtitles uses deterministic evidence without spending a model call', async () => {
  let calls = 0
  const result = await reviewTopicSelection({ cues: [{ cueIndex: 1, startSeconds: 0, endSeconds: 1, text: '背景' }, { cueIndex: 2, startSeconds: 1, endSeconds: 2, text: 'good cause to ask why science works' }], requestedTopic: 'why science works', model: { model: 'reviewer' }, complete: async () => { calls += 1; return { text: '{}' } } })
  assert.equal(calls, 0)
  assert.equal(result.deterministicExact, true)
  assert.deepEqual(result.selectedCueIndexes, [2])
})
