const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SiteLoginService, electronCookiesToNetscape, hasLoginMarker, SITE_HOME } = require('../electron/site-login-service')

const douyinCookies = [
  { domain: '.douyin.com', name: 'ttwid', value: 'a1', path: '/', secure: true, expirationDate: 1780000000 },
  { domain: 'www.douyin.com', name: '__ac_nonce', value: 'n1', path: '/', secure: false },
  { domain: '.douyin.com', name: 'sessionid', value: 's1', path: '/', secure: true, expirationDate: 1780000000 }
]

test('electron cookies convert to Netscape format', () => {
  const text = electronCookiesToNetscape(douyinCookies)
  assert.match(text, /^# Netscape HTTP Cookie File/)
  assert.match(text, /\.douyin\.com\tTRUE\t\/\tTRUE\t1780000000\tttwid\ta1/)
  assert.match(text, /www\.douyin\.com\tFALSE\t\/\tFALSE\t0\t__ac_nonce\tn1/)
  assert.equal(electronCookiesToNetscape([]), '')
})

test('login marker detection follows session cookies', () => {
  assert.equal(hasLoginMarker(douyinCookies), true)
  assert.equal(hasLoginMarker([{ domain: '.x.com', name: 'auth_token', value: 'x-session' }]), true)
  assert.equal(hasLoginMarker([{ domain: '.facebook.com', name: 'c_user', value: '123' }]), true)
  assert.equal(hasLoginMarker([{ domain: '.douyin.com', name: 'ttwid', value: 'a1' }]), false)
  assert.equal(hasLoginMarker([{ domain: '.douyin.com', name: 'sessionid', value: '' }]), false)
})

test('X and Facebook login pages are explicit supported homes', () => {
  assert.equal(SITE_HOME['x.com'], 'https://x.com/')
  assert.equal(SITE_HOME['facebook.com'], 'https://www.facebook.com/')
})

test('openLogin polls until login then writes cookies file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-login-'))
  let polls = 0
  const service = new SiteLoginService({
    cookiesDir: dir,
    createWindow: () => ({
      loadURL: async () => {},
      getCookies: async () => douyinCookies,
      close: () => {},
      onClosed: () => {}
    })
  })
  const getSessionCookies = async () => {
    polls += 1
    return polls >= 2 ? douyinCookies : douyinCookies.slice(0, 2)
  }
  const result = await service.openLogin('douyin.com', getSessionCookies, { timeoutMs: 30000 })
  assert.equal(result.success, true)
  const written = fs.readFileSync(path.join(dir, 'douyin.com.txt'), 'utf8')
  assert.match(written, /sessionid/)
})

test('silentRefresh requires an existing session and writes fresh cookies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-login-'))
  const service = new SiteLoginService({
    cookiesDir: dir,
    createWindow: () => ({
      loadURL: async () => {},
      getCookies: async () => douyinCookies,
      close: () => {},
      onClosed: () => {}
    })
  })
  const noSession = await service.silentRefresh('douyin.com', async () => douyinCookies.slice(0, 2))
  assert.equal(noSession, false)
  const ok = await service.silentRefresh('douyin.com', async () => douyinCookies)
  assert.equal(ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'douyin.com.txt')))
})
