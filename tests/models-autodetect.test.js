const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')

test('models:auto-detect probes all OpenAI-compatible providers concurrently, sorts by latency', () => {
  assert.match(main, /ipcMain\.handle\('models:auto-detect'/)
  assert.match(main, /PROVIDERS\.filter\(\(provider\) => provider\.protocol === 'openai' && provider\.baseUrl/)
  assert.match(main, /Promise\.all\(probes\)/)
  assert.match(main, /matches\.sort\(\(a, b\) => a\.latencyMs - b\.latencyMs\)/)
  assert.match(main, /timeoutMs: 8000/)
  assert.match(preload, /autoDetect: \(input\) => ipcRenderer\.invoke\('models:auto-detect', input\)/)
})

test('model center has one-key connect zone', () => {
  assert.match(modelCenter, /一键接入（推荐）/)
  assert.match(modelCenter, /自动识别厂商并列出可用模型/)
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


test('model center layout: manual config and local packs folded by default; cli refresh uses local catalog', () => {
  assert.match(modelCenter, /手动配置（高级：选公司 \//)
  assert.match(modelCenter, /本地组件与下载（离线模型 · 精修 · 翻译 · 站点视频）/)
  assert.match(modelCenter, /showManual/)
  assert.match(modelCenter, /showLocalPacks/)
  // cli 厂商读取型号不再走空 URL
  assert.match(modelCenter, /来自官方 CLI 缓存，随周更自动最新/)
})

test('model label syncs across components on models-changed event', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  assert.match(panel, /ai-player-models-changed/)
  assert.match(modelCenter, /ai-player-models-changed/)
})


test('model select is a real select (no datalist filter/jump), computerUse entry folded to a link', () => {
  assert.doesNotMatch(modelCenter, /datalist id="model-options"/)
  assert.match(modelCenter, /配置电脑观察模型 ▸/)
  assert.match(modelCenter, /返回 AI 对话/)
})
