const assert = require('node:assert/strict')
const test = require('node:test')

const { compileAudioMixDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { assertEditDecisionList, attachEditDecisionList } = require('../electron/edit-decision-list')

const SOURCE = 'D:/Videos/source.mp4'
const INSTRUCTION = '做多轨混音：背景音乐 D:/Audio/music.wav 从0秒到6秒 音量20%；环境声 D:/Audio/rain.wav 从1秒到5秒 音量10%；音效 D:/Audio/ding.wav 放在2秒开始 音量30%；对白在3秒到4秒音量70%；音乐在4秒到5秒音量5%；自动闪避'

test('C1 enters the unified planner and compiles one canonical multitrack EDL', () => {
  const planned = planEditInstruction({ instruction: INSTRUCTION, sourcePath: SOURCE })
  assert.equal(planned.matched, true)
  const decision = attachEditDecisionList(planned.decision)
  assert.equal(decision.kind, 'media.mix-audio')
  assert.equal(decision.edl.materials.length, 4)
  assert.deepEqual(decision.edl.materials.map((item) => item.role), ['video', 'music', 'ambience', 'sfx'])
  assert.equal(decision.edl.tracks.length, 5)
  assert.deepEqual(decision.edl.operations.map((item) => item.type), ['mix-dialogue', 'mix-audio-track', 'mix-audio-track', 'mix-audio-track'])
  assert.equal(decision.edl.operations[2].targetRangeSeconds.start, 1)
  assert.equal(decision.edl.operations[2].targetRangeSeconds.end, 5)
  assert.deepEqual(decision.edl.operations[0].parameters.automation, [{ start: 3, end: 4, volume: 0.7 }])
  assert.deepEqual(decision.edl.operations[1].parameters.automation, [{ start: 4, end: 5, volume: 0.05 }])
  assert.doesNotThrow(() => assertEditDecisionList(decision))
  const tampered = structuredClone(decision)
  tampered.audioMix.tracks[1].startSeconds = 2
  assert.throws(() => assertEditDecisionList(tampered), /EDL 与冻结决策不一致/)
})

test('C1 missing materials asks one question and resolves from labelled paths', () => {
  const planned = planEditInstruction({ instruction: '给这个视频做多轨，加背景音乐和环境声并自动闪避', sourcePath: SOURCE })
  assert.equal(planned.matched, true)
  assert.equal(planned.clarification.reason, 'missing-audio-mix-tracks')
  const resolved = resolveEditClarification({
    clarification: planned.clarification,
    answer: '背景音乐 D:/Audio/music.wav；环境声 D:/Audio/rain.wav'
  })
  assert.equal(resolved.matched, true)
  assert.equal(resolved.decision.kind, 'media.mix-audio')
  assert.deepEqual(resolved.decision.audioMix.tracks.map((item) => item.role), ['music', 'ambience'])
})

test('legacy single background music remains the legacy add-music decision', () => {
  const decision = compileAudioMixDecisionList({ instruction: '给视频加背景音乐 D:/Audio/music.wav', sourcePath: SOURCE })
  assert.equal(decision, null)
  assert.equal(planEditInstruction({ instruction: '给视频加背景音乐 D:/Audio/music.wav', sourcePath: SOURCE }).decision.kind, 'media.add-music')
})
