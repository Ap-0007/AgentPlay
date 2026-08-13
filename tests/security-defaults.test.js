const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const ExcelJS = require('exceljs')
const { buildSpreadsheetHtml, previewXlsx } = require('../electron/office-preview')
const { WifiTransfer } = require('../electron/wifi-transfer')

const root = path.join(__dirname, '..')
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('LAN-facing services stay stopped until an explicit renderer request', () => {
  const main = source('electron/main.js')
  const startup = main.slice(main.indexOf('app.whenReady()'), main.indexOf('// mpv 事件转发'))

  assert.doesNotMatch(startup, /await\s+wifiTransfer\.start/)
  assert.doesNotMatch(startup, /await\s+syncService\.start/)
  assert.doesNotMatch(startup, /await\s+dlnaServer\.start/)
  assert.doesNotMatch(startup, /await\s+dlnaReceiver\.start/)
  assert.match(main, /ipcMain\.handle\('wifi:url',\s*async/)
  assert.match(main, /ipcMain\.handle\('sync:url',\s*async/)
  assert.match(main, /ipcMain\.handle\('dlna:serverUrl',\s*async/)
  assert.match(main, /ipcMain\.handle\('receiver:start',\s*async/)

  const library = source('src/components/MediaLibrary.tsx')
  assert.doesNotMatch(library, /useEffect\(\(\)\s*=>\s*\{[\s\S]{0,300}wifi\.url\(\)/)
  assert.match(library, /启用 WiFi 传文件/)
  assert.match(library, /启用跨设备同步/)
  assert.match(library, /启用接收投屏/)
})

test('voice wake is removed because Electron lacks the Web Speech API', () => {
  // 该功能依赖 webkitSpeechRecognition（Electron 没有），此前只能装死；已按审计结论下线
  const app = source('src/App.tsx')
  const panel = agentPanelSource()
  assert.doesNotMatch(app, /VoiceWake|aiplayer_voice_wake_enabled/)
  assert.doesNotMatch(panel, /webkitSpeechRecognition|SpeechRecognitionInstance/)
  assert.match(panel, /MediaRecorder/)
})

test('Office preview is sandboxed and spreadsheet cells are escaped', () => {
  const player = source('src/components/PlayerView.tsx')
  const pkg = JSON.parse(source('package.json'))

  assert.doesNotMatch(player, /dangerouslySetInnerHTML/)
  assert.match(player, /sandbox=""/)
  assert.match(player, /Content-Security-Policy/)
  assert.equal(pkg.dependencies.xlsx, undefined)
  assert.equal(pkg.dependencies.exceljs, '4.4.0')
  assert.equal(
    buildSpreadsheetHtml([['<img src=x onerror=alert(1)>']]),
    '<table><tbody><tr><td>&lt;img src=x onerror=alert(1)&gt;</td></tr></tbody></table>'
  )
})

test('ExcelJS reads a real xlsx workbook after the patched uuid override', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-xlsx-'))
  const filePath = path.join(dir, 'safe.xlsx')
  try {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['标题', '<script>alert(1)</script>'])
    await workbook.xlsx.writeFile(filePath)
    const result = await previewXlsx(filePath)
    assert.equal(result.success, true)
    assert.match(result.html, /标题/)
    assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.doesNotMatch(result.html, /<script>/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('WiFi upload authenticates before multipart parsing and never renders the PIN', async () => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-wifi-secure-'))
  const wifi = new WifiTransfer()
  wifi.port = 47000 + (process.pid % 1000)
  wifi.uploadDir = uploadDir
  wifi.getLanIp = () => '127.0.0.1'
  try {
    await wifi.start()
    const page = await (await fetch(wifi.getUrl())).text()
    assert.equal(page.includes(wifi.getPin()), false)
    assert.match(page, /X-AI-Player-PIN/)

    const rejected = new FormData()
    rejected.append('file', new Blob(['blocked']), 'blocked.txt')
    const rejectedResponse = await fetch(wifi.getUrl(), { method: 'POST', body: rejected })
    assert.equal(rejectedResponse.status, 403)
    assert.deepEqual(fs.readdirSync(uploadDir), [])

    const accepted = new FormData()
    accepted.append('file', new Blob(['allowed']), 'allowed.txt')
    const acceptedResponse = await fetch(wifi.getUrl(), {
      method: 'POST',
      headers: { 'X-AI-Player-PIN': wifi.getPin() },
      body: accepted
    })
    assert.equal(acceptedResponse.status, 200)
    assert.equal(fs.readFileSync(path.join(uploadDir, 'allowed.txt'), 'utf8'), 'allowed')
  } finally {
    wifi.stop()
    fs.rmSync(uploadDir, { recursive: true, force: true })
  }
})

test('every ipcMain.handle asserts a trusted sender before touching state', () => {
  const main = source('electron/main.js')
  const missing = []
  for (const match of main.matchAll(/ipcMain\.handle\('([^']+)',\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]{0,120})/g)) {
    const [, channel, head] = match
    if (!head.includes('assertTrustedSender')) missing.push(channel)
  }
  assert.deepEqual(missing, [], `以下通道缺少 assertTrustedSender: ${missing.join(', ')}`)
})

test('shared path gate blocks sensitive files and executables', () => {
  const main = source('electron/main.js')
  assert.match(main, /SENSITIVE_FILE = .*\[\\\\\/\]\)\\\.env/)
  assert.match(main, /EXECUTABLE_EXTS = new Set\(\['\.exe', '\.bat'/)
  assert.match(main, /function assertAllowedPath\(/)
  assert.match(main, /system:openPath[\s\S]{0,300}denyExecutable: true/)
  assert.match(main, /files:readText[\s\S]{0,200}assertAllowedPath/)
  assert.match(main, /docx:preview[\s\S]{0,150}assertAllowedPath/)
  assert.match(main, /xlsx:preview[\s\S]{0,150}assertAllowedPath/)
  assert.match(main, /cast:cast[\s\S]{0,300}assertAllowedPath/)
})

test('saved API key cannot be redirected to an attacker baseUrl', () => {
  const main = source('electron/main.js')
  // 用已存 Key 时必须钉死已存 baseUrl（models:list 与 models:test 各一处）
  const pins = main.match(/钉死已存地址/g) || []
  assert.ok(pins.length >= 2, 'models:list/test 都必须钉死已存地址')
  assert.match(main, /baseUrl: saved\.baseUrl/)
})
