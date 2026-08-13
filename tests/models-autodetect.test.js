const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')

test('models:auto-detect sends a key only to the one provider explicitly selected by the user', () => {
  assert.match(main, /ipcMain\.handle\('models:auto-detect'/)
  assert.match(main, /const providerId = String\(input\.providerId/)
  assert.match(main, /先选择这个 Key 是从哪家复制的/)
  assert.doesNotMatch(main, /Promise\.all\(probes\)/)
  assert.match(main, /timeoutMs: 8000/)
  assert.match(preload, /autoDetect: \(input\) => ipcRenderer\.invoke\('models:auto-detect', input\)/)
})

test('models:auto-detect has one selected-provider probe and never persists the key itself', () => {
  const start = main.indexOf("ipcMain.handle('models:auto-detect'")
  const end = main.indexOf("ipcMain.handle('media:batch'", start)
  assert.ok(start >= 0 && end > start, 'auto-detect IPC handler must be independently inspectable')
  const handler = main.slice(start, end)
  assert.match(handler, /PROVIDERS\.find\(\(item\) => item\.id === providerId/)
  assert.equal((handler.match(/await listModels\(/g) || []).length, 1, 'the selected Key may reach exactly one model-list endpoint')
  assert.doesNotMatch(handler, /Promise\.all|for\s*\(|\.map\s*\(/, 'provider probing must not fan out')
  assert.doesNotMatch(handler, /modelConfigStore\.(?:save|write)/, 'detection must not persist an unconfirmed Key')
})

test('model center has one-key connect zone', () => {
  assert.match(modelCenter, /接入一个云端服务/)
  assert.match(modelCenter, /Key 只会发给这一家/)
  assert.match(modelCenter, /autoDetect/)
  assert.match(modelCenter, /接入/)
  // 匹配卡片带模型下拉，用户可自选
  assert.match(modelCenter, /oneKeyModelPick/)
  assert.match(modelCenter, /applyMatch/)
})


test('model form: key visibility toggle, cli providers hide key/url steps, save allowed without baseUrl', () => {
  assert.match(modelCenter, /showKey/)
  assert.match(modelCenter, /显示 Key/)
  assert.match(modelCenter, /provider\?\.protocol !== 'cli' && <label/)
  assert.match(modelCenter, /订阅账号无需 Key 和地址/)
  assert.match(modelCenter, /provider\?\.protocol !== 'cli' && !baseUrl/)
})


test('model center layout: advanced config is available but hidden from daily use; local packs stay folded', () => {
  assert.match(modelCenter, /1\. 模型公司 \/ 服务/)
  assert.match(modelCenter, /读取可用型号/)
  assert.match(modelCenter, /测试连接/)
  assert.match(modelCenter, /保存并启用/)
  assert.match(modelCenter, /showAdvancedModelSetup/)
  assert.match(modelCenter, /本地组件与下载（可选 · 离线模型 · 精修 · 翻译 · OCR · 站点视频）/)
  assert.match(modelCenter, /showLocalPacks/)
  // cli 厂商读取型号不再走空 URL
  assert.match(modelCenter, /来自官方 CLI 缓存，随周更自动最新/)
  // cli 分支提前 return 前必须复位 busy，否则后续按钮全部失效（真实事故）
  assert.match(modelCenter, /来自官方 CLI 缓存，随周更自动最新[^]*?setBusy\(false\)\s*\r?\n\s*return/)
})

test('model label syncs across components on models-changed event', () => {
  const panel = agentPanelSource()
  assert.match(panel, /ai-player-models-changed/)
  assert.match(modelCenter, /ai-player-models-changed/)
})


test('model select is a real select (no datalist filter/jump), computerUse entry folded to a link', () => {
  assert.doesNotMatch(modelCenter, /datalist id="model-options"/)
  assert.match(modelCenter, /配置电脑观察模型 ▸/)
  assert.match(modelCenter, /返回 AI 对话/)
})
