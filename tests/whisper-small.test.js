const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const transcription = fs.readFileSync(path.join(__dirname, '..', 'electron', 'transcription-service.js'), 'utf8')
const manifest = fs.readFileSync(path.join(__dirname, '..', 'electron', 'whisper-small-pack-manifest.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
const playerView = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')

const { toSimplified } = require('../electron/transcription-service.js')

test('small pack manifest: pinned sha256 and size match the published asset', () => {
  assert.match(manifest, /whisper-small-pack-v1/)
  assert.match(manifest, /ggml-small\.bin/)
  assert.match(manifest, /size: 487601967/)
  assert.match(manifest, /sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'/)
})

test('transcription service: optional model with path-traversal-safe whitelist, small availability', () => {
  assert.match(transcription, /smallAvailable/)
  assert.match(transcription, /\^ggml-\[\\w\.\-\]\+\\\.bin\$/)
  assert.match(transcription, /modelFile.*ggml-tiny\.bin/)
  // zh 输出过繁转简映射
  assert.match(transcription, /if \(lang === 'zh'\) text = toSimplified\(text\)/)
})

test('small download wired: service, IPC, status, preload', () => {
  assert.match(main, /whisperSmallDownload = new LocalAiDownloadService/)
  assert.match(main, /WHISPER_SMALL_PACK/)
  assert.match(main, /ipcMain\.handle\('transcribe:download-small'/)
  assert.match(main, /smallDownload: whisperSmallDownload\.status\(\)/)
  assert.match(preload, /downloadSmall: \(\) => ipcRenderer\.invoke\('transcribe:download-small'\)/)
})

test('dual-track refine: after tiny draft, small model refines in background and replaces srt', () => {
  assert.match(main, /availability\(\)\.smallAvailable/)
  assert.match(main, /model: 'ggml-small\.bin'/)
  assert.match(main, /type: 'refining'/)
  assert.match(main, /type: 'refined', srtPath, cueCount/)
  assert.match(main, /type: 'refine-failed'/)
  assert.match(playerView, /event\.type === 'refined' && event\.srtPath/)
  assert.match(playerView, /字幕已精修/)
})

test('model center shows optional small refine download', () => {
  assert.match(modelCenter, /精修转写模型 · ggml-small（可选）/)
  assert.match(modelCenter, /下载精修模型/)
  assert.match(modelCenter, /downloadSmall/)
})

test('toSimplified converts common traditional chars without touching simplified text', () => {
  assert.equal(toSimplified('創意的項目殘留老闆總部'), '创意的项目残留老板总部')
  assert.equal(toSimplified('這個視頻內容應該學習'), '这个视频内容应该学习')
  assert.equal(toSimplified('简体中文不受影响'), '简体中文不受影响')
  assert.equal(toSimplified(''), '')
})
