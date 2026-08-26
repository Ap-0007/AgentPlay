const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileSubtitleTransformDecision } = require('../electron/subtitle-transform-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const SOURCE_VIDEO = 'D:\\Videos\\demo.mp4'
const SUBTITLE = 'D:\\Videos\\demo.srt'
const FULL_INSTRUCTION = `批量处理字幕 ${SUBTITLE}：第1条改成《Welcome to AgentPlay》；合并第2到第3条；第4条在8.2秒拆成《Edit faster｜Create better》；整体提前0.5秒；翻译成中文；风格改成强调`

function decision(instruction = FULL_INSTRUCTION, subtitle = SUBTITLE) {
  const result = compileSubtitleTransformDecision({ instruction, sourcePath: SOURCE_VIDEO })
  assert.equal(result.matched, true)
  assert.ok(result.decision)
  if (subtitle !== SUBTITLE) result.decision.subtitle.path = subtitle
  return attachEditDecisionList(result.decision)
}

function srtFixture() {
  return [
    '1\n00:00:00,500 --> 00:00:02,000\nHello everyone',
    '2\n00:00:02,500 --> 00:00:04,000\nProduct overview',
    '3\n00:00:04,200 --> 00:00:06,000\nPricing details',
    '4\n00:00:06,500 --> 00:00:10,000\nEdit faster and create better',
    '5\n00:00:10,200 --> 00:00:12,000\nThanks for watching'
  ].join('\n\n') + '\n'
}

function fakeChineseEngine() {
  return {
    label: 'D3本机测试翻译',
    complete: async ({ prompt }) => {
      const start = prompt.indexOf('{"items"')
      const payload = JSON.parse(prompt.slice(start))
      return { text: JSON.stringify({ translations: payload.items.map((item) => ({ i: item.i, text: `中文${item.i}` })) }) }
    }
  }
}

test('D3 freezes replace, merge, exact split, shift, language and style in one decision', () => {
  const frozen = decision()
  assert.equal(frozen.kind, 'media.transform-subtitles')
  assert.equal(frozen.subtitleTransform.strategy, 'ordered-subtitle-transform-v1')
  assert.deepEqual(frozen.subtitleTransform.replacements, [{ index: 1, text: 'Welcome to AgentPlay' }])
  assert.deepEqual(frozen.subtitleTransform.merges, [{ startIndex: 2, endIndex: 3, separator: ' ' }])
  assert.deepEqual(frozen.subtitleTransform.splits, [{ index: 4, atSeconds: 8.2, parts: ['Edit faster', 'Create better'] }])
  assert.deepEqual(frozen.subtitleTransform.shift, { direction: 'earlier', offsetSeconds: 0.5 })
  assert.deepEqual(frozen.subtitleTransform.translate, { targetLang: '中文', mode: 'translated' })
  assert.equal(frozen.subtitleTransform.style.preset, 'impact')
  assert.equal(frozen.output.container, 'ass')
  assert.deepEqual(frozen.verification.expectedOperationKinds, ['replace', 'merge', 'split', 'shift', 'translate', 'style'])
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
})

test('D3 supports multiple replacements but refuses guessed split timing and consultation', () => {
  const batch = compileSubtitleTransformDecision({ instruction: `批量处理字幕 ${SUBTITLE}：第1条改成《甲》；第3条改成《乙》`, sourcePath: SOURCE_VIDEO })
  assert.deepEqual(batch.decision.subtitleTransform.replacements, [{ index: 1, text: '甲' }, { index: 3, text: '乙' }])
  const missingTime = compileSubtitleTransformDecision({ instruction: `把字幕 ${SUBTITLE} 第4条拆成《前半｜后半》`, sourcePath: SOURCE_VIDEO })
  assert.equal(missingTime.matched, true)
  assert.equal(missingTime.decision, undefined)
  assert.match(missingTime.review.summary, /明确秒点.*不按字符比例/)
  assert.equal(compileSubtitleTransformDecision({ instruction: `能不能把字幕 ${SUBTITLE} 批量改一下？`, sourcePath: SOURCE_VIDEO }).matched, false)
})

test('D3 real batch transforms original-index structure, translates and writes styled ASS without touching source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-subtitle-transform-d3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'demo.srt'); const output = path.join(dir, 'demo-transform.ass'); fs.writeFileSync(source, srtFixture(), 'utf8')
  const before = fs.readFileSync(source)
  const frames = { availability: () => ({ available: true }) }
  const service = new MediaEditService({ frames })
  const frozen = decision(FULL_INSTRUCTION.replace(SUBTITLE, source), source)
  const result = await service.transformSubtitles({ sourcePath: source, outputPath: output, decision: frozen, engine: fakeChineseEngine() })
  assert.equal(result.success, true)
  assert.equal(result.transformProof.verdict, 'matched')
  assert.deepEqual(result.transformProof.operationKinds, ['replace', 'merge', 'split', 'shift', 'translate', 'style'])
  assert.equal(result.transformProof.sourceCueCount, 5)
  assert.equal(result.transformProof.outputCueCount, 5)
  assert.equal(result.transformProof.replacementsApplied, 1)
  assert.equal(result.transformProof.mergesApplied, 1)
  assert.equal(result.transformProof.splitsApplied, 1)
  assert.equal(result.transformProof.translation.targetLang, '中文')
  assert.equal(result.transformProof.style.preset, 'impact')
  const content = fs.readFileSync(output, 'utf8')
  assert.match(content, /\[V4\+ Styles\]/)
  assert.equal((content.match(/^Dialogue:/gm) || []).length, 5)
  assert.match(content, /中文1/)
  assert.deepEqual(fs.readFileSync(source), before)
})

