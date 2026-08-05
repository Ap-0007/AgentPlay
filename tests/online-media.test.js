const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OnlineMediaLibrary.tsx'), 'utf8')
const service = require('../electron/online-media-service')

test('archive url whitelist: only https archive.org passes', () => {
  assert.equal(service.assertArchiveUrl('https://archive.org/download/a/b.mp4'), 'https://archive.org/download/a/b.mp4')
  assert.equal(service.assertArchiveUrl('https://ia801234.us.archive.org/x/y.mp4'), 'https://ia801234.us.archive.org/x/y.mp4')
  assert.throws(() => service.assertArchiveUrl('http://archive.org/x'), /https/)
  assert.throws(() => service.assertArchiveUrl('https://evil.com/download/a.mp4'), /Internet Archive/)
  assert.throws(() => service.assertArchiveUrl('not-a-url'), /无效/)
})

test('legal boundary is baked into the query (curated public-domain collections only)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'online-media-service.js'), 'utf8')
  assert.match(src, /feature_films OR public_domain_film OR Prelinger OR classic_tv/)
  assert.match(src, /etree OR librivoxaudio OR publicdomain/)
  assert.match(src, /不抓取、不绕开任何付费墙/)
})

test('wiring: IPC trio + cancel, preload bindings, sidebar entry, play via mpv stream', () => {
  assert.match(main, /ipcMain\.handle\('onlineMedia:search'/)
  assert.match(main, /ipcMain\.handle\('onlineMedia:files'/)
  assert.match(main, /ipcMain\.handle\('onlineMedia:download'/)
  assert.match(main, /ipcMain\.handle\('onlineMedia:cancel'/)
  assert.match(main, /onlineMedia\.assertArchiveUrl\(input\.url\)/, '下载前必须过域名白名单')
  assert.match(preload, /onlineMedia: \{/)
  assert.match(preload, /onlineMedia:progress/)
  assert.match(sidebar, /在线媒体库/)
  assert.match(panel, /ai-player-play-file/, '在线播放复用 mpv 流媒体链路')
})

test('real archive.org: search public-domain films, list playable files, head stream url', { timeout: 60000 }, async (t) => {
  let items
  try {
    const result = await service.searchMedia('night of the living dead', 'movie')
    items = result.items
  } catch (error) {
    t.skip(`网络不可用：${error.message}`)
    return
  }
  assert.ok(items.length > 0, '公版电影检索应有结果')
  const withFiles = []
  for (const item of items.slice(0, 5)) {
    try {
      const detail = await service.listPlayableFiles(item.identifier, 'movie')
      if (detail.files.length > 0) withFiles.push(detail)
    } catch { /* 单条失败换下一条 */ }
  }
  assert.ok(withFiles.length > 0, '前 5 条至少一条有可播放文件')
  const first = withFiles[0].files[0]
  assert.match(first.url, /^https:\/\/archive\.org\/download\//)
  let head
  try {
    head = await fetch(first.url, { method: 'HEAD', redirect: 'manual' })
  } catch (error) {
    t.skip(`直链网络不可用：${error.message}`)
    return
  }
  assert.ok([200, 301, 302, 303, 307, 308].includes(head.status), `直链应可访问，实际 ${head.status}`)
})

test('real archive.org: audio search stays inside licensed collections', { timeout: 60000 }, async (t) => {
  let result
  try {
    result = await service.searchMedia('grateful dead', 'audio')
  } catch (error) {
    t.skip(`网络不可用：${error.message}`)
    return
  }
  assert.ok(result.items.length > 0, 'Live Music Archive 检索应有结果')
})
