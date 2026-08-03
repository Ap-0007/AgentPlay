const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('os')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const providers = fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-providers.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
const catalog = fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-catalog.js'), 'utf8')

const { ModelCatalog } = require('../electron/model-catalog.js')

test('spark included in codex lineup; only cloud/bundled two modes remain', () => {
  assert.match(providers, /gpt-5\.3-codex-spark/)
  assert.doesNotMatch(panel, /'cloud' \| 'cli' \| 'bundled'/)
  assert.match(panel, /'cloud' \| 'bundled'/)
})

test('model catalog: weekly auto refresh, codex-cli cache source, endpoint source, graceful failure keeps old list', () => {
  assert.match(catalog, /REFRESH_INTERVAL_MS = 7 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(catalog, /models_cache\.json/)
  assert.match(catalog, /codex-cli-cache/)
  assert.match(catalog, /models-endpoint/)
  assert.match(catalog, /source: 'codex-cli-cache'/)
  assert.match(main, /modelCatalog\.needsRefresh\(\)/)
  assert.match(main, /models:refresh-catalog/)
  assert.match(main, /modelCatalog\.modelsFor\(provider\.id, provider\.models\)/)
  assert.match(preload, /refreshCatalog/)
})

test('model center has manual refresh button', () => {
  assert.match(modelCenter, /更新模型列表/)
  assert.match(modelCenter, /refreshCatalog/)
  assert.match(modelCenter, /每周自动刷新一次/)
})

test('catalog read/needsRefresh/modelsFor behave correctly with real files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'))
  const store = new ModelCatalog(dir)
  assert.equal(store.needsRefresh(), true, 'empty catalog needs refresh')
  assert.deepEqual(store.modelsFor('agnes', ['fallback']), ['fallback'])
  fs.writeFileSync(store.filePath, JSON.stringify({ updatedAt: new Date().toISOString(), providers: { agnes: { models: ['m1', 'm2'], updatedAt: new Date().toISOString() } } }))
  assert.equal(store.needsRefresh(), false, 'fresh catalog does not need refresh')
  assert.deepEqual(store.modelsFor('agnes', ['fallback']), ['m1', 'm2'], 'catalog overrides static list')
  assert.deepEqual(store.modelsFor('deepseek', ['ds']), ['ds'], 'unknown provider falls back')
  fs.rmSync(dir, { recursive: true, force: true })
})
