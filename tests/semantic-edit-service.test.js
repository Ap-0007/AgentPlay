const test = require('node:test')
const assert = require('node:assert/strict')
const { SemanticEditService, analyzeTextCleanupCues, buildPauseRemovalDecision, buildTextCleanupDecision, matchesPauseEditInstruction, matchesTextCleanupInstruction, parseSilenceEvents, requestedMinimumSilence, standaloneFiller } = require('../electron/semantic-edit-service')
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

test('subtitle cleanup only removes standalone fillers and adjacent exact repetitions', () => {
  assert.equal(matchesTextCleanupInstruction('删掉口头禅和重复的话'), true)
  assert.equal(matchesTextCleanupInstruction('这句话里有然后怎么办？'), false)
  assert.equal(standaloneFiller('嗯。'), true)
  assert.equal(standaloneFiller('然后我们开始介绍产品'), false)
  const decision = buildTextCleanupDecision({
    instruction: '删掉口头禅和重复的话', sourcePath: 'D:\\video\\talk.mp4', subtitlePath: 'D:\\video\\talk.srt', durationSeconds: 8,
    cues: [
      { start: 0, end: 1, text: '欢迎大家' },
      { start: 1, end: 1.6, text: '嗯' },
      { start: 1.6, end: 3, text: '今天介绍产品' },
      { start: 3.2, end: 4.6, text: '今天介绍产品。' },
      { start: 4.8, end: 6.2, text: '然后我们介绍价格' },
      { start: 6.3, end: 8, text: '价格是一百元' }
    ]
  })
  assert.equal(decision.semanticCut.strategy, 'subtitle-cue-cleanup-v1')
  assert.deepEqual(decision.semanticCut.removed.map((item) => [item.cueIndex, item.reason, item.startSeconds, item.endSeconds]), [
    [2, '独立口头禅', 1.04, 1.56],
    [4, '相邻重复第3条', 3.24, 4.56]
  ])
  assert.equal(decision.timeline.segments.length, 3)
  assert.doesNotThrow(() => assertEditDecisionList(attachEditDecisionList(decision)))
})

test('subtitle cleanup plan uses the existing timed transcript once and never scans audio', async () => {
  let loads = 0
  let scans = 0
  const service = new SemanticEditService({
    frames: { availability: () => ({ available: true }), probeDuration: async () => 6, run: async () => { scans += 1 } },
    loadTranscript: async () => { loads += 1; return { path: 'D:\\video\\talk.srt', cues: [
      { start: 0, end: 1, text: '开场' }, { start: 1, end: 1.5, text: '呃' }, { start: 1.5, end: 3, text: '内容内容' }, { start: 3.1, end: 4.6, text: '内容内容' }, { start: 4.7, end: 6, text: '结尾' }
    ] } }
  })
  const result = await service.plan({ instruction: '去掉口头禅和重复内容', sourcePath: 'D:\\video\\talk.mp4' })
  assert.equal(result.matched, true)
  assert.equal(result.decision.semanticCut.removed.length, 2)
  assert.equal(loads, 1)
  assert.equal(scans, 0)
})

test('embedded fillers stay review-only while non-adjacent exact repeats require confirmation', () => {
  const cues = [
    { start: 0, end: 1.2, text: '欢迎大家' },
    { start: 1.3, end: 2.7, text: '就是，我们今天介绍产品' },
    { start: 2.8, end: 4, text: '核心结论有三点' },
    { start: 4.1, end: 6.5, text: '先说完全不同的例子' },
    { start: 7.4, end: 8.8, text: '核心结论有三点。' },
    { start: 8.9, end: 10, text: '谢谢大家' }
  ]
  const analysis = analyzeTextCleanupCues(cues, 10)
  assert.deepEqual(analysis.reviewOnly.map((item) => [item.cueIndex, item.reason, item.matches]), [
    [2, '句中疑似口头禅', ['就是']]
  ])
  assert.deepEqual(analysis.detected.map((item) => [item.cueIndex, item.reason]), [
    [5, '非紧邻完全重复第3条']
  ])
  const decision = buildTextCleanupDecision({
    instruction: '删掉口头禅和重复的话', sourcePath: 'D:\\video\\talk.mp4', subtitlePath: 'D:\\video\\talk.srt', durationSeconds: 10, cues, analysis
  })
  assert.equal(decision.semanticCut.confirmationRequired, true)
  assert.equal(decision.semanticCut.reviewOnly.length, 1)
  assert.equal(decision.semanticCut.removed[0].cueIndex, 5)
})

test('review-only embedded filler returns located evidence without creating an executable EDL', async () => {
  const service = new SemanticEditService({
    frames: { availability: () => ({ available: true }), probeDuration: async () => 5 },
    loadTranscript: async () => ({ path: 'D:\\video\\talk.srt', cues: [
      { start: 0, end: 1.4, text: '欢迎大家' },
      { start: 1.5, end: 3.2, text: '就是，我们开始介绍产品' },
      { start: 3.3, end: 5, text: '今天只讲价格' }
    ] })
  })
  const result = await service.plan({ instruction: '删掉口头禅和重复的话', sourcePath: 'D:\\video\\talk.mp4' })
  assert.equal(result.matched, true)
  assert.equal(result.decision, undefined)
  assert.match(result.review.summary, /第2条.*1\.50–3\.20秒.*就是/)
  assert.match(result.review.summary, /没有逐词时间戳.*不会删除整句/)
})
