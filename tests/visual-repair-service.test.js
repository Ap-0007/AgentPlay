const test = require('node:test')
const assert = require('node:assert/strict')

const { buildVisualRepairDecision, matchesVisualRepairInstruction, parseSignalStatsLog, parseVisualRepairInstruction, recommendColorCorrection, shakeScoreFromTransforms } = require('../electron/visual-repair-service')

test('visual repair intent separates explicit repair from consultation', () => {
  const text = '帮我防抖，顺时针旋转90度，自动修复曝光和偏色，并提示低质量片段，保留前后对比'
  assert.equal(matchesVisualRepairInstruction(text), true)
  assert.equal(matchesVisualRepairInstruction('能不能帮我防抖？'), false)
  assert.deepEqual(parseVisualRepairInstruction(text), { stabilize: true, rotationDegrees: 90, autoColor: true, inspectQuality: true, comparison: true })
  assert.equal(parseVisualRepairInstruction('逆时针旋转90度').rotationDegrees, -90)
  assert.equal(parseVisualRepairInstruction('旋转180度').rotationDegrees, 180)
})

test('signal statistics produce bounded exposure and color correction', () => {
  const log = 'lavfi.signalstats.YAVG=45\nlavfi.signalstats.UAVG=168\nlavfi.signalstats.VAVG=105\nlavfi.signalstats.SATAVG=42\nlavfi.signalstats.YAVG=55\nlavfi.signalstats.UAVG=160\nlavfi.signalstats.VAVG=110\nlavfi.signalstats.SATAVG=50\n'
  const stats = parseSignalStatsLog(log)
  assert.deepEqual(stats, { sampleCount: 2, yAvg: 50, uAvg: 164, vAvg: 107.5, satAvg: 46 })
  const correction = recommendColorCorrection(stats)
  assert.ok(correction.brightness > 0 && correction.brightness <= 0.2)
  assert.ok(correction.saturation > 1)
  assert.ok(correction.blueShift < 0)
  assert.ok(correction.redShift > 0)
})

test('ASCII vidstab transforms become a robust per-frame shake score', () => {
  const text = 'VID.STAB 1\nFrame 1 (List 0 [])\nFrame 2 (List 3 [(LM 10 -12 1 1 16 0.5 0),(LM 11 -11 2 2 16 0.5 0),(LM 9 -13 3 3 16 0.5 0)])\nFrame 3 (List 2 [(LM -4 3 1 1 16 0.5 0),(LM -6 5 2 2 16 0.5 0)])\n'
  const score = shakeScoreFromTransforms(text)
  assert.equal(score.frameCount, 2)
  assert.ok(score.averageMagnitude > 8)
  assert.ok(score.maximumMagnitude > score.averageMagnitude)
})

test('decision freezes repairs, review-only findings, original and comparison outputs', () => {
  const decision = buildVisualRepairDecision({ instruction: '防抖并自动修复曝光', sourcePath: 'D:\\video\\source.mp4', width: 640, height: 360, durationSeconds: 6, request: { stabilize: true, rotationDegrees: 90, autoColor: true, inspectQuality: true, comparison: true }, signalStats: { sampleCount: 4, yAvg: 50, uAvg: 164, vAvg: 108, satAvg: 45 }, inspection: { blackRanges: [{ startSeconds: 1, endSeconds: 1.5 }], blurRanges: [{ startSeconds: 2, endSeconds: 3 }], duplicateRanges: [] } })
  assert.equal(decision.kind, 'media.visual-repair')
  assert.deepEqual(decision.repair.expectedDimensions, { width: 360, height: 640 })
  assert.equal(decision.repair.lowQualityFindings.length, 2)
  assert.equal(decision.repair.lowQualityFindings.every((item) => item.action === 'review-only'), true)
  assert.equal(decision.repair.confirmationRequired, true)
  assert.equal(decision.repair.comparison.enabled, true)
})
