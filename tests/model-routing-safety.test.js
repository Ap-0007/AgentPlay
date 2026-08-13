const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('local-only preference guards every independent cloud feature', () => {
  const main = read('electron/main.js')
  assert.match(main, /function cloudConfigForExplicitFeature\(\)[\s\S]{0,240}preference === 'local'/)
  for (const marker of ["guide:annotate", "guide:askFrame", "studio:creative-plan", "studio:generate-image", "studio:generate-voice"]) {
    const start = main.indexOf(`ipcMain.handle('${marker}'`)
    const end = main.indexOf('ipcMain.handle(', start + 20)
    const handler = main.slice(start, end)
    assert.match(handler, /const config = cloudConfigForExplicitFeature\(\)/)
  }
  assert.match(main, /creativeTaskRoute[\s\S]{0,400}selectModelForTaskPlan\(/)
  assert.match(main, /describeImage = async[\s\S]{0,400}localOnly \? null : cloudConfigForExplicitFeature\(\)/)
})

test('approved document and analysis routes remain frozen across every model call', () => {
  const main = read('electron/main.js')
  const documents = read('electron/document-workspace-service.js')
  assert.match(main, /complete: \(input\) => llmComplete\(\{ \.\.\.input, modelConfig: config, taskKind: 'analysis' \}\)/)
  assert.match(main, /completeVisionMulti: \(input\) => llmCompleteVisionMulti\(\{ \.\.\.input, modelConfig: config, taskKind: 'analysis-vision' \}\)/)
  const completeCallCount = (documents.match(/this\.complete\(\{/g) || []).length
  const frozenConfigCount = (documents.match(/modelConfig: options\.modelConfig/g) || []).length
  assert.ok(completeCallCount >= 6)
  assert.equal(frozenConfigCount, completeCallCount)
})

test('disconnect is owned by the main-process approval gate and cancellation never deletes credentials', () => {
  const main = read('electron/main.js')
  const ui = read('src/components/ModelCenter.tsx')
  const start = main.indexOf("ipcMain.handle('models:disconnect'")
  const end = main.indexOf("ipcMain.handle('models:quick-switch'", start)
  assert.ok(start >= 0 && end > start, 'disconnect IPC must be independently inspectable')
  const handler = main.slice(start, end)
  assert.match(handler, /ensurePersistentApproval\(\{ action: 'credential'/)
  assert.match(handler, /if \(!approved\) return/)
  assert.ok(handler.indexOf('if (!approved) return') < handler.indexOf('modelConfigStore.disconnect('), 'cancelled approval must return before deletion')
  assert.match(handler, /本机加密凭证/)
  assert.match(handler, /重新粘贴 Key/)
  assert.doesNotMatch(ui, /window\.confirm\(/, 'renderer confirmation must not duplicate or replace native approval')
})
