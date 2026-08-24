const test = require('node:test')
const assert = require('node:assert/strict')

const { detectDuplicateSequences, matchesAutoInspectionInstruction, parseVisualInspectionLog } = require('../electron/media-auto-inspection')

test('auto inspection intent is explicit and consultation never executes', () => {
  assert.equal(matchesAutoInspectionInstruction('自动检查这个视频并给我剪辑方案'), true)
  assert.equal(matchesAutoInspectionInstruction('检查静音、口头禅、重复镜头、黑帧和失焦'), true)
  assert.equal(matchesAutoInspectionInstruction('能不能检查一下视频？'), false)
  assert.equal(matchesAutoInspectionInstruction('这个视频怎么样'), false)
})

test('visual inspection parses black intervals and relative blur outliers into bounded ranges', () => {
  const result = parseVisualInspectionLog(`
[blackdetect] black_start:2.000 black_end:3.000 black_duration:1.000
frame:0 pts:0 pts_time:0.0
lavfi.blur=4.0
frame:1 pts:1 pts_time:0.5
lavfi.blur=4.2
frame:2 pts:2 pts_time:1.0
lavfi.blur=11.0
frame:3 pts:3 pts_time:1.5
lavfi.blur=12.0
frame:4 pts:4 pts_time:2.0
lavfi.blur=4.1
`)
  assert.deepEqual(result.blackRanges, [{ startSeconds: 2, endSeconds: 3, durationSeconds: 1, score: 1 }])
  assert.deepEqual(result.blurRanges, [{ startSeconds: 1, endSeconds: 2, durationSeconds: 1, score: 11.5, baseline: 4.2 }])
})

test('duplicate detection requires a changing sequence and reports only the later copy', () => {
  const frame = (value) => Buffer.from([value, value, value, value])
  const frames = [frame(10), frame(40), frame(80), frame(150), frame(10), frame(40), frame(80)]
  assert.deepEqual(detectDuplicateSequences(frames, { sampleFps: 2, minimumSeconds: 1.5, minimumGapSeconds: 1.5 }), [{
    startSeconds: 2, endSeconds: 3.5, durationSeconds: 1.5, referenceStartSeconds: 0, referenceEndSeconds: 1.5, score: 0
  }])
  assert.deepEqual(detectDuplicateSequences([frame(20), frame(20), frame(20), frame(20), frame(20), frame(20)], { sampleFps: 2 }), [])
})
