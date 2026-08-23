const test = require('node:test')
const assert = require('node:assert/strict')
const { candidateFrameMoments, reviewSemanticCandidateVisuals, validateVisualReview } = require('../electron/semantic-visual-review')

const cues = [
  { cueIndex: 1, startSeconds: 0.5, endSeconds: 1.6, text: '开场' },
  { cueIndex: 2, startSeconds: 1.8, endSeconds: 3, text: '价格是一百元' },
  { cueIndex: 3, startSeconds: 3.2, endSeconds: 4.4, text: '卖一百块钱' },
  { cueIndex: 4, startSeconds: 4.6, endSeconds: 5.8, text: '昨晚吃了火锅' },
  { cueIndex: 5, startSeconds: 6, endSeconds: 7.4, text: '继续介绍功能' },
  { cueIndex: 6, startSeconds: 7.6, endSeconds: 9, text: '总结' }
]
const review = { candidates: [
  { type: 'near_duplicate', cueIndexes: [2, 3], removeCueIndexes: [3], confidence: 0.94, reason: '价格重复', evidence: [] },
  { type: 'off_topic', cueIndexes: [4], removeCueIndexes: [4], confidence: 0.96, reason: '跑题', evidence: [] }
] }

test('candidate visual moments freeze before, middle and after frames for each proposal', () => {
  const moments = candidateFrameMoments({ cues, candidates: review.candidates, durationSeconds: 10 })
  assert.deepEqual(moments.map((item) => [item.label, item.seconds]), [
    ['candidate-1-before', 2.95], ['candidate-1-middle', 3.8], ['candidate-1-after', 4.65],
    ['candidate-2-before', 4.35], ['candidate-2-middle', 5.2], ['candidate-2-after', 6.05]
  ])
})

test('visual reviewer accepts only high-confidence safe verdicts citing all three candidate frames', async () => {
  let images = []
  const result = await reviewSemanticCandidateVisuals({
    sourcePath: 'D:\\video\\talk.mp4', cues, review, durationSeconds: 10,
    model: { providerId: 'agnes', providerName: 'Agnes AI', model: 'agnes-2.0-flash', local: false },
    readFrame: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    completeVisionMulti: async (input) => { images = input.images; return { text: JSON.stringify({ validations: [
      { candidateIndex: 1, verdict: 'safe', confidence: 0.93, reason: '前后场景连续且中间无独有演示', evidenceLabels: ['candidate-1-before', 'candidate-1-middle', 'candidate-1-after'] },
      { candidateIndex: 2, verdict: 'unsafe', confidence: 0.95, reason: '候选中出现独有产品操作', evidenceLabels: ['candidate-2-before', 'candidate-2-middle', 'candidate-2-after'] }
    ] }) } }
  })
  assert.equal(images.length, 6)
  assert.deepEqual(result.safeCandidateIndexes, [1])
  assert.deepEqual(result.blockedCandidateIndexes, [2])
  assert.equal(result.model.model, 'agnes-2.0-flash')
})

test('a safe verdict missing one frame label fails closed', () => {
  const moments = candidateFrameMoments({ cues, candidates: review.candidates, durationSeconds: 10 })
  assert.throws(() => validateVisualReview({ validations: [{ candidateIndex: 1, verdict: 'safe', confidence: 0.99, reason: '安全', evidenceLabels: ['candidate-1-before', 'candidate-1-after'] }] }, moments, review.candidates), /必须引用候选前中后三帧/)
})
