const assert = require('node:assert/strict')
const test = require('node:test')

const { compileAudioRepairDecisionList, planEditInstruction } = require('../electron/media-edit-decision')
const { assertEditDecisionList, attachEditDecisionList } = require('../electron/edit-decision-list')

const SOURCE = 'D:/Videos/source.mp4'
const INSTRUCTION = '给音频降噪、去直流、静音修复，响度匹配到-16 LUFS，再分离人声和伴奏'

test('C2 enters the unified planner and freezes five operations plus three expected outputs', () => {
  const planned = planEditInstruction({ instruction: INSTRUCTION, sourcePath: SOURCE })
  assert.equal(planned.matched, true)
  const decision = attachEditDecisionList(planned.decision)
  assert.equal(decision.kind, 'media.repair-audio')
  assert.deepEqual(decision.edl.operations.map((item) => item.type), ['audio-denoise', 'audio-dcRemoval', 'audio-loudness', 'audio-silenceRepair', 'audio-separation'])
  assert.deepEqual(decision.edl.quality.expectedOutputs, ['video', 'voice', 'accompaniment'])
  assert.doesNotThrow(() => assertEditDecisionList(decision))
  const tampered = structuredClone(decision)
  tampered.audioRepair.silenceRepair.maximumGapSeconds = 1
  assert.throws(() => assertEditDecisionList(tampered), /EDL 与冻结决策不一致/)
})

test('C2 subset decision keeps only requested operations', () => {
  const decision = attachEditDecisionList(compileAudioRepairDecisionList({ sourcePath: SOURCE, instruction: '给音频降噪并响度匹配到-18 LUFS' }))
  assert.deepEqual(decision.edl.operations.map((item) => item.type), ['audio-denoise', 'audio-loudness'])
  assert.deepEqual(decision.edl.quality.expectedOutputs, ['video'])
})
