const assert = require('node:assert/strict')
const test = require('node:test')
const { buildRhythmPlan, detectBeatGrid } = require('../electron/rhythm-edit-service')

function syntheticBeatPcm({ durationSeconds = 16, sampleRate = 11025, bpm = 120 } = {}) {
  const samples = Math.floor(durationSeconds * sampleRate)
  const buffer = Buffer.alloc(samples * 2)
  const period = 60 / bpm
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate
    let value = 0.012 * Math.sin(2 * Math.PI * 220 * time)
    if (time >= 6 && time <= 10) value += 0.12 * Math.sin(2 * Math.PI * 440 * time)
    const beatDistance = time % period
    if (beatDistance < 0.025) value += 0.85 * Math.exp(-beatDistance * 90)
    const int16 = Math.max(-32767, Math.min(32767, Math.round(value * 32767)))
    buffer.writeInt16LE(int16, index * 2)
  }
  return buffer
}

test('C3 detects a real PCM beat grid and locates the stronger music section', () => {
  const analysis = detectBeatGrid(syntheticBeatPcm(), { sampleRate: 11025, durationSeconds: 16 })
  assert.ok(Math.abs(analysis.bpm - 120) <= 3, `unexpected bpm ${analysis.bpm}`)
  assert.ok(analysis.supportRatio >= 0.8)
  assert.ok(analysis.beatTimes.length >= 20)
  assert.ok(analysis.highlight.startSeconds < 10)
  assert.ok(analysis.highlight.endSeconds > 6)
})

test('C3 faster and restrained modes use real beats with different cut density', () => {
  const analysis = detectBeatGrid(syntheticBeatPcm(), { sampleRate: 11025, durationSeconds: 16 })
  const common = { analysis, sourceDuration: 16, musicDuration: 16 }
  const fast = buildRhythmPlan({ ...common, policy: { pace: 'fast', baseBeatsPerCut: 2, highlightBeatsPerCut: 1, jumpGapSeconds: 0.14, tailFadeSeconds: 1.2, minimumCutSeconds: 0.28, maximumCuts: 40 } })
  const restrained = buildRhythmPlan({ ...common, policy: { pace: 'restrained', baseBeatsPerCut: 8, highlightBeatsPerCut: 4, jumpGapSeconds: 0.04, tailFadeSeconds: 1.8, minimumCutSeconds: 0.28, maximumCuts: 40 } })
  assert.ok(fast.cutTimes.length > restrained.cutTimes.length)
  assert.ok(fast.highlight.densityRatio <= 0.8)
  assert.ok(restrained.highlight.densityRatio <= 0.8)
  assert.equal(fast.cutTimes.includes(fast.highlight.alignedBeatSeconds), true)
  assert.equal(fast.tail.endBeatSeconds, fast.outputDurationSeconds)
  assert.ok(fast.segments.every((segment, index) => index === 0 || segment.sourceStartSeconds > fast.segments[index - 1].sourceEndSeconds))
})

test('C3 fails closed when PCM lacks enough real onset evidence', () => {
  const silent = Buffer.alloc(11025 * 10 * 2)
  assert.throws(() => detectBeatGrid(silent, { sampleRate: 11025, durationSeconds: 10 }), /足够稳定|稳定网格/)
})
