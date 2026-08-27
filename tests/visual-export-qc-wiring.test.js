const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

test('B1-B4 all pass through one unified visual export quality gate', () => {
  const main = read('electron/main.js'); const quality = read('electron/task-result-quality.js'); const gate = read('electron/visual-export-quality.js')
  assert.match(main, /new VisualExportQualityGate/)
  for (const profile of ['b1-visual-effects', 'b2-smart-reframe', 'b3-visual-repair', 'b4-style-recut']) assert.match(main, new RegExp(profile))
  assert.match(main, /统一视觉导出质量门失败/)
  assert.match(quality, /UNIFIED_VISUAL_QC_FAILED/)
  assert.ok((quality.match(/unified-visual-qc/g) || []).length >= 4)
  assert.match(gate, /UNEXPECTED_BLACK_BARS/)
  assert.match(gate, /NEW_BLACK_FRAMES/)
  assert.match(gate, /UNSUPPORTED_VIDEO_CODEC/)
  assert.match(gate, /NEW_LONG_FREEZE/)
  assert.match(gate, /decodePassed/)
})

test('explicit inset and before-after comparison may declare expected bars while normal exports cannot', () => {
  const main = read('electron/main.js'); const registry = read('electron/media-edit-executor-registry.js')
  assert.match(registry, /allowBlackBars: decision\.effects\.some\(\(entry\) => entry\.type === 'scale' && Number\(entry\.factor\) < 1\)/)
  assert.match(main, /role: 'before-after-comparison'[\s\S]{0,160}allowBlackBars: true/)
  assert.doesNotMatch(main, /role: `reframe-\$\{item\.aspect\}`[^\n]+allowBlackBars: true/)
})
