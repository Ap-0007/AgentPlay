const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { REQUIRED_CATEGORIES, scoreSemanticSuiteCalibration, validateSemanticSuiteManifest } = require('../electron/semantic-suite-calibration')

const manifest = { schemaVersion: 1, baseManifestPath: 'private.json', categories: REQUIRED_CATEGORIES.map((category) => ({ category, quote: { query: '原话', expectedCueIndex: 2 }, topic: { query: '主题', expectedCueIndexes: [2, 3] }, inspection: { expectDerivedDuplicate: true }, versions: { anchorCueIndexes: [2, 3], requiredExports: 2 } })) }

test('A5 manifest requires manual truth for all five real material classes and four capability lines', () => {
  assert.equal(validateSemanticSuiteManifest(manifest).categories.length, 5)
  const missing = structuredClone(manifest); missing.categories.pop()
  assert.throws(() => validateSemanticSuiteManifest(missing), /缺少vertical/)
  const noTopic = structuredClone(manifest); noTopic.categories[0].topic.expectedCueIndexes = []
  assert.throws(() => validateSemanticSuiteManifest(noTopic), /主题字幕人工真值/)
})

test('A5 score requires quote, topic overlap, derived duplicate, real exports and zero unsafe visual deletion', () => {
  const records = REQUIRED_CATEGORIES.map((category) => ({ category, quotePassed: true, topicExpected: [2, 3], topicActual: [2, 3], duplicatePassed: true, versionsPassed: true, unsafeVisualDeletion: 0, processingFailed: false, exportQuality: 100 }))
  assert.equal(scoreSemanticSuiteCalibration(records).passed, true)
  const unsafe = structuredClone(records); unsafe[0].unsafeVisualDeletion = 1
  assert.equal(scoreSemanticSuiteCalibration(unsafe).passed, false)
  const weak = structuredClone(records); weak[0].topicActual = [8, 9]; weak[1].topicActual = [8, 9]
  assert.equal(scoreSemanticSuiteCalibration(weak).passed, false)
})

test('public A5 runners require a private manifest and explicit cloud permission without embedding private paths or keys', () => {
  const run = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-private-semantic-suite-calibration.mjs'), 'utf8')
  const verify = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'verify-private-semantic-suite-calibration.mjs'), 'utf8')
  assert.match(run, /--allow-cloud-calibration=yes/)
  assert.match(run, /process\.env\.AGNES_API_KEY/)
  assert.match(verify, /privateResultSha256/)
  for (const source of [run, verify]) {
    assert.doesNotMatch(source, /AgentPlay 标定|maomao5759|AGNES_API_KEY\s*=\s*['"]/)
  }
})
