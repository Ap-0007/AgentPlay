const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { buildTranscriptionStatus, subtitleMediaKey } = require('../electron/subtitle-job-policy')

test('transcription status names the expensive stage and gives a duration-based estimate', () => {
  const status = buildTranscriptionStatus(338)
  assert.match(status, /本机识别语音/)
  assert.match(status, /分钟/)
  assert.match(status, /翻译/)
  assert.doesNotMatch(status, /约为音频时长数倍/)
})

test('same media path normalizes to one job key on Windows', () => {
  assert.equal(subtitleMediaKey('D:\\Videos\\A.mp4'), subtitleMediaKey('d:/videos/A.mp4'))
})

test('main process enforces one subtitle generation job per media file', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(main, /activeSubtitleMediaJobs/)
  assert.match(main, /这个视频已有字幕任务正在识别或翻译/)
  assert.match(main, /persistentTaskRuntime\.register\('subtitle\.generate'/)
  assert.match(main, /buildTranscriptionStatus\(/)
})
