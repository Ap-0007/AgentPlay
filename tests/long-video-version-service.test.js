const test = require('node:test')
const assert = require('node:assert/strict')

const { assertLongVideoVersionPlan, compileLongVideoVersionBundle, freezeLongVideoVersionPlan, matchesLongVersionInstruction, planLongVideoVersions, validateLongVideoPlan } = require('../electron/long-video-version-service')
const { SemanticEditService } = require('../electron/semantic-edit-service')

const cues = Array.from({ length: 12 }, (_, index) => ({ cueIndex: index + 1, startSeconds: index * 10, endSeconds: (index + 1) * 10, text: `第${index + 1}段真实字幕内容` }))
const evidence = (indexes) => indexes.map((cueIndex) => ({ cueIndex, quote: cues[cueIndex - 1].text }))
const payload = {
  summary: '产品从问题、方案到案例的完整讲解',
  chapters: [
    { title: '问题背景', startCueIndex: 1, endCueIndex: 4, importance: 0.8, reason: '交代问题', evidence: evidence([1, 4]) },
    { title: '解决方案', startCueIndex: 5, endCueIndex: 8, importance: 0.95, reason: '核心方案', evidence: evidence([5, 8]) },
    { title: '案例总结', startCueIndex: 9, endCueIndex: 12, importance: 0.9, reason: '案例与结论', evidence: evidence([9, 12]) }
  ],
  highlights: [
    { startCueIndex: 2, endCueIndex: 3, importance: 0.98, reason: '关键问题', evidence: evidence([2, 3]) },
    { startCueIndex: 6, endCueIndex: 7, importance: 0.96, reason: '核心方案', evidence: evidence([6, 7]) },
    { startCueIndex: 10, endCueIndex: 11, importance: 0.9, reason: '案例结论', evidence: evidence([10, 11]) }
  ]
}

test('long-version intent is explicit and consultation stays non-executing', () => {
  assert.equal(matchesLongVersionInstruction('把这个长视频做成短版、精华版、章节版和平台时长版本'), true)
  assert.equal(matchesLongVersionInstruction('生成15秒、30秒和60秒平台版'), true)
  assert.equal(matchesLongVersionInstruction('能不能做成长视频精华版？'), false)
  assert.equal(matchesLongVersionInstruction('这个视频太长了'), false)
})

test('model plan requires full ordered chapter coverage and exact cited highlights', () => {
  const result = validateLongVideoPlan(payload, cues)
  assert.equal(result.chapters.length, 3)
  assert.equal(result.highlights.length, 3)
  const forged = structuredClone(payload); forged.highlights[0].evidence[0].quote = '伪造引句'
  assert.throws(() => validateLongVideoPlan(forged, cues), /引句不在原字幕/)
  const gap = structuredClone(payload); gap.chapters[1].startCueIndex = 6; gap.chapters[1].evidence = evidence([6, 8])
  assert.throws(() => validateLongVideoPlan(gap, cues), /章节必须连续覆盖/)
})

test('one shared evidence plan compiles short, highlight, platform and chapter outputs within budgets', () => {
  const reviewed = { available: true, ...validateLongVideoPlan(payload, cues), model: { providerId: 'agnes', providerName: 'Agnes', model: 'agnes-2.5-flash', local: false } }
  const bundle = compileLongVideoVersionBundle({ instruction: '生成短版、精华版、章节版和平台版本', sourcePath: 'D:\\video\\long.mp4', subtitlePath: 'D:\\video\\long.srt', durationSeconds: 120, cues, reviewed })
  assert.deepEqual(bundle.variants.map((item) => item.id), ['short-30', 'highlight-90', 'platform-15', 'platform-30', 'platform-60'])
  assert.equal(bundle.chapters.length, 3)
  for (const variant of bundle.variants) {
    assert.ok(variant.durationSeconds <= variant.targetSeconds + 0.001)
    assert.deepEqual([...variant.segments].sort((a, b) => a.sourceStartSeconds - b.sourceStartSeconds), variant.segments)
  }
  assert.equal(bundle.confirmationRequired, true)
  assert.equal(bundle.model.model, 'agnes-2.5-flash')
  const frozen = freezeLongVideoVersionPlan(bundle)
  assert.doesNotThrow(() => assertLongVideoVersionPlan(frozen))
  frozen.variants[0].targetSeconds += 1
  assert.throws(() => assertLongVideoVersionPlan(frozen), /方案已变化/)
})

test('long-version planner calls the working model once and freezes its identity', async () => {
  let calls = 0
  let prompt = ''
  const result = await planLongVideoVersions({ cues, model: { providerId: 'local', providerName: '本机', model: '8b', local: true }, complete: async (input) => { calls += 1; prompt = input.prompt; return { text: JSON.stringify(payload) } } })
  assert.equal(calls, 1)
  assert.match(prompt, /共享章节与高光证据/)
  assert.match(prompt, /\[12\]\[110\.00-120\.00\]/)
  assert.equal(result.model.model, '8b')
})

test('semantic edit entry returns a version plan instead of pretending it is one ordinary trim', async () => {
  const reviewed = { available: true, ...validateLongVideoPlan(payload, cues), model: { providerId: 'local', providerName: '本机', model: '8b', local: true } }
  const service = new SemanticEditService({
    frames: { availability: () => ({ available: true }), probeDuration: async () => 120 },
    loadTranscript: async () => ({ path: 'D:\\video\\long.srt', cues }),
    planLongVersions: async () => reviewed
  })
  const result = await service.plan({ instruction: '把这个长视频做成短版、精华版、章节版和平台版本', sourcePath: 'D:\\video\\long.mp4' })
  assert.equal(result.decision, undefined)
  assert.equal(result.versionPlan.strategy, 'shared-evidence-long-video-versions-v1')
  assert.equal(result.versionPlan.variants.length, 5)
  assert.equal(result.versionPlan.chapters.length, 3)
})
