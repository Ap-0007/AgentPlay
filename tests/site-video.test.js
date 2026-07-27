const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SiteVideoService, parseProgressLine, sanitizeTitle } = require('../electron/site-video-service')
const YTDLP_PACK = require('../electron/ytdlp-pack-manifest')

function fakeSpawn(responder) {
  const { EventEmitter } = require('events')
  return (file, args) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    process.nextTick(() => responder({ file, args, child }))
    return child
  }
}

test('pack manifest pins the official yt-dlp release hash', () => {
  const asset = YTDLP_PACK.assets.find((a) => a.id === 'yt-dlp-win-x64')
  assert.ok(asset)
  assert.equal(asset.url, 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe')
  assert.equal(asset.size, 18226085)
  assert.equal(asset.sha256, '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8')
  const staged = path.join(__dirname, '..', 'release', 'yt-dlp-pack', 'yt-dlp.exe')
  if (fs.existsSync(staged)) assert.equal(fs.statSync(staged).size, asset.size)
})

test('progress line parsing handles percent rows only', () => {
  assert.deepEqual(parseProgressLine('[download]  45.2% of 100.00MiB at 1.20MiB/s'), { percent: 45.2, size: '100.00MiB' })
  assert.equal(parseProgressLine('[BiliBili] BV1xx: Downloading JSON metadata'), null)
  assert.equal(sanitizeTitle('敢想:敢不同?/\\'), '敢想_敢不同___')
})

test('resolve parses yt-dlp json output and rejects non-video pages', async () => {
  const service = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child, args }) => {
      if (args.includes('--dump-single-json')) {
        child.stdout.emit('data', Buffer.from('{"title":"敢想敢不同","duration":172,"uploader":"荣耀手机","extractor_key":"BiliBili"}\n'))
        child.emit('exit', 0)
      }
    })
  })
  const info = await service.resolve('https://www.bilibili.com/video/BV1NH3j6pEve')
  assert.equal(info.title, '敢想敢不同')
  assert.equal(info.uploader, '荣耀手机')
  assert.equal(info.extractor, 'BiliBili')

  const bad = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stdout.emit('data', Buffer.from('{"title":null}\n'))
      child.emit('exit', 0)
    })
  })
  await assert.rejects(bad.resolve('https://example.com/news'), /没有解析到视频信息/)
})

test('download returns produced file and surfaces yt-dlp failures honestly', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dl-'))
  const produced = path.join(destDir, '敢想敢不同-BV1.mp4')
  const progresses = []
  const ok = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stdout.emit('data', Buffer.from('[download]  45.2% of 15.00MiB at 1.20MiB/s\n'))
      child.stdout.emit('data', Buffer.from(produced + '\n'))
      fs.writeFileSync(produced, 'x'.repeat(100))
      child.emit('exit', 0)
    })
  })
  const result = await ok.download('https://www.bilibili.com/video/BV1', { destDir, onProgress: (p) => progresses.push(p) })
  assert.equal(result.outputPath, produced)
  assert.equal(result.bytes, 100)
  assert.deepEqual(progresses, [{ percent: 45.2, size: '15.00MiB' }])

  const failing = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('ERROR: This video is only available for registered users'))
      child.emit('exit', 1)
    })
  })
  await assert.rejects(failing.download('https://example.com/vip', { destDir }), /only available for registered users/)
})

test('site video wiring: auto component download, chat route and model center card', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const center = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-download-service.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('media:site-download'/)
  assert.match(main, /首次使用站点视频，正在下载解析组件/)
  assert.match(panel, /siteVideo\?\.download/)
  assert.match(panel, /站点视频下载/)
  assert.match(center, /站点视频解析组件 · yt-dlp 官方版/)
  assert.match(service, /裸链接视为下载意图/)
})
