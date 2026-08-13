const test = require('node:test')
const assert = require('node:assert/strict')

const { chooseSubtitleEngine } = require('../electron/subtitle-engine-policy')

test('auto subtitle translation uses configured cloud acceleration and otherwise stays local', () => {
  assert.equal(chooseSubtitleEngine({ cloudReady: true, offlineAvailable: true }), 'cloud')
  assert.equal(chooseSubtitleEngine({ cloudReady: false, offlineAvailable: true }), 'offline')
  assert.equal(chooseSubtitleEngine({ cloudReady: true, offlineAvailable: false }), 'cloud')
  assert.equal(chooseSubtitleEngine({ cloudReady: false, offlineAvailable: false }), null)
})

test('explicit preferences degrade safely instead of leaving subtitles unusable', () => {
  assert.equal(chooseSubtitleEngine({ preference: 'local', cloudReady: true, offlineAvailable: true }), 'offline')
  assert.equal(chooseSubtitleEngine({ preference: 'local', cloudReady: true, offlineAvailable: false }), null)
  assert.equal(chooseSubtitleEngine({ preference: 'cloud', cloudReady: false, offlineAvailable: true }), 'offline')
})
