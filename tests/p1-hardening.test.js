const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { TranscriptionService } = require('../electron/transcription-service')

const root = path.join(__dirname, '..')
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

function fakeChild() {
  const { EventEmitter } = require('events')
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true }
  return child
}

test('transcribe aborts the whisper child process on signal', async () => {
  const { EventEmitter } = require('events')
  const os = require('os')
  const bus = new EventEmitter()
  const signal = {
    aborted: false,
    addEventListener: (name, fn) => bus.on(name, fn),
    removeEventListener: (name, fn) => bus.off(name, fn)
  }
  const children = []
  const service = new TranscriptionService({
    whisperRoot: __dirname,
    spawnImpl: () => {
      const child = fakeChild()
      children.push(child)
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from(''))
        child.emit('close', 0)
      })
      return child
    }
  })
  service.availability = () => ({ available: true })
  const audio = path.join(os.tmpdir(), 'abort-test.mp3')
  fs.writeFileSync(audio, Buffer.from('fake-audio'))
  const pending = service.transcribe({ sourcePath: audio, signal })
  signal.aborted = true
  bus.emit('abort')
  await assert.rejects(pending, /已取消/)
  assert.ok(children[0].killed, '取消必须杀子进程')
})

test('stopAll kills every active child for quit cleanup', () => {
  const service = new TranscriptionService({ whisperRoot: __dirname, spawnImpl: () => fakeChild() })
  const a = fakeChild()
  const b = fakeChild()
  service.activeChildren.add(a)
  service.activeChildren.add(b)
  service.stopAll()
  assert.ok(a.killed && b.killed)
  assert.equal(service.activeChildren.size, 0)
})

test('quit cleanup covers analysis, downloads, mirror, live subtitle and whisper', () => {
  const main = source('electron/main.js')
  const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('before-quit'") + 1200)
  assert.match(quit, /activeAnalysisRequests\.values\(\)\) controller\.abort/)
  assert.match(quit, /activeMediaDownloads\.values\(\)\) controller\.abort/)
  assert.match(quit, /transcriptionService\.stopAll\(\)/)
  assert.match(quit, /mirrorReceiver\?\.stop\(\)/)
  assert.match(quit, /mirrorSender\?\.close\(\)/)
})

test('chat tool loop honours the outer abort signal', () => {
  const llm = source('electron/llm-service.js')
  assert.match(llm, /options\.signal\?\.aborted\) return \{ text: '\[已取消\]'/)
  assert.match(llm, /onOuterAbort/)
})

test('bilingual generation is cancellable and whispers with a signal', () => {
  const main = source('electron/main.js')
  assert.ok(main.includes("ipcMain.handle('subtitle:bilingual-cancel'"))
  assert.match(main, /transcriptionService\.transcribe\(\{ sourcePath: mediaPath, lang: 'auto', timestamps: true, signal: controller\.signal \}/)
  assert.match(main, /activeAnalysisRequests\.set\(cancelKey, controller\)/)
})

test('wifi upload lands via rename or thread-pool copy, never sync copy', () => {
  const wifi = source('electron/wifi-transfer.js')
  assert.match(wifi, /fs\.renameSync/)
  assert.match(wifi, /fs\.promises\.copyFile/)
  assert.doesNotMatch(wifi, /fs\.copyFileSync/)
})

test('xlsx preview truncates to 1000 rows with an honest note', () => {
  const office = source('electron/office-preview.js')
  assert.match(office, /MAX_ROWS = 1000/)
  assert.match(office, /仅预览前/)
})

test('cloud consent is granted once per session via a native dialog', () => {
  const main = source('electron/main.js')
  assert.match(main, /let cloudConsentGranted = false/)
  assert.match(main, /dialog\.showMessageBox\(mainWindow, \{[\s\S]{0,200}云端发送确认/)
  const consents = main.match(/await ensureCloudConsent\(/g) || []
  assert.ok(consents.length >= 3, '文档/链接拉片/本地解剖三处都应走原生确认')
})

test('cast SOAP calls carry timeouts and dlna receiver caps body size', () => {
  const cast = source('electron/cast-service.js')
  assert.ok((cast.match(/AbortSignal\.timeout\(15000\)/g) || []).length >= 3)
  const receiver = source('electron/dlna-receiver.js')
  assert.match(receiver, /1024 \* 1024/)
  assert.match(receiver, /413/)
})

test('frame extraction threads the cancel signal through all ffmpeg passes', () => {
  const frames = source('electron/video-frame-service.js')
  assert.match(frames, /async extract\(\{ sourcePath, durationSec = 0, outDir, budget, signal \}/)
  assert.ok((frames.match(/\], \{ signal \}\)/g) || []).length >= 3)
  const chat = source('electron/analysis-chat-service.js')
  assert.match(chat, /outDir: path\.join\(os\.tmpdir\(\), `agentplay-frames-\$\{Date\.now\(\)\}`\), signal \}/)
})

test('long videos are refused upfront instead of burning CPU into a timeout', () => {
  const main = source('electron/main.js')
  assert.match(main, /dur > 45 \* 60/)
  assert.match(main, /dur \* 3000 \+ 5 \* 60 \* 1000/)
})
