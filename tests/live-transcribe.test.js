const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'live-transcribe-service.js'), 'utf8')
const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')

const { cuesToSrt } = require('../electron/live-transcribe-service.js')

test('live transcribe service: segmented ffmpeg extraction, whisper with timestamps, seek catch-up', () => {
  assert.match(service, /'-ss', String\(position\), '-t', String\(segmentSec\)/)
  assert.match(service, /'-ac', '1', '-ar', '16000'/)
  assert.match(service, /lang: 'auto', timestamps: true/)
  assert.match(service, /playingAt > position \+ segmentSec/)
  assert.match(service, /cue\.start \+ position/)
  // 无语音段不中断整片
  assert.match(service, /transcribe\(\{[^}]*\}\)\.catch\(\(\) => null\)/)
})

test('live transcribe IPC: availability gates, session, srt written without overwriting', () => {
  assert.match(main, /ipcMain\.handle\('subtitle:live-transcribe-start'/)
  assert.match(main, /transcriptionService\.availability\(\)/)
  assert.match(main, /videoFrames\.availability\(\)\.available/)
  assert.match(main, /videoFrames\.probeDuration/)
  assert.match(main, /type: 'transcribe-cues', cues/)
  assert.match(main, /-AgentPlay识别\.srt/)
  assert.match(main, /if \(!fs\.existsSync\(candidate\)\) fs\.writeFileSync/)
  // seek/stop 同时管理翻译与识别两个会话
  assert.match(main, /liveTranscribeSession\.position = position/)
  assert.match(main, /liveTranscribeSession\.controller\.abort\(\)/)
  assert.match(preload, /startTranscribe: \(input\) => ipcRenderer\.invoke\('subtitle:live-transcribe-start', input\)/)
})

test('mpv live bridge: accumulating srt attached then reloaded for instant visibility', () => {
  // mpv 播放时渲染层不叠显实时字幕，必须走累积 srt + sub-add/sub-reload，否则用户全程看不到
  assert.match(main, /liveSrtPath: path\.join\(app\.getPath\('temp'\)/)
  assert.match(main, /mpv\.loadSubtitle\(session\.liveSrtPath\)/)
  assert.match(main, /mpv\.send\(\{ command: \['sub-reload'\] \}\)/)
  assert.match(main, /rmSync\(liveTranscribeSession\.liveSrtPath/)
})

test('player view: transcribe-cues append to live subtitle track, action routed', () => {
  assert.match(playerView, /event\.type === 'transcribe-cues'/)
  assert.match(playerView, /toggleLiveTranscribe/)
  assert.match(playerView, /startTranscribe\(\{/)
  assert.match(playerView, /action === 'live-transcribe-subtitle'/)
  assert.match(playerView, /识别一句显示一句/)
})

test('cuesToSrt produces valid srt with absolute timestamps', () => {
  const srt = cuesToSrt([
    { index: 1, start: 61.5, end: 64.2, text: '你好世界' },
    { index: 2, start: 65, end: 67.25, text: '第二句' }
  ])
  assert.ok(srt.includes('00:01:01,500 --> 00:01:04,200'))
  assert.ok(srt.includes('00:01:05,000 --> 00:01:07,250'))
  assert.ok(srt.includes('你好世界'))
})
