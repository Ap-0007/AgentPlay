const assert = require('node:assert/strict')
const test = require('node:test')
const { compileRhythmEditRequest, matchesRhythmEditInstruction } = require('../electron/rhythm-edit-decision')

const sourcePath = 'D:\\Videos\\source.mp4'
const musicPath = 'D:\\Music\\pulse.wav'

test('C3 recognises explicit beat editing and freezes fast or restrained policy', () => {
  const fast = compileRhythmEditRequest({ instruction: `用 ${musicPath} 按音乐节拍切镜，音乐高潮对齐，片尾自然收束，节奏更快`, sourcePath })
  assert.equal(fast.kind, 'media.rhythm-edit-request')
  assert.equal(fast.policy.strategy, 'pcm-beat-highlight-edit-v1')
  assert.equal(fast.policy.pace, 'fast')
  assert.equal(fast.policy.baseBeatsPerCut, 2)
  assert.equal(fast.policy.highlightBeatsPerCut, 1)
  assert.equal(fast.policy.preserveDialogue, true)

  const restrained = compileRhythmEditRequest({ instruction: `用 ${musicPath} 卡点剪辑并让片尾自然收束，节奏更克制`, sourcePath })
  assert.equal(restrained.policy.pace, 'restrained')
  assert.equal(restrained.policy.baseBeatsPerCut, 8)
  assert.equal(restrained.policy.highlightBeatsPerCut, 4)
})

test('C3 asks for local music instead of guessing or downloading', () => {
  const planned = compileRhythmEditRequest({ instruction: '按音乐节拍切镜，高潮对齐，片尾自然收束', sourcePath })
  assert.equal(planned.matched, true)
  assert.equal(planned.review.kind, 'rhythm-music-missing')
  assert.match(planned.review.summary, /本地音乐文件/)
  assert.match(planned.review.summary, /不会从未知网站自动抓取/)
})

test('C3 rejects consultation, examples and conflicting pace', () => {
  assert.equal(matchesRhythmEditInstruction('能不能按音乐节拍切镜？'), false)
  assert.equal(matchesRhythmEditInstruction('比如按音乐节拍切镜'), false)
  assert.throws(() => compileRhythmEditRequest({ instruction: `用 ${musicPath} 按节拍切镜，既更快又更克制`, sourcePath }), /只保留一种/)
})
