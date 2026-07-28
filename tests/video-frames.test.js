const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  VideoFrameService,
  frameBudget,
  formatTimestamp,
  meanAbsDiff,
  dedupeThumbs,
  thinToBudget
} = require('../electron/video-frame-service')

test('frame budget scales with duration and caps at 20', () => {
  assert.equal(frameBudget(10), 12)
  assert.equal(frameBudget(45), 16)
  assert.equal(frameBudget(120), 20)
  assert.equal(frameBudget(3600), 20)
})

test('timestamp formatting is mm:ss', () => {
  assert.equal(formatTimestamp(0), '00:00')
  assert.equal(formatTimestamp(65), '01:05')
  assert.equal(formatTimestamp(3599), '59:59')
})

test('dedup compares against last kept frame to catch fades', () => {
  const black = Buffer.alloc(256, 0)
  const almostBlack = Buffer.alloc(256, 1)
  const bright = Buffer.alloc(256, 200)
  assert.equal(meanAbsDiff(black, almostBlack), 1)
  assert.deepEqual(dedupeThumbs([black, almostBlack, bright]), [0, 2])
  // 渐变：1→2 每步差 1，单步不超阈值但与保留帧比累计超阈值
  const steps = Array.from({ length: 6 }, (_, i) => Buffer.alloc(256, i))
  assert.deepEqual(dedupeThumbs(steps, 2.0), [0, 3])
})

test('thinning keeps coverage from head to tail', () => {
  assert.deepEqual(thinToBudget([0, 1, 2], 5), [0, 1, 2])
  const thinned = thinToBudget([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)
  assert.equal(thinned[0], 0)
  assert.equal(thinned[thinned.length - 1], 9)
  assert.equal(thinned.length <= 4, true)
})

function fakeFfmpeg({ sceneFrames = [], uniformFrames = 0, thumbs = [], sceneFails = false } = {}) {
  const { EventEmitter } = require('events')
  const calls = []
  const spawnImpl = (file, args) => {
    calls.push(args)
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => {
      if (args.includes('-f') && args.includes('rawvideo')) {
        const outPath = args[args.length - 1]
        fs.writeFileSync(outPath, Buffer.concat(thumbs))
        child.emit('exit', 0)
        return
      }
      const outPattern = args[args.length - 1]
      const isUniform = args.some((a) => String(a).startsWith('fps='))
      if (!isUniform && sceneFails) {
        child.stderr.emit('data', Buffer.from('Conversion failed!\n'))
        child.emit('exit', 1)
        return
      }
      const count = isUniform ? uniformFrames : sceneFrames.length
      for (let i = 0; i < count; i++) {
        fs.writeFileSync(outPattern.replace('%04d', String(i + 1).padStart(4, '0')), Buffer.from([i + 1]))
        if (!isUniform) child.stderr.emit('data', Buffer.from(`[Parsed_showinfo_1] n: ${i} pts_time:${sceneFrames[i]}\n`))
      }
      child.emit('exit', 0)
    })
    return child
  }
  return { spawnImpl, calls }
}

test('extract dedupes scene frames and labels timestamps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'))
  const video = path.join(dir, 'v.mp4')
  fs.writeFileSync(video, 'fake')
  const { spawnImpl } = fakeFfmpeg({
    sceneFrames: [0.5, 1.0, 8.0, 9.0],
    thumbs: [Buffer.alloc(256, 0), Buffer.alloc(256, 1), Buffer.alloc(256, 200), Buffer.alloc(256, 201)]
  })
  const service = new VideoFrameService({ ffmpegPath: process.execPath, spawnImpl })
  const outDir = path.join(dir, 'frames')
  const frames = await service.extract({ sourcePath: video, durationSec: 30, outDir })
  assert.deepEqual(frames.map((f) => f.label), ['t=00:01', 't=00:08'])
  assert.equal(fs.readdirSync(outDir).filter((n) => n.endsWith('.jpg')).length, 2)
})

test('extract falls back to uniform sampling when scene detection under-produces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'))
  const video = path.join(dir, 'v.mp4')
  fs.writeFileSync(video, 'fake')
  const { spawnImpl, calls } = fakeFfmpeg({ sceneFrames: [0.5], uniformFrames: 12, thumbs: Array.from({ length: 12 }, (_, i) => Buffer.alloc(256, i * 20)) })
  const service = new VideoFrameService({ ffmpegPath: process.execPath, spawnImpl })
  const outDir = path.join(dir, 'frames')
  const frames = await service.extract({ sourcePath: video, durationSec: 30, outDir })
  assert.ok(calls.some((args) => args.some((a) => String(a).startsWith('fps='))), '应触发均匀采样兜底')
  assert.ok(frames.length > 8)
  assert.equal(frames[0].label, 't=00:00')
  assert.match(frames[frames.length - 1].label, /^t=00:2[0-9]$/)
})

test('scene pass hard failure (e.g. limited-range HEVC) still falls back to uniform', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'))
  const video = path.join(dir, 'v.mp4')
  fs.writeFileSync(video, 'fake')
  const { spawnImpl, calls } = fakeFfmpeg({ sceneFails: true, uniformFrames: 12, thumbs: Array.from({ length: 12 }, (_, i) => Buffer.alloc(256, i * 20)) })
  const service = new VideoFrameService({ ffmpegPath: process.execPath, spawnImpl })
  const frames = await service.extract({ sourcePath: video, durationSec: 30, outDir: path.join(dir, 'frames') })
  assert.ok(calls.some((args) => args.some((a) => String(a).startsWith('fps='))), 'scene 硬失败必须退均匀采样')
  assert.ok(frames.length > 0)
  // 两路 jpeg 滤镜都必须带 format=yuvj420p，否则窄色域 HEVC 让 mjpeg 初始化失败
  const jpegFilters = calls.filter((args) => args.some((a) => String(a).endsWith('%04d.jpg'))).map((args) => args[args.indexOf('-vf') + 1])
  assert.ok(jpegFilters.every((f) => f.includes('format=yuvj420p')))
})

test('extract returns empty without ffmpeg or source', async () => {
  const service = new VideoFrameService({ ffmpegPath: path.join(os.tmpdir(), 'no-such-ffmpeg.exe') })
  assert.deepEqual(await service.extract({ sourcePath: __filename, outDir: os.tmpdir() }), [])
})
