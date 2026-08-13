const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { framesFor } = require('../electron/creative-studio-service')

test('video frame count follows the 8n+1 contract', () => {
  assert.equal(framesFor(3, 24), 73)
  assert.equal(framesFor(1, 24), 25)
  assert.equal(framesFor(0.3, 24), 9)
  assert.equal(framesFor(5, 30), 153)
})

test('video generation uses Agnes field names, retry on busy, and whitelists the output host', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'creative-studio-service.js'), 'utf8')
  assert.match(service, /width: width \|\| 1280, height: height \|\| 720/)
  assert.match(service, /num_frames: numFrames, frame_rate: fps/)
  assert.doesNotMatch(service, /size: input\.size.*fps,/)
  assert.match(service, /缺少 video_id/)
  assert.match(service, /queue full|queue_full|fetch failed/)
  assert.match(service, /catch\(\(\) => null\)/, '轮询必须容忍网络抖动')
  assert.match(service, /internal_status/)
  assert.ok(service.includes('agnesapi?video_id=${encodeURIComponent(videoId)}`, { headers, signal: controller.signal }'), '轮询必须带 Bearer（漏带会 401）')
  assert.match(service, /let videoId = safeText\(input\.resumeVideoId/)
  assert.match(service, /input\.onCheckpoint\?\.\(\{ stage: 'remote-created', videoId, numFrames \}\)/)
  assert.ok(service.includes('预签名公开 URL：带 Authorization 头反而 401'), '下载必须裸拉（带认证头会 401）')
})

test('renderer treats mp4 generated assets as video clips, not looped images', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'creative-studio-service.js'), 'utf8')
  assert.match(service, /isVideoAsset = \/\\\.\(mp4\|mov\|webm\|mkv\)\$\/i\.test\(source\)/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.ok(main.includes("ipcMain.handle('studio:generate-video'"))
})
