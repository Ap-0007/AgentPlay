const test = require('node:test')
const assert = require('node:assert/strict')

const { buildStyleShotPrompt, compileStyleBlueprint, extractProtectedFragments, validateStyleShots } = require('../electron/style-reuse-service')

const report = `# 拉片报告
00:00–00:02 中景，固定，冷色，高对比，居中构图。
00:02–00:05 近景，缓慢推镜，暖色，侧光，三分构图。
00:05–00:09 特写，跟拍，低饱和，逆光。
原片人物叫 Lindy，品牌为 AcmeAI，口播原句“Building the most comprehensive profile”。画面出现 AcmeAI Logo。`

test('style blueprint keeps only abstract rhythm and visual grammar', () => {
  const blueprint = compileStyleBlueprint(report, { count: 3 })
  assert.equal(blueprint.strategy, 'abstract-style-blueprint-v1')
  assert.deepEqual(blueprint.rhythm.durations, [2, 3, 4])
  assert.deepEqual(blueprint.shotSizes.slice(0, 3), ['中景', '近景', '特写'])
  assert.deepEqual(blueprint.movements.slice(0, 3), ['固定', '推', '跟'])
  assert.ok(blueprint.visual.palette.includes('冷色'))
  assert.equal(JSON.stringify(blueprint).includes('Lindy'), false)
  assert.equal(JSON.stringify(blueprint).includes('AcmeAI'), false)
  assert.equal(JSON.stringify(blueprint).includes('Building the most'), false)
  assert.match(blueprint.sourceReportSha256, /^[a-f0-9]{64}$/)
})

test('shot model prompt receives the abstract blueprint but not the report', () => {
  const blueprint = compileStyleBlueprint(report, { count: 3 })
  const prompt = buildStyleShotPrompt({ blueprint, originalGoal: '拍一条介绍社区图书交换的原创短片', count: 3 })
  assert.match(prompt, /社区图书交换/)
  assert.match(prompt, /abstract-style-blueprint-v1/)
  assert.doesNotMatch(prompt, /Lindy|AcmeAI|Building the most/)
  assert.match(prompt, /禁止逐帧复制/)
})

test('validated shots match structural grammar and reject protected expression', () => {
  const blueprint = compileStyleBlueprint(report, { count: 3 })
  const protectedFragments = extractProtectedFragments(report, '参考视频')
  const valid = [
    { prompt: '清晨社区门口，居民把读完的书放上共享木架，冷色高对比自然光', duration: 2, shotSize: '中景', movement: '固定', originalityDeclaration: '原创重构，不复制原片专有表达' },
    { prompt: '年轻人翻开交换登记册并贴上手写编号，暖色侧光，画面按三分法安排', duration: 3, shotSize: '近景', movement: '推', originalityDeclaration: '原创重构，不复制原片专有表达' },
    { prompt: '一本旧书交到新读者手中，逆光下突出书脊与双方动作，低饱和质感', duration: 4, shotSize: '特写', movement: '跟', originalityDeclaration: '原创重构，不复制原片专有表达' }
  ]
  const result = validateStyleShots(valid, { blueprint, protectedFragments, count: 3 })
  assert.equal(result.shots.length, 3)
  assert.equal(result.receipt.rawReportSentToShotModel, false)
  assert.equal(result.receipt.referenceImagesSent, 0)
  assert.equal(result.receipt.structureMatched, true)
  assert.throws(() => validateStyleShots(valid.map((item, index) => index === 1 ? { ...item, prompt: '逐帧复刻 AcmeAI Logo 和 Lindy 的原片构图' } : item), { blueprint, protectedFragments, count: 3 }), /版权|专有|复制/)
})
