const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OnlineMediaLibrary.tsx'), 'utf8')
const service = require('../electron/online-media-service')
const NETWORK_TEST_TIMEOUT_MS = 8000
const NETWORK_TEST_OPTIONS = { timeoutMs: NETWORK_TEST_TIMEOUT_MS, attempts: 1 }

test('archive request timeout aborts the underlying fetch and clears successful timers', async () => {
  let timedOutSignal
  const hangingFetch = async (_url, { signal }) => {
    timedOutSignal = signal
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  await assert.rejects(
    service.__test.fetchWithTimeout('https://archive.org/test', {}, { timeoutMs: 20, fetchImpl: hangingFetch }),
    /网络请求超时/
  )
  assert.equal(timedOutSignal.aborted, true)

  let successfulSignal
  const immediateFetch = async (_url, { signal }) => {
    successfulSignal = signal
    return { ok: true }
  }
  await service.__test.fetchWithTimeout('https://archive.org/test', {}, { timeoutMs: 20, fetchImpl: immediateFetch })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(successfulSignal.aborted, false, '成功请求必须清理超时定时器')
})


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

test('real archive.org: search public-domain films, list playable files, head stream url', { timeout: 40000 }, async (t) => {
  let items
  try {
    const result = await service.searchMedia('night of the living dead', 'movie', NETWORK_TEST_OPTIONS)
    items = result.items
  } catch (error) {
    t.skip(`网络不可用：${error.message}`)
    return
  }
  assert.ok(items.length > 0, '公版电影检索应有结果')
  const detailResults = await Promise.all(items.slice(0, 5).map(async (item) => {
    try {
      return { detail: await service.listPlayableFiles(item.identifier, 'movie', NETWORK_TEST_OPTIONS) }
    } catch (error) {
      return { error }
    }
  }))
  const withFiles = detailResults.flatMap((result) => result.detail?.files.length > 0 ? [result.detail] : [])
  if (withFiles.length === 0 && detailResults.some((result) => result.error)) {
    const errors = detailResults.filter((result) => result.error).map((result) => result.error.message).join('；')
    t.skip(`文件列表网络不可用：${errors}`)
    return
  }
  assert.ok(withFiles.length > 0, '前 5 条至少一条有可播放文件')
  const first = withFiles[0].files[0]
  assert.match(first.url, /^https:\/\/archive\.org\/download\//)
  let head
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NETWORK_TEST_TIMEOUT_MS)
  try {
    head = await fetch(first.url, { method: 'HEAD', redirect: 'manual', signal: controller.signal })
  } catch (error) {
    t.skip(`直链网络不可用：${error.message}`)
    return
  } finally {
    clearTimeout(timer)
  }
  assert.ok([200, 301, 302, 303, 307, 308].includes(head.status), `直链应可访问，实际 ${head.status}`)
})

test('real archive.org: audio search stays inside licensed collections', { timeout: 15000 }, async (t) => {
  let result
  try {
    result = await service.searchMedia('grateful dead', 'audio', NETWORK_TEST_OPTIONS)
  } catch (error) {
    t.skip(`网络不可用：${error.message}`)
    return
  }
  assert.ok(result.items.length > 0, 'Live Music Archive 检索应有结果')
})
