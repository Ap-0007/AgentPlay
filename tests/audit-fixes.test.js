const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

test('playback and window actions have a global fallback handler outside PlayerView', () => {
  const app = source('src/App.tsx')
  assert.match(app, /__playerActionMounted/)
  assert.match(app, /action\.startsWith\('window-'\)[\s\S]{0,200}windowControls\?\.setPreset/)
  assert.match(app, /play-toggle[\s\S]{0,200}player\.play\(\)/)
  const view = source('src/components/PlayerView.tsx')
  assert.match(view, /__playerActionMounted = true/)
  assert.match(view, /delete \(window as unknown as Record<string, unknown>\)\.__playerActionMounted/)
})

test('previously orphaned library actions are reachable via chat intent routes', () => {
  // 产品决策：功能菜单保持 4 个日常项，低频能力走「一句话触发」（对话路由），不加菜单项
  const main = source('electron/main.js')
  const menuBlock = main.slice(main.indexOf("{ label: '功能', submenu: ["), main.indexOf("{ label: '窗口', submenu: ["))
  assert.ok(!menuBlock.includes('屏幕录制'), '菜单保持精简，屏幕录制不进菜单')
  const panel = source('src/components/AgentPanel.tsx')
  for (const action of ['record', 'organize', 'plugins', 'poster']) {
    assert.ok(panel.includes(`'${action}'`), `对话路由缺少 ${action}`)
  }
  assert.match(panel, /屏幕录制\|开始录制\|录屏/)
  assert.match(panel, /ai-player-action', \{ detail: libraryHit\[1\] \}/)
  const app = source('src/App.tsx')
  assert.match(app, /libraryActions/)
})

test('mirror card and cast status are not nested inside the wifi-enabled branch', () => {
  const library = source('src/components/MediaLibrary.tsx')
  const wifiStart = library.indexOf('📱 WiFi 传文件')
  const wifiEnd = library.indexOf('启用 WiFi 传文件')
  const mirrorIdx = library.indexOf('AgentPlay 互投（屏幕镜像）')
  const castIdx = library.indexOf('{showMore && castStatus && (')
  assert.ok(mirrorIdx > wifiEnd, '互投卡片必须在 WiFi 启用分支之外')
  assert.ok(castIdx > wifiEnd, '投屏状态条必须在 WiFi 启用分支之外')
  assert.ok(mirrorIdx > wifiStart)
})

test('mic path uses MediaRecorder + local whisper, not the missing Web Speech API', () => {
  const panel = source('src/components/AgentPanel.tsx')
  assert.match(panel, /MediaRecorder/)
  assert.match(panel, /transcribe\?\.blob/)
  assert.doesNotMatch(panel, /webkitSpeechRecognition/)
  assert.doesNotMatch(panel, /SpeechRecognitionInstance/)
  const main = source('electron/main.js')
  assert.ok(main.includes("ipcMain.handle('transcribe:blob'"))
  const preload = source('electron/preload.js')
  assert.ok(preload.includes("invoke('transcribe:blob'"))
  const app = source('src/App.tsx')
  assert.doesNotMatch(app, /VoiceWake/)
  assert.doesNotMatch(app, /voice-wake-toggle/)
})

test('print failures surface to the user instead of being swallowed', () => {
  const library = source('src/components/MediaLibrary.tsx')
  assert.match(library, /result\.error \|\| '打印失败'/)
  const view = source('src/components/PlayerView.tsx')
  assert.match(view, /result\.error \|\| '打印失败'/)
  const main = source('electron/main.js')
  assert.match(main, /assertPrintablePath[\s\S]{0,300}allowedRoots\(\)/)
})

test('agent panel stop button dispatches cancel per pending task kind', () => {
  const panel = source('src/components/AgentPanel.tsx')
  assert.match(panel, /pending === 'download' \|\| pending === 'link-analysis'/)
  assert.match(panel, /mediaDownload\?\.cancel\(requestId\)/)
  assert.match(panel, /analysis\?\.cancel\(requestId\)/)
  // 无本地视频提前返回时必须复位任务锁，否则面板永久静默
  assert.match(panel, /当前没有可解剖的本地视频[\s\S]{0,80}docBusyRef\.current = false|docBusyRef\.current = false[\s\S]{0,80}当前没有可解剖的本地视频/)
})

test('mirror discovery uses a per-scan local result map', () => {
  const mirror = source('electron/mirror-service.js')
  assert.doesNotMatch(mirror, /this\.found\.set\(/)
  assert.match(mirror, /const found = new Map\(\)/)
})

test('duplicate scan hashes files asynchronously', () => {
  const media = source('electron/media-service.js')
  assert.match(media, /createReadStream\(filePath\)/)
  assert.doesNotMatch(media, /fs\.readSync\(/)
  assert.match(media, /async function findDuplicates/)
})
