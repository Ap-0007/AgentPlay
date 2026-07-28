const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SiteVideoService, parseProgressLine, sanitizeTitle, cookiesFileForUrl, detectCookiesDomain } = require('../electron/site-video-service')
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

test('download retries with imported cookies.txt on login-required errors', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dl-'))
  const cookiesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-cookies-'))
  fs.writeFileSync(path.join(cookiesDir, 'douyin.com.txt'), '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\tabc\n')
  const seen = []
  const notes = []
  const service = new SiteVideoService({
    enginePath: process.execPath,
    cookiesDir,
    spawnImpl: fakeSpawn(({ child, args }) => {
      seen.push(args)
      if (!args.includes('--cookies')) {
        child.stderr.emit('data', Buffer.from('ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed'))
        child.emit('exit', 1)
      } else {
        const produced = path.join(destDir, '视频-BV1.mp4')
        fs.writeFileSync(produced, 'x')
        child.stdout.emit('data', Buffer.from(produced + '\n'))
        child.emit('exit', 0)
      }
    })
  })
  const result = await service.download('https://v.douyin.com/abc', { destDir, onRetryNote: (n) => notes.push(n) })
  assert.ok(result.outputPath.endsWith('视频-BV1.mp4'))
  assert.ok(seen[0] && !seen[0].includes('--cookies'), '首次应匿名尝试')
  assert.ok(seen.some((args) => args.includes('--cookies') && args.some((a) => a.endsWith('douyin.com.txt'))), '登录态错误后应带导入的 Cookies 重试')
  assert.ok(notes.some((n) => n.includes('已导入')))
})

test('missing imported cookies surfaces an actionable import guide', async () => {
  const service = new SiteVideoService({
    enginePath: process.execPath,
    cookiesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'site-cookies-')),
    spawnImpl: fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed'))
      child.emit('exit', 1)
    })
  })
  await assert.rejects(
    service.resolve('https://v.douyin.com/abc', {}),
    /需要浏览器登录态 Cookies.*导入 Cookies/
  )
})

test('stale imported cookies get a re-import guide', async () => {
  const cookiesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-cookies-'))
  fs.writeFileSync(path.join(cookiesDir, 'douyin.com.txt'), '.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\tabc\n')
  const service = new SiteVideoService({
    enginePath: process.execPath,
    cookiesDir,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('ERROR: [Douyin] Fresh cookies (not necessarily logged in) are needed'))
      child.emit('exit', 1)
    })
  })
  await assert.rejects(service.resolve('https://v.douyin.com/abc', {}), /已导入的 Cookies 失效.*重新导出/)
})

test('cookies file mapping and domain detection', () => {
  assert.equal(cookiesFileForUrl('/ck', 'https://v.douyin.com/abc'), path.join('/ck', 'douyin.com.txt'))
  assert.equal(cookiesFileForUrl('/ck', 'https://www.bilibili.com/video/BV1'), path.join('/ck', 'bilibili.com.txt'))
  assert.equal(cookiesFileForUrl('/ck', 'https://b23.tv/xyz'), path.join('/ck', 'bilibili.com.txt'))
  assert.equal(cookiesFileForUrl('/ck', 'https://youtu.be/xyz'), path.join('/ck', 'youtube.com.txt'))
  assert.equal(cookiesFileForUrl('', 'https://v.douyin.com/abc'), '')
  const sample = '# Netscape HTTP Cookie File\n.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\ta1\nwww.douyin.com\tFALSE\t/\tTRUE\t0\t__ac_nonce\tn1\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\ts1\n'
  const detected = detectCookiesDomain(sample)
  assert.equal(detected.domain, 'douyin.com')
  assert.equal(detected.count, 2)
  assert.equal(detectCookiesDomain('not a cookie file'), null)
})

test('editable fields get system edit menu and messages are selectable', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(main, /webContents\.on\('context-menu'/)
  assert.match(main, /role: 'paste', label: '粘贴'/)
  assert.match(main, /role: 'copy', label: '复制'/)
  assert.match(view, /closest\('input, textarea, \[contenteditable="true"\]'\)\) return/)
  assert.match(panel, /select-text/)
})

test('site video wiring: auto component download, chat route and model center card', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const center = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-download-service.js'), 'utf8')
  assert.match(main, /ipcMain\.handle\('media:site-download'/)
  assert.match(main, /ipcMain\.handle\('media:site-import-cookies'/)
  assert.match(main, /首次使用站点视频，正在下载解析组件/)
  assert.match(panel, /siteVideo\?\.download/)
  assert.match(panel, /站点视频下载/)
  assert.match(center, /站点视频解析组件 · yt-dlp 官方版/)
  assert.match(service, /裸链接视为下载意图/)
})
