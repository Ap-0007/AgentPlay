const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SiteVideoService, parseProgressLine, sanitizeTitle, cookiesFileForUrl, detectCookiesDomain, normalizeCookiesText, stripHashFromName } = require('../electron/site-video-service')
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

test('downloaded file names lose # so file:// and HTTP URLs cannot be truncated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hash-name-'))
  const withHash = path.join(dir, '讲一期产品 #创业日记-123.mp4')
  fs.writeFileSync(withHash, 'x')
  const renamed = stripHashFromName(withHash)
  assert.equal(renamed, path.join(dir, '讲一期产品 创业日记-123.mp4'))
  assert.ok(fs.existsSync(renamed))
  assert.ok(!fs.existsSync(withHash))
  const plain = path.join(dir, '普通视频-456.mp4')
  fs.writeFileSync(plain, 'x')
  assert.equal(stripHashFromName(plain), plain)
  // 目标已存在时保留原名，绝不覆盖
  const clash = path.join(dir, 'a#b.mp4')
  fs.writeFileSync(clash, 'x')
  fs.writeFileSync(path.join(dir, 'ab.mp4'), 'y')
  assert.equal(stripHashFromName(clash), clash)
})

test('JSON cookie exports (J2TEAM / Cookie-Editor) normalize to Netscape format', () => {
  const j2team = JSON.stringify([
    { domain: '.douyin.com', hostOnly: false, httpOnly: true, name: 'ttwid', path: '/', secure: true, expirationDate: 1780000000.5, value: 'a1' },
    { domain: 'www.douyin.com', hostOnly: true, name: '__ac_nonce', path: '/', secure: false, value: 'n1' },
    { domain: '.douyin.com', hostOnly: false, name: 'odin_tt', path: '/', session: true, value: 'o1' }
  ])
  const normalized = normalizeCookiesText(j2team)
  assert.ok(normalized.startsWith('# Netscape HTTP Cookie File'))
  assert.match(normalized, /\.douyin\.com\tTRUE\t\/\tTRUE\t1780000000\tttwid\ta1/)
  assert.match(normalized, /www\.douyin\.com\tFALSE\t\/\tFALSE\t0\t__ac_nonce\tn1/)
  assert.equal(detectCookiesDomain(normalized).domain, 'douyin.com')
  const wrapped = normalizeCookiesText(JSON.stringify({ cookies: [{ domain: '.bilibili.com', name: 'SESSDATA', value: 's1', path: '/', secure: true }] }))
  assert.match(wrapped, /\.bilibili\.com\tTRUE\t\/\tTRUE\t0\tSESSDATA\ts1/)
  assert.equal(normalizeCookiesText('{"broken":'), null)
  assert.equal(normalizeCookiesText('[]'), null)
  assert.equal(normalizeCookiesText('.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\ta1'), '.douyin.com\tTRUE\t/\tFALSE\t0\tttwid\ta1')
})

test('re-download of an already-fetched video reuses the existing file instead of failing', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dl-'))
  const existing = path.join(destDir, '老视频-BV1.mp4')
  fs.writeFileSync(existing, 'x'.repeat(50))
  const old = new Date(Date.now() - 60 * 60 * 1000)
  fs.utimesSync(existing, old, old)
  const service = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stdout.emit('data', Buffer.from(`[download] ${existing} has already been downloaded\n`))
      child.emit('exit', 0)
    })
  })
  const result = await service.download('https://v.douyin.com/abc', { destDir })
  assert.equal(result.outputPath, existing)
  assert.equal(result.bytes, 50)
})

test('yt-dlp GBK console output with Chinese path decodes to the real file', async () => {
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dl-'))
  const produced = path.join(destDir, '视频-BV1.mp4')
  fs.writeFileSync(produced, 'x'.repeat(10))
  // 中文版 Windows 控制台是 GBK 字节流：视=CA D3、频=C6 B5
  const gbkLine = Buffer.concat([
    Buffer.from(destDir + '\\', 'utf8'),
    Buffer.from([0xca, 0xd3, 0xc6, 0xb5]),
    Buffer.from('-BV1.mp4\r\n', 'utf8')
  ])
  const service = new SiteVideoService({
    enginePath: process.execPath,
    spawnImpl: fakeSpawn(({ child }) => {
      child.stdout.emit('data', gbkLine)
      child.emit('exit', 0)
    })
  })
  const result = await service.download('https://www.bilibili.com/video/BV1', { destDir })
  assert.equal(result.outputPath, produced)
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
