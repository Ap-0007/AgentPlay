const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ModelConfigStore } = require('../electron/model-config-store')

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${value}`),
  decryptString: (value) => Buffer.from(value).toString().replace(/^enc:/, '')
}

test('saving model connections retains a bounded encrypted candidate pool without exposing keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-pool-'))
  try {
    const store = new ModelConfigStore(root, safeStorage)
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'agnes-key' })
    store.save({ role: 'chat', providerId: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'deepseek-key' })
    const candidates = store.resolvedCandidates('chat')
    assert.equal(candidates.length, 2)
    assert.equal(candidates.find((item) => item.providerId === 'agnes').apiKey, 'agnes-key')
    const publicCandidates = store.publicCandidates('chat')
    assert.equal(publicCandidates.length, 2)
    assert.equal(publicCandidates.every((item) => !Object.hasOwn(item, 'apiKey') && item.hasApiKey), true)
    const raw = fs.readFileSync(path.join(root, 'model-config.json'), 'utf8')
    assert.doesNotMatch(raw, /agnes-key|deepseek-key/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stored legacy DeepSeek connection resolves publicly and privately to v4 without losing its encrypted key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-deepseek-migrate-'))
  try {
    fs.writeFileSync(path.join(root, 'model-config.json'), JSON.stringify({
      schemaVersion: 3,
      roles: {
        chat: {
          providerId: 'deepseek',
          model: 'deepseek-chat',
          baseUrl: 'https://api.deepseek.com/v1',
          encryptedApiKey: Buffer.from('enc:legacy-deepseek-key').toString('base64')
        }
      },
      profiles: { chat: [] },
      stash: {}
    }))
    const store = new ModelConfigStore(root, safeStorage)
    const resolved = store.resolved('chat')
    const publicConfig = store.publicConfig('chat')
    assert.equal(resolved.model, 'deepseek-v4-flash')
    assert.equal(resolved.thinkingMode, 'disabled')
    assert.equal(resolved.apiKey, 'legacy-deepseek-key')
    assert.equal(publicConfig.model, 'deepseek-v4-flash')
    assert.equal(publicConfig.thinkingMode, 'disabled')
    assert.equal(publicConfig.contextWindow, 1_000_000)
    assert.equal(publicConfig.pricing.inputUsdPerMillion, 0.14)
    assert.equal(publicConfig.hasApiKey, true)
    assert.equal(Object.hasOwn(publicConfig, 'apiKey'), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('saving a legacy reasoning connection preserves its thinking behavior after normalization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-deepseek-reasoning-'))
  try {
    const store = new ModelConfigStore(root, safeStorage)
    store.save({ role: 'chat', providerId: 'deepseek', model: 'deepseek-reasoner', apiKey: 'reasoning-key' })
    const resolved = store.resolved('chat')
    assert.equal(resolved.model, 'deepseek-v4-flash')
    assert.equal(resolved.thinkingMode, 'enabled')
    assert.equal(store.publicConfig('chat').thinkingMode, 'enabled')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('resaving a migrated legacy chat connection preserves its explicit non-thinking behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-deepseek-resave-'))
  try {
    const store = new ModelConfigStore(root, safeStorage)
    store.save({ role: 'chat', providerId: 'deepseek', model: 'deepseek-chat', apiKey: 'fast-key' })
    const migrated = store.publicConfig('chat')
    store.save({
      role: 'chat', providerId: migrated.providerId, model: migrated.model,
      thinkingMode: migrated.thinkingMode, baseUrl: migrated.baseUrl
    })
    assert.equal(store.resolved('chat').thinkingMode, 'disabled')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('schema 2 active and stash records migrate into candidates without losing the active choice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-migrate-'))
  try {
    fs.writeFileSync(path.join(root, 'model-config.json'), JSON.stringify({
      schemaVersion: 2,
      roles: { chat: { providerId: 'bundled-lite', model: 'ai-player-qwen2.5-0.5b', baseUrl: 'http://127.0.0.1:11555/v1' } },
      stash: { chat: { providerId: 'agnes', model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', encryptedApiKey: Buffer.from('enc:k').toString('base64') } }
    }))
    const store = new ModelConfigStore(root, safeStorage)
    assert.equal(store.publicConfig('chat').providerId, 'bundled-lite')
    const candidates = store.resolvedCandidates('chat')
    assert.equal(candidates.some((item) => item.providerId === 'bundled-lite'), true)
    assert.equal(candidates.some((item) => item.providerId === 'agnes'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('clearing a key removes every same-endpoint encrypted copy from candidates and stash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-clear-'))
  try {
    const store = new ModelConfigStore(root, safeStorage)
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'clear-me' })
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1' })
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', clearApiKey: true })
    assert.equal(store.publicCandidates('chat').some((item) => item.providerId === 'agnes'), false)
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'model-config.json'), 'utf8'), /Y2xlYXItbWU=/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('rotating an endpoint key updates every model profile in that credential scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-rotate-'))
  try {
    const store = new ModelConfigStore(root, safeStorage)
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.0-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'old-key' })
    store.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'new-key' })
    assert.equal(store.resolvedCandidates('chat').every((item) => item.apiKey === 'new-key'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an unknown legacy provider is quarantined instead of sending its key to a default vendor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-model-unknown-'))
  try {
    fs.writeFileSync(path.join(root, 'model-config.json'), JSON.stringify({
      schemaVersion: 2,
      roles: { chat: { providerId: 'retired-provider', encryptedApiKey: Buffer.from('enc:legacy-secret').toString('base64') } }
    }))
    const store = new ModelConfigStore(root, safeStorage)
    assert.equal(store.resolvedCandidates('chat').length, 0)
    assert.equal(store.resolved('chat').apiKey, '')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
