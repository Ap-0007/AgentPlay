const test = require('node:test')
const assert = require('node:assert/strict')

const { compileVisualEffectDecision, matchesVisualEffectInstruction } = require('../electron/visual-effect-decision')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')

test('visual effect intent is explicit while consultations and ordinary trim stay out', () => {
  assert.equal(matchesVisualEffectInstruction('裁成9:16，放大1.15倍，亮度提高10%'), true)
  assert.equal(matchesVisualEffectInstruction('能不能做画中画？'), false)
  assert.equal(matchesVisualEffectInstruction('保留第4秒到第20秒'), false)
})

test('one natural-language instruction freezes crop, scale, motion, mask, blur and color effects', () => {
  const result = compileVisualEffectDecision({ instruction: '裁成9:16，放大1.15倍，做一个缓慢推近的关键帧运动，第2秒到第5秒右上角加遮罩并强模糊，亮度提高10%，对比度提高20%，饱和度降低15%', sourcePath: 'D:\\video\\talk.mp4' })
  assert.equal(result.matched, true)
  assert.deepEqual(result.decision.effects.map((item) => item.type), ['crop', 'scale', 'motion', 'mask', 'blur', 'color'])
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'crop'), { type: 'crop', aspect: '9:16' })
  assert.equal(result.decision.effects.find((item) => item.type === 'scale').factor, 1.15)
  assert.equal(result.decision.effects.find((item) => item.type === 'motion').kind, 'zoom-in')
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'mask').timeRange, { startSeconds: 2, endSeconds: 5 })
  assert.equal(result.decision.effects.find((item) => item.type === 'blur').strength, 12)
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'color'), { type: 'color', brightness: 0.1, contrast: 1.2, saturation: 0.85, temperature: 0 })
  const frozen = attachEditDecisionList(result.decision)
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
  frozen.effects[1].factor = 2
  assert.throws(() => assertEditDecisionList(frozen), /EDL 与冻结决策不一致/)
})

test('picture-in-picture and transition require their material and time instead of guessing', () => {
  const pipMissing = compileVisualEffectDecision({ instruction: '加一个右上角画中画', sourcePath: 'D:\\video\\talk.mp4' })
  assert.match(pipMissing.review.summary, /画中画素材路径/)
  const transitionMissing = compileVisualEffectDecision({ instruction: '加一个淡化转场', sourcePath: 'D:\\video\\talk.mp4' })
  assert.match(transitionMissing.review.summary, /转场发生在第几秒/)
  const result = compileVisualEffectDecision({ instruction: '把 D:\\video\\demo.mp4 作为右上角画中画，占画面25%，第2秒到第8秒显示；在第10秒加0.6秒叠化转场', sourcePath: 'D:\\video\\talk.mp4' })
  assert.equal(result.decision.effects.find((item) => item.type === 'pip').path, 'D:\\video\\demo.mp4')
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'pip').timeRange, { startSeconds: 2, endSeconds: 8 })
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'transition'), { type: 'transition', kind: 'fade', atSeconds: 10, durationSeconds: 0.6 })
})

test('each effect keeps the time range from its own clause', () => {
  const result = compileVisualEffectDecision({
    instruction: '把 D:\\video\\demo.mp4 作为右上角画中画，占画面25%，第1秒到第5秒显示；做缓慢推近关键帧；第2秒到第4秒左下角加遮罩并强模糊',
    sourcePath: 'D:\\video\\talk.mp4'
  })
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'pip').timeRange, { startSeconds: 1, endSeconds: 5 })
  assert.equal(result.decision.effects.find((item) => item.type === 'motion').timeRange, undefined)
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'mask').timeRange, { startSeconds: 2, endSeconds: 4 })
  assert.deepEqual(result.decision.effects.find((item) => item.type === 'blur').timeRange, { startSeconds: 2, endSeconds: 4 })
})
