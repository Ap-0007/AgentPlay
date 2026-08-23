const test = require('node:test')
const assert = require('node:assert/strict')
const { REQUIRED_CATEGORIES, scoreSemanticCalibration, validateCalibrationManifest } = require('../electron/semantic-edit-calibration')

const item = (category) => ({
  category,
  source: { videoPath: `${category}.mp4`, subtitlePath: `${category}.srt`, videoSha256: 'a'.repeat(64), subtitleSha256: 'b'.repeat(64) },
  negativeCase: { expectedRemovalCueIndexes: [] },
  positiveCase: { videoPath: `${category}-duplicate.mp4`, subtitlePath: `${category}-duplicate.srt`, videoSha256: 'c'.repeat(64), subtitleSha256: 'd'.repeat(64), expected: [{ type: 'near_duplicate', removeCueIndexes: [3], visualVerdict: 'safe' }] }
})

test('calibration manifest requires all five real material classes and positive/negative evidence', () => {
  const valid = { schemaVersion: 1, categories: REQUIRED_CATEGORIES.map(item) }
  assert.equal(validateCalibrationManifest(valid).caseCount, 10)
  assert.throws(() => validateCalibrationManifest({ schemaVersion: 1, categories: valid.categories.slice(0, 4) }), /缺少vertical/)
})

test('calibration score requires precision, recall and zero unsafe deletions', () => {
  const records = REQUIRED_CATEGORIES.flatMap((category) => [
    { category, expected: [], actual: [] },
    { category, expected: [{ type: 'near_duplicate', removeCueIndexes: [3], visualVerdict: 'safe' }], actual: [{ type: 'near_duplicate', removeCueIndexes: [3], visualVerdict: 'safe', humanApproved: true }] }
  ])
  assert.deepEqual(scoreSemanticCalibration(records), { passed: true, caseCount: 10, categoryCount: 5, truePositive: 5, falsePositive: 0, falseNegative: 0, unsafeDeletion: 0, processingFailure: 0, precision: 1, recall: 1 })
  records[0].actual.push({ type: 'off_topic', removeCueIndexes: [1], visualVerdict: 'uncertain', humanApproved: false })
  const failed = scoreSemanticCalibration(records)
  assert.equal(failed.passed, false)
  assert.equal(failed.unsafeDeletion, 1)
  records[0].processingFailed = true
  assert.equal(scoreSemanticCalibration(records).processingFailure, 1)
})
