const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')

function between(start, end) {
  const from = main.indexOf(start)
  const to = main.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing start marker: ${start}`)
  assert.notEqual(to, -1, `missing end marker: ${end}`)
  return main.slice(from, to)
}

test('approved document tasks execute only the frozen model route', () => {
  const executor = between("persistentTaskRuntime.register('document.run'", "const preparePersistentAnalysisTask")
  assert.match(executor, /resolveTaskModelRoute\(task\.spec\.modelRoute\)/)
  assert.doesNotMatch(executor, /const candidates = \[current, fallback\]/)
})

test('approved subtitle translation records calls through the frozen model wrapper', () => {
  const executor = between('const executePersistentSubtitleTask', "persistentTaskRuntime.register('subtitle.generate'")
  assert.match(executor, /llmComplete\(\{[\s\S]*?modelConfig: routeConfig[\s\S]*?taskKind: 'subtitle-translation'/)
  assert.doesNotMatch(executor, /complete: \([^)]*\) => agentEngine\.completeText/)
})

test('subtitle tasks select an eligible cloud model before freezing the route', () => {
  const preparer = between('const preparePersistentSubtitleTask', 'const executePersistentSubtitleTask')
  assert.match(preparer, /selectModelForTaskPlan\(\{\s*taskKind: 'subtitle-translation'/)
  assert.match(preparer, /candidates: cloudCandidates/)
  assert.match(preparer, /freezeTaskModelRoute\(config, \{ taskKind: 'subtitle-translation' \}\)/)
  assert.doesNotMatch(preparer, /const config = creativeConfig\(\)/)
})

test('direct cloud upload and paid studio entry points require native approval', () => {
  const describeImage = between('const describeImage', 'documentWorkspace = new DocumentWorkspaceService')
  const guide = between("ipcMain.handle('guide:annotate'", '// 单文件压缩/转码核心')
  const askFrame = between("ipcMain.handle('guide:askFrame'", "ipcMain.handle('screenshot:save'")
  const studio = between("ipcMain.handle('studio:creative-plan'", 'const creativeTaskRoute')
  const voice = between("ipcMain.handle('studio:generate-voice'", "ipcMain.handle('studio:select-asset'")
  assert.match(guide, /await ensureCloudConsent\(/)
  assert.match(askFrame, /await ensureCloudConsent\(/)
  assert.match(describeImage, /localOnly \? null : cloudConfigForExplicitFeature\(\)/)
  assert.match(describeImage, /if \(!modelConfig[\s\S]*?await ensureCloudConsent\(/)
  assert.match(studio, /studio:creative-plan[\s\S]*?await ensureCloudConsent\(/)
  assert.match(studio, /studio:generate-image[\s\S]*?ensurePersistentApproval\(\{ action: 'paid'/)
  assert.match(voice, /ensurePersistentApproval\(\{ action: 'paid'/)
})

test('analysis planning is null-safe and freezes the selected evaluation family', () => {
  const preparer = between('const preparePersistentAnalysisTask', "persistentTaskRuntime.register('analysis.run'")
  assert.match(preparer, /config\?\.requiresKey !== false/)
  assert.match(preparer, /freezeTaskModelRoute\(config, \{ taskKind: visionDecision\.selected \? 'analysis-vision' : 'analysis' \}\)/)
})

test('quality receipts use the frozen evaluation family and asset model identity', () => {
  const quality = between('onQuality: ({ task, quality }) =>', 'failureClassifier: classifyTaskFailure')
  assert.match(quality, /route\?\.taskKind \|\| taskKindForPersistentType/)
  assert.match(quality, /route\.metricModel \? \{ \.\.\.config, model: route\.metricModel \} : config/)
})

test('creative tasks select before freezing and video calls emit performance receipts', () => {
  const route = between('const creativeTaskRoute', 'const preparePersistentVideoGeneration')
  const video = between('const executePersistentVideoGeneration', 'const preparePersistentRecut')
  assert.match(route, /selectModelForTaskPlan\(\{ taskKind/)
  assert.match(route, /freezeTaskModelRoute\(config, \{ taskKind/)
  assert.doesNotMatch(route, /const config = cloudConfigForExplicitFeature\(\)/)
  assert.match(video, /generateVideoWithReceipt\(config/)
})

test('disconnect reports whether a credential was actually removed', () => {
  const handler = between("ipcMain.handle('models:disconnect'", "ipcMain.handle('models:quick-switch'")
  assert.match(handler, /\{ disconnected: false, candidates:/)
  assert.match(handler, /\{ disconnected: true, candidates:/)
})
