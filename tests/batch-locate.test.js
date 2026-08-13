const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const providers = fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-providers.js'), 'utf8')
const panel = agentPanelSource()

test('agnes 2.5 flash is the default chat model', () => {
  assert.match(providers, /models: \['agnes-2\.5-flash', 'agnes-2\.0-flash'\]/)
})

test('result outputs have locate-in-folder button for forwarding', () => {
  assert.match(main, /ipcMain\.handle\('system:showInFolder'/)
  assert.match(main, /shell\.showItemInFolder/)
  assert.match(preload, /showInFolder/)
  assert.match(panel, /showInFolder/)
  assert.match(panel, /在文件夹中定位（方便转发\/拖走）/)
})

test('batch tasks: token-authorized batch compress and transcribe with progress', () => {
  assert.match(main, /ipcMain\.handle\('media:batch'/)
  assert.match(main, /tokens\.map\(documentSelectionFromToken\)/)
  assert.match(main, /type:\s*'media\.batch'/)
  assert.match(main, /compressOne/)
  assert.match(main, /plannedMediaOutput\(sourcePath, label, extension, requestId, index\)/)
  assert.match(main, /media:batch-progress/)
  assert.match(preload, /mediaBatch/)
  assert.match(panel, /runBatchTask/)
  assert.match(panel, /全部压缩|批量/)
})
