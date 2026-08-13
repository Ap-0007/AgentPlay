const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const { ServiceCredentialStore } = require('../electron/service-credential-store')

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  }
}

test('service credentials are encrypted at rest and public status never exposes plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-service-credentials-'))
  try {
    const store = new ServiceCredentialStore(dir, fakeSafeStorage())
    const status = store.save({ service: 'opensubtitles', key: 'subtitle-secret' })
    assert.equal(status.services.opensubtitles.hasKey, true)
    assert.equal(Object.hasOwn(status.services.opensubtitles, 'key'), false)
    assert.equal(Object.hasOwn(status.services.opensubtitles, 'encryptedKey'), false)
    assert.equal(store.get('opensubtitles'), 'subtitle-secret')
    const raw = fs.readFileSync(path.join(dir, 'service-credentials.json'), 'utf8')
    assert.equal(raw.includes('subtitle-secret'), false)
    assert.match(raw, /encryptedKey/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('service credentials support replace and clear without accepting unknown services', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-service-credentials-'))
  try {
    const store = new ServiceCredentialStore(dir, fakeSafeStorage())
    store.save({ service: 'tmdb', key: 'first-key' })
    store.save({ service: 'tmdb', key: 'replacement-key' })
    assert.equal(store.get('tmdb'), 'replacement-key')
    assert.throws(() => store.save({ service: 'arbitrary', key: 'secret' }), /不支持的服务/)
    const status = store.save({ service: 'tmdb', clear: true })
    assert.equal(status.services.tmdb.hasKey, false)
    assert.equal(store.get('tmdb'), '')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('service credential save fails closed when operating-system encryption is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-service-credentials-'))
  try {
    const store = new ServiceCredentialStore(dir, fakeSafeStorage(false))
    assert.throws(() => store.save({ service: 'tmdb', key: 'must-not-land' }), /系统加密服务不可用/)
    assert.equal(fs.existsSync(path.join(dir, 'service-credentials.json')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('renderer never stores or forwards service keys after one-time encrypted migration', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const panel = agentPanelSource()
  const player = fs.readFileSync(path.join(root, 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const library = fs.readFileSync(path.join(root, 'src', 'components', 'MediaLibrary.tsx'), 'utf8')

  assert.match(main, /new ServiceCredentialStore\(app\.getPath\('userData'\), safeStorage\)/)
  assert.match(main, /serviceCredentials:status/)
  assert.match(main, /serviceCredentials:save/)
  assert.match(preload, /serviceCredentials/)
  assert.doesNotMatch(preload, /tmdb:search[^\n]*apiKey/)
  assert.doesNotMatch(preload, /subtitle:search[^\n]*apiKey/)
  assert.doesNotMatch(preload, /subtitle:download[^\n]*apiKey/)
  assert.doesNotMatch(player, /aiplayer_subtitle_key/)
  assert.doesNotMatch(library, /aiplayer_tmdb_key/)
  assert.doesNotMatch(panel, /localStorage\.setItem\('aiplayer_(?:tmdb|subtitle)_key'/)
  assert.match(panel, /localStorage\.removeItem\('aiplayer_tmdb_key'\)/)
  assert.match(panel, /localStorage\.removeItem\('aiplayer_subtitle_key'\)/)
})
