const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const { ModelConfigStore } = require('../electron/model-config-store')

// 模拟系统加密存储：base64 可逆"加密"，验证 stash 里的 encryptedApiKey 原样保留
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (buffer) => {
    const value = buffer.toString('utf8')
    if (!value.startsWith('enc:')) throw new Error('bad cipher')
    return value.slice(4)
  }
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-'))
  return new ModelConfigStore(dir, fakeSafeStorage)
}

test('quick switch stashes cloud config with encrypted key and restores it intact', () => {
  const store = makeStore()
  store.save({ role: 'chat', providerId: 'volcengine', model: 'doubao-pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'secret-key-1' })
  const before = store.resolved('chat')
  assert.equal(before.apiKey, 'secret-key-1')

  const toBundled = store.quickSwitchRole('chat', 'bundled')
  assert.equal(toBundled.switched, true)
  assert.equal(toBundled.config.providerId, 'bundled-lite')
  assert.equal(toBundled.config.hasApiKey, false)

  // 本地模式下普通保存不波及 stash
  const back = store.quickSwitchRole('chat', 'cloud')
  assert.equal(back.switched, true)
  const restored = store.resolved('chat')
  assert.equal(restored.providerId, 'volcengine')
  assert.equal(restored.model, 'doubao-pro')
  assert.equal(restored.apiKey, 'secret-key-1', '云端 Key 必须原样恢复')

  // 再切一次本地：stash 更新为最新云端配置
  store.save({ role: 'chat', providerId: 'volcengine', model: 'doubao-lite', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'secret-key-2' })
  store.quickSwitchRole('chat', 'bundled')
  const back2 = store.quickSwitchRole('chat', 'cloud')
  assert.equal(back2.config.model, 'doubao-lite')
  assert.equal(store.resolved('chat').apiKey, 'secret-key-2')
})

test('quick switch to cloud without stash reports honestly', () => {
  const store = makeStore()
  const result = store.quickSwitchRole('chat', 'cloud')
  assert.equal(result.switched, false)
  assert.match(result.reason, /没有可恢复的云端配置/)
  assert.throws(() => store.quickSwitchRole('chat', 'mars'), /未知切换目标/)
})

test('public cloud config does not pretend the default provider is connected before a key is saved', () => {
  const store = makeStore()
  const empty = store.publicConfig('chat')
  assert.equal(empty.providerId, 'deepseek')
  assert.equal(empty.requiresKey, true)
  assert.equal(empty.configured, false)

  const connected = store.save({
    role: 'chat',
    providerId: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'secret-key'
  })
  assert.equal(connected.configured, true)
  assert.equal(connected.hasApiKey, true)
  assert.equal(Object.hasOwn(connected, 'apiKey'), false)
})

test('quick switch remains available to the unified model center but is not duplicated in the runtime drawer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const panel = agentPanelSource()
  assert.match(main, /ipcMain\.handle\('models:quick-switch'/)
  assert.match(main, /needDownload: true, reason: '本地 AI 组件未下载'/)
  assert.match(preload, /quickSwitch: \(input\) => ipcRenderer\.invoke\('models:quick-switch', input\)/)
  assert.match(panel, /models\?\.routingStatus\?\.\(\)/)
  assert.match(panel, /更改 AI 使用方式/)
  assert.doesNotMatch(panel, /models\?\.quickSwitch/)
  assert.doesNotMatch(panel, /switchModelMode/)
})

test('cli subscription config must never overwrite cloud stash (pollution regression)', () => {
  const store = makeStore()
  store.save({ role: 'chat', providerId: 'volcengine', model: 'doubao-pro', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'cloud-key' })
  store.quickSwitchRole('chat', 'bundled') // stash = volcengine
  // 本地模式下接入订阅 CLI（普通保存，无 Key）
  store.save({ role: 'chat', providerId: 'codex-chatgpt', model: 'gpt-5.6-sol', baseUrl: '', apiKey: '' })
  store.quickSwitchRole('chat', 'bundled') // 不得把 codex 写进 stash
  const back = store.quickSwitchRole('chat', 'cloud')
  assert.equal(back.switched, true, '云端 stash 必须仍可恢复')
  assert.equal(back.config.providerId, 'volcengine')
  assert.equal(store.resolved('chat').apiKey, 'cloud-key')
})

test('cloud restore rejects polluted non-cloud stash honestly', () => {
  const store = makeStore()
  store.save({ role: 'chat', providerId: 'codex-chatgpt', model: 'gpt-5.6-sol', baseUrl: '', apiKey: '' })
  const result = store.quickSwitchRole('chat', 'cloud')
  assert.equal(result.switched, false)
  assert.match(result.reason, /没有可恢复的云端配置/)
})

test('quick switch never treats a loopback model service as cloud', () => {
  const store = makeStore()
  store.save({ role: 'chat', providerId: 'ollama', model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1' })
  store.quickSwitchRole('chat', 'bundled')
  assert.equal(store.quickSwitchRole('chat', 'cloud').switched, false)
})
