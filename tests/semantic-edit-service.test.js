const test = require('node:test')
const assert = require('node:assert/strict')
const { SemanticEditService, buildPauseRemovalDecision, matchesPauseEditInstruction, parseSilenceEvents, requestedMinimumSilence } = require('../electron/semantic-edit-service')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')

test('semantic pause intent is narrow and the requested threshold is bounded', () => {
  assert.equal(matchesPauseEditInstruction('帮我删掉长停顿'), true)
  assert.equal(matchesPauseEditInstruction('删除超过1.2秒的静音'), true)
  assert.equal(matchesPauseEditInstruction('删除第4秒到第8秒'), false)
  assert.equal(matchesPauseEditInstruction('这个停顿怎么处理？'), false)
  assert.equal(requestedMinimumSilence('删除超过1.2秒的静音'), 1.2)
  assert.equal(requestedMinimumSilence('删掉停顿'), 0.9)
  assert.equal(requestedMinimumSilence('删除超过0.1秒的停顿'), 0.5)
})

test('ffmpeg silencedetect output becomes exact evidence ranges', () => {
  const parsed = parseSilenceEvents(`
[silencedetect @ 0001] silence_start: 2.000
[silencedetect @ 0001] silence_end: 3.400 | silence_duration: 1.400
[silencedetect @ 0001] silence_start: 6
[silencedetect @ 0001] silence_end: 7.5 | silence_duration: 1.5`)
  assert.deepEqual(parsed, [
    { startSeconds: 2, endSeconds: 3.4, durationSeconds: 1.4 },
    { startSeconds: 6, endSeconds: 7.5, durationSeconds: 1.5 }
  ])
})

test('pause removal plan preserves breathing room and compiles a continuous retained timeline', () => {
  const decision = buildPauseRemovalDecision({
    instruction: '删掉超过1秒的长停顿', sourcePath: 'D:\\video\\talk.mp4', durationSeconds: 10,
    minimumSilenceSeconds: 1,
    silences: [
      { startSeconds: 0, endSeconds: 1.2, durationSeconds: 1.2 },
      { startSeconds: 2, endSeconds: 3.4, durationSeconds: 1.4 },
      { startSeconds: 6, endSeconds: 7.5, durationSeconds: 1.5 },
      { startSeconds: 9.3, endSeconds: 10, durationSeconds: 0.7 }
    ]
  })
  assert.equal(decision.kind, 'media.concat-segments')
  assert.equal(decision.source.name, 'talk.mp4')
  assert.deepEqual(decision.semanticCut.removed.map((item) => [item.startSeconds, item.endSeconds]), [[2.12, 3.28], [6.12, 7.38]])
  assert.deepEqual(decision.timeline.segments.map((item) => [item.sourceStartSeconds, item.sourceEndSeconds, item.targetStartSeconds, item.targetEndSeconds]), [
    [0, 2.12, 0, 2.12], [3.28, 6.12, 2.12, 4.96], [7.38, 10, 4.96, 7.58]
  ])
  assert.equal(decision.semanticCut.totalRemovedSeconds, 2.42)
  assert.equal(decision.timeline.durationSeconds, 7.58)
  assert.equal(decision.output.overwrite, false)
  const frozen = attachEditDecisionList(decision)
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
  assert.equal(frozen.edl.quality.semanticEvidence.removedCount, 2)
})

test('semantic service performs one audio scan and returns a frozen plan', async () => {
  const calls = []
  const service = new SemanticEditService({ frames: {
    availability: () => ({ available: true }),
    probeHasAudio: async () => true,
    probeDuration: async () => 8,
    run: async (args) => { calls.push(args); return { stderr: 'silence_start: 2\nsilence_end: 3.2 | silence_duration: 1.2' } }
  } })
  const result = await service.plan({ instruction: '自动剪掉停顿', sourcePath: 'C:\\media\\a.mp4' })
  assert.equal(result.matched, true)
  assert.equal(result.decision.semanticCut.removed.length, 1)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].some((item) => String(item).includes('silencedetect=noise=-35dB')))
})
