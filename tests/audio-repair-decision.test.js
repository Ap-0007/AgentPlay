const assert = require('node:assert/strict')
const test = require('node:test')

const { compileAudioRepairDecisionList } = require('../electron/audio-repair-decision')

const SOURCE = 'D:/Videos/source.mp4'

test('C2 freezes every requested repair while keeping separation limitations explicit', () => {
  const decision = compileAudioRepairDecisionList({
    sourcePath: SOURCE,
    instruction: '给音频降噪、去直流、静音修复，响度匹配到-16 LUFS，再分离人声和伴奏'
  })
  assert.equal(decision.kind, 'media.repair-audio')
  assert.equal(decision.audioRepair.strategy, 'ffmpeg-audio-repair-v1')
  assert.equal(decision.audioRepair.denoise.enabled, true)
  assert.equal(decision.audioRepair.dcRemoval.enabled, true)
  assert.equal(decision.audioRepair.silenceRepair.enabled, true)
  assert.equal(decision.audioRepair.silenceRepair.restoresSpeech, false)
  assert.equal(decision.audioRepair.loudness.targetLufs, -16)
  assert.equal(decision.audioRepair.separation.enabled, true)
  assert.deepEqual(decision.audioRepair.separation.outputs.map((item) => item.role), ['voice', 'accompaniment'])
  assert.match(decision.audioRepair.separation.artifactWarning, /不是AI专业分轨/)
  assert.equal(decision.output.overwrite, false)
})

test('C2 supports a bounded subset and honours explicit exclusions', () => {
  const decision = compileAudioRepairDecisionList({ sourcePath: SOURCE, instruction: '只做降噪和响度匹配，不要分离人声，响度到-18 LUFS' })
  assert.equal(decision.audioRepair.denoise.enabled, true)
  assert.equal(decision.audioRepair.loudness.enabled, true)
  assert.equal(decision.audioRepair.loudness.targetLufs, -18)
  assert.equal(decision.audioRepair.separation.enabled, false)
  assert.equal(decision.audioRepair.dcRemoval.enabled, false)
})

test('C2 does not execute consultation, examples or empty action text', () => {
  assert.equal(compileAudioRepairDecisionList({ sourcePath: SOURCE, instruction: '能不能降噪并分离人声？' }), null)
  assert.equal(compileAudioRepairDecisionList({ sourcePath: SOURCE, instruction: '比如给视频降噪' }), null)
  assert.equal(compileAudioRepairDecisionList({ sourcePath: SOURCE, instruction: '处理一下音频' }), null)
})
