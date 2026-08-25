const assert = require('node:assert/strict')
const test = require('node:test')

const { compileAudioMixDecisionList, isAudioMixIntent } = require('../electron/audio-mix-decision')

const SOURCE = 'D:/Videos/source.mp4'

test('C1 freezes dialogue, music, ambience and sound-effect tracks with alignment, automation and ducking', () => {
  const decision = compileAudioMixDecisionList({
    sourcePath: SOURCE,
    instruction: '做多轨混音：背景音乐 D:/Audio/music.wav 从0秒到6秒 音量20%；环境声 D:/Audio/rain.wav 从1秒到5秒 音量10%；音效 D:/Audio/ding.wav 放在2秒开始 音量30%；对白在3秒到4秒音量70%；音乐在4秒到5秒音量5%；自动闪避；响度归一到-16 LUFS'
  })
  assert.equal(decision.kind, 'media.mix-audio')
  assert.equal(decision.audioMix.strategy, 'multitrack-audio-mix-v1')
  assert.deepEqual(decision.audioMix.dialogue, {
    enabled: true,
    volume: 1,
    automation: [{ startSeconds: 3, endSeconds: 4, volume: 0.7 }]
  })
  assert.deepEqual(decision.audioMix.tracks.map((track) => ({ id: track.id, role: track.role, volume: track.volume, startSeconds: track.startSeconds, endSeconds: track.endSeconds, loop: track.loop, duck: track.duckAgainstDialogue })), [
    { id: 'music-1', role: 'music', volume: 0.2, startSeconds: 0, endSeconds: 6, loop: true, duck: true },
    { id: 'ambience-1', role: 'ambience', volume: 0.1, startSeconds: 1, endSeconds: 5, loop: true, duck: true },
    { id: 'sfx-1', role: 'sfx', volume: 0.3, startSeconds: 2, endSeconds: undefined, loop: false, duck: false }
  ])
  assert.equal(decision.audioMix.master.loudness.targetLufs, -16)
  assert.deepEqual(decision.audioMix.tracks[0].automation, [{ startSeconds: 4, endSeconds: 5, volume: 0.05 }])
  assert.equal(decision.output.overwrite, false)
})

test('C1 can remove the source dialogue track and excludes explicitly removed external roles', () => {
  const decision = compileAudioMixDecisionList({
    sourcePath: SOURCE,
    instruction: '做多轨混音，去掉原声；背景音乐 D:/Audio/music.wav 音量20%；不要环境声；音效 D:/Audio/ding.wav 在2秒开始'
  })
  assert.equal(decision.audioMix.dialogue.enabled, false)
  assert.deepEqual(decision.audioMix.removedRoles.sort(), ['ambience', 'dialogue'])
  assert.deepEqual(decision.audioMix.tracks.map((track) => track.role), ['music', 'sfx'])
})

test('C1 does not steal legacy single-music work or consultation text', () => {
  assert.equal(isAudioMixIntent('给视频加背景音乐 D:/Audio/music.wav'), false)
  assert.equal(compileAudioMixDecisionList({ sourcePath: SOURCE, instruction: '给视频加背景音乐 D:/Audio/music.wav' }), null)
  assert.equal(compileAudioMixDecisionList({ sourcePath: SOURCE, instruction: '能不能做多轨？背景音乐 D:/Audio/music.wav，环境声 D:/Audio/rain.wav' }), null)
})