test('D3 deterministic structure-only batch remains SRT and split uses the explicit second', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-subtitle-structure-d3-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'demo.srt'); const output = path.join(dir, 'demo-transform.srt'); fs.writeFileSync(source, srtFixture(), 'utf8')
  const instruction = `批量处理字幕 ${source}：合并第2到第3条；第4条在8.2秒拆成《Edit faster｜Create better》；整体提前0.5秒`
  const frozen = decision(instruction, source)
  const service = new MediaEditService({ frames: { availability: () => ({ available: true }) } })
  const result = await service.transformSubtitles({ sourcePath: source, outputPath: output, decision: frozen })
  assert.equal(result.outputCueCount, 5)
  const content = fs.readFileSync(output, 'utf8')
  assert.match(content, /00:00:06,000 --> 00:00:07,700\r?\nEdit faster/)
  assert.match(content, /00:00:07,700 --> 00:00:09,500\r?\nCreate better/)
})

test('D3 quality is 100 only when every frozen operation and final structure are proven', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-subtitle-transform-quality-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const output = path.join(dir, 'result.ass'); fs.writeFileSync(output, '[Script Info]\n[V4+ Styles]\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,Impact,,0,0,0,,中文\n')
  const frozen = decision('批量处理字幕 D:/Videos/demo.srt：第1条改成《甲》；合并第2到第3条；第4条在8.2秒拆成《前｜后》；整体提前0.5秒；翻译成中文；风格改成强调')
  const proof = { schemaVersion: 1, method: 'subtitle-transform-proof-v1', verdict: 'matched', operationKinds: ['replace', 'merge', 'split', 'shift', 'translate', 'style'], sourceCueCount: 5, outputCueCount: 5, replacementsApplied: 1, mergesApplied: 1, splitsApplied: 1, shift: { applied: true }, translation: { targetLang: '中文', matched: true }, style: { preset: 'impact', matched: true }, exactStructure: true }
  const result = { success: true, outputs: [output], outputPath: output, sourceCueCount: 5, outputCueCount: 5, transformProof: proof, projectCapsule: { schemaVersion: 1, projectId: 'edit-d3', currentPath: output, canUndo: true } }
  const passed = evaluateTaskResult('media.transform-subtitles', result, { decision: frozen })
  assert.equal(passed.score, 100); assert.equal(passed.passed, true)
  for (const id of ['transform-contract', 'transform-structure', 'transform-language', 'transform-style']) assert.ok(passed.checks.some((item) => item.id === id && item.passed), id)
  const failed = evaluateTaskResult('media.transform-subtitles', { ...result, transformProof: { ...proof, exactStructure: false } }, { decision: frozen })
  assert.equal(failed.passed, false)
  assert.ok(failed.reasons.some((item) => item.code === 'SUBTITLE_TRANSFORM_MISMATCH'))
})

test('D3 uses one persistent task, frozen translation route, conversation UI and packaged acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const media = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
  const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-subtitle-transform-d3.mjs'), 'utf8')
  assert.match(main, /registerGovernedMediaEdit\('media\.transform-subtitles'/)
  assert.match(main, /freezeTaskModelRoute/)
  assert.match(media, /transformSubtitles/)
  assert.match(quality, /SUBTITLE_TRANSFORM_MISMATCH/)
  assert.match(renderer, /批量字幕变换/)
  for (const marker of ['quality100', 'operationKinds', 'outputCueCount', 'translatedChinese', 'styledAss', 'sourceHashUnchanged']) assert.match(smoke, new RegExp(marker))
})
