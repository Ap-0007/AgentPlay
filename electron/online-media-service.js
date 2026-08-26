// 在线媒体库服务：Internet Archive（archive.org）公共领域与授权共享馆藏的检索、选流与直链。
// 法律边界写死在查询里：电影只查公版馆藏（feature_films/public_domain_film/Prelinger/classic_tv），
// 音频只查授权共享馆藏（etree 现场音乐档案=艺人许可录制分享 / librivoxaudio 公版有声书 / publicdomain）。
// 不抓取、不绕开任何付费墙；archive.org 自身的公共图书馆分发对终端用户合法。

const SEARCH_URL = 'https://archive.org/advancedsearch.php'
const METADATA_URL = 'https://archive.org/metadata/'
const DOWNLOAD_BASE = 'https://archive.org/download/'
const FETCH_TIMEOUT_MS = 30000

const COLLECTIONS = {
  movie: 'feature_films OR public_domain_film OR Prelinger OR classic_tv',
  audio: 'etree OR librivoxaudio OR publicdomain',
  book: 'gutenberg'
}
const MEDIATYPE = { movie: 'movies', audio: 'audio', book: 'texts' }

// C4 的“一键可商用配乐”只放行允许商业使用且允许改编的录音许可证。
// 音乐与画面同步在 CC 规则中属于改编，因此 NC、ND、SA 和未知许可证都故障关闭。
const MUSIC_LICENSES = Object.freeze({
  'publicdomain/mark/1.0': {
    id: 'Public-Domain-Mark-1.0', name: 'Public Domain Mark 1.0', publicDomain: true,
    attributionRequired: false, canonicalUrl: 'https://creativecommons.org/publicdomain/mark/1.0/'
  },
  'publicdomain/zero/1.0': {
    id: 'CC0-1.0', name: 'CC0 1.0', publicDomain: true,
    attributionRequired: false, canonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/'
  },
  'licenses/by/3.0': {
    id: 'CC-BY-3.0', name: 'CC BY 3.0', publicDomain: false,
    attributionRequired: true, canonicalUrl: 'https://creativecommons.org/licenses/by/3.0/'
  },
  'licenses/by/4.0': {
    id: 'CC-BY-4.0', name: 'CC BY 4.0', publicDomain: false,
    attributionRequired: true, canonicalUrl: 'https://creativecommons.org/licenses/by/4.0/'
  }
})

function normalizeMusicLicense(rawUrl) {
  let parsed
  try {
    parsed = new URL(String(rawUrl || '').trim())
  } catch {
    throw new Error('录音没有可核验许可证，不进入一键商用曲库')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'creativecommons.org') {
    throw new Error('录音许可证来源不受支持，不进入一键商用曲库')
  }
  const key = parsed.pathname.toLowerCase().replace(/^\/+|\/+$/g, '')
  const policy = MUSIC_LICENSES[key]
  if (!policy) throw new Error('该录音许可证含未知、非商用、禁止改编或相同方式共享条件，不进入一键商用曲库')
  const usageScope = Object.freeze({
    commercialUse: true,
    adaptationAllowed: true,
    videoSyncAllowed: true,
    attributionRequired: policy.attributionRequired,
    shareAlike: false,
    notice: policy.attributionRequired
      ? '可用于商业视频并可改编；发布时须署名、附许可证链接并说明是否修改。'
      : '可用于商业视频并可改编；建议保留曲目、表演者与来源信息。'
  })
  return Object.freeze({
    id: policy.id,
    name: policy.name,
    url: policy.canonicalUrl,
    publicDomain: policy.publicDomain,
    commercialUse: true,
    adaptationAllowed: true,
    shareAlike: false,
    attributionRequired: policy.attributionRequired,
    usageScope
  })
}

function scalar(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join('、')
  return String(value || '').trim()
}

function musicLicenseQuery() {
  const values = Object.values(MUSIC_LICENSES).flatMap((license) => {
    const httpUrl = license.canonicalUrl.replace(/^https:/, 'http:')
    return [`\"${license.canonicalUrl}\"`, `\"${httpUrl}\"`]
  })
  return `licenseurl:(${values.join(' OR ')})`
}

function literalSearchQuery(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).slice(0, 12)
    .map((term) => `\"${term.replace(/[\\\"]/g, '\\$&')}\"`).join(' AND ')
}

function recordingSource(metadata = {}) {
  return scalar(metadata.source) || scalar(metadata.collection) || `Internet Archive 条目 ${scalar(metadata.identifier) || '未知'}`
}

function attributionText({ track, performer, license, sourcePageUrl }) {
  return [track, performer, license.name, license.url, sourcePageUrl].filter(Boolean).join(' · ')
}

async function fetchWithTimeout(url, options = {}, { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (timedOut) throw new Error('网络请求超时，请检查网络后重试', { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, { timeoutMs = FETCH_TIMEOUT_MS, attempts = 2, fetchImpl = globalThis.fetch } = {}) {
  // archive.org 抖动是常态：超时/5xx 自动重试一次再如实报错
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        { headers: { 'User-Agent': 'AgentPlay/0.7 (legal public-domain media client)' } },
        { timeoutMs, fetchImpl }
      )
      if (response.ok) return response.json()
      lastError = new Error(`archive.org 返回 ${response.status}`)
      if (response.status < 500) throw lastError
    } catch (error) {
      lastError = error
      const message = String(error?.message || error)
      const retryable = /超时|5\d\d|fetch failed|network|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket/i.test(message)
      if (!retryable) throw error
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
  if (/fetch failed|network|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket/i.test(String(lastError?.message || lastError))) {
    throw new Error('Internet Archive 网络连接暂时失败，请稍后重试', { cause: lastError })
  }
  throw lastError
}

// kind: 'movie' | 'audio'；只返回规范化条目，年份/作者尽力而为
async function searchMedia(query, kind = 'movie', { page = 1, rows = 24, timeoutMs, attempts } = {}) {
  const q = String(query || '').trim()
  if (!q) return { items: [], total: 0 }
  if (!COLLECTIONS[kind]) throw new Error(`未知检索类别：${kind}`)
  const fullQuery = `(${q}) AND mediatype:${MEDIATYPE[kind]} AND collection:(${COLLECTIONS[kind]})`
  const url = `${SEARCH_URL}?q=${encodeURIComponent(fullQuery)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=creator&fl[]=downloads&rows=${rows}&page=${page}&output=json`
  const data = await fetchJson(url, { timeoutMs, attempts })
  const docs = data?.response?.docs || []
  return {
    total: data?.response?.numFound || 0,
    items: docs.map((doc) => ({
      identifier: doc.identifier,
      title: String(doc.title || doc.identifier),
      year: String(doc.year || '').slice(0, 4),
      creator: Array.isArray(doc.creator) ? doc.creator.join('、') : String(doc.creator || ''),
      downloads: Number(doc.downloads) || 0
    }))
  }
}

async function searchLicensedMusic(query, { page = 1, rows = 24, timeoutMs, attempts, fetchImpl = globalThis.fetch } = {}) {
  const q = literalSearchQuery(query)
  if (!q) return { items: [], total: 0 }
  const boundedRows = Math.max(1, Math.min(24, Number(rows) || 24))
  const boundedPage = Math.max(1, Number(page) || 1)
  const fullQuery = `(${q}) AND mediatype:audio AND ${musicLicenseQuery()}`
  const fields = ['identifier', 'title', 'year', 'creator', 'downloads', 'source', 'collection', 'licenseurl']
    .map((field) => `fl[]=${encodeURIComponent(field)}`).join('&')
  const url = `${SEARCH_URL}?q=${encodeURIComponent(fullQuery)}&${fields}&rows=${boundedRows}&page=${boundedPage}&output=json`
  const data = await fetchJson(url, { timeoutMs, attempts, fetchImpl })
  const docs = data?.response?.docs || []
  const items = []
  for (const doc of docs) {
    try {
      const license = normalizeMusicLicense(doc.licenseurl)
      items.push({
        identifier: scalar(doc.identifier),
        title: scalar(doc.title) || scalar(doc.identifier),
        track: scalar(doc.title) || scalar(doc.identifier),
        year: scalar(doc.year).slice(0, 4),
        creator: scalar(doc.creator),
        performer: scalar(doc.creator),
        downloads: Number(doc.downloads) || 0,
        recordingSource: recordingSource(doc),
        sourcePageUrl: `${DOWNLOAD_BASE.replace('/download/', '/details/')}${encodeURIComponent(scalar(doc.identifier))}`,
        license,
        usageScope: license.usageScope
      })
    } catch { /* Archive 搜索索引可能滞后；未知或已变更许可证不展示。 */ }
  }
  return { items, total: items.length }
}

const VIDEO_EXTS = ['.mp4', '.ogv', '.webm', '.mkv', '.avi', '.mov', '.mpeg', '.mpg']
const AUDIO_EXTS = ['.mp3', '.ogg', '.flac', '.m4a', '.wav']
const SKIP_MARKERS = ['_thumb', '_small', '_bw', '_text', '_djvu', '_scandata', '_meta.sqlite', '_files.xml', '_meta.xml', '_reviews', '__ia_thumb', '_itemimage', '_gif']

function isPlayableFile(name, kind) {
  const lower = String(name || '').toLowerCase()
  if (SKIP_MARKERS.some((marker) => lower.includes(marker))) return false
  const exts = kind === 'audio' ? AUDIO_EXTS : VIDEO_EXTS
  return exts.some((ext) => lower.endsWith(ext))
}

function fileScore(name, size, kind) {
  const lower = String(name || '').toLowerCase()
  let score = 0
  if (kind === 'audio') {
    if (lower.endsWith('.mp3')) score += 100
    else if (lower.endsWith('.ogg')) score += 80
    else if (lower.endsWith('.m4a')) score += 60
    else if (lower.endsWith('.flac')) score += 40
    else if (lower.endsWith('.wav')) score += 20
  } else {
    if (lower.endsWith('.mp4')) score += 100
    else if (lower.endsWith('.webm')) score += 80
    else if (lower.endsWith('.ogv')) score += 70
    else if (lower.endsWith('.mkv')) score += 60
    else if (lower.endsWith('.avi') || lower.endsWith('.mov')) score += 30
    else if (lower.endsWith('.mpeg') || lower.endsWith('.mpg')) score += 20
  }
  // 同名多版本时偏好较小文件（流媒体更顺）
  const mb = (Number(size) || 0) / 1024 / 1024
  if (mb > 0 && mb < 1500) score += Math.max(0, 30 - mb / 50)
  return score
}

// 列出条目的可播放文件（按可播性排序）；无文件时如实返回空
async function listPlayableFiles(identifier, kind = 'movie', { timeoutMs, attempts } = {}) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('条目编号无效')
  const data = await fetchJson(`${METADATA_URL}${encodeURIComponent(id)}`, { timeoutMs, attempts })
  const files = (data?.files || [])
    .filter((file) => isPlayableFile(file.name, kind))
    .map((file) => ({
      name: file.name,
      size: Number(file.size) || 0,
      url: `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      format: String(file.format || '')
    }))
    .sort((a, b) => fileScore(b.name, b.size, kind) - fileScore(a.name, a.size, kind))
  const title = String(data?.metadata?.title || id)
  return { identifier: id, title, files }
}

async function listLicensedMusicFiles(identifier, { timeoutMs, attempts, fetchImpl = globalThis.fetch } = {}) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('条目编号无效')
  const data = await fetchJson(`${METADATA_URL}${encodeURIComponent(id)}`, { timeoutMs, attempts, fetchImpl })
  const metadata = { ...(data?.metadata || {}), identifier: id }
  const license = normalizeMusicLicense(metadata.licenseurl)
  const itemTitle = scalar(metadata.title) || id
  const itemPerformer = scalar(metadata.creator)
  const itemRecordingSource = recordingSource(metadata)
  const sourcePageUrl = `https://archive.org/details/${encodeURIComponent(id)}`
  const files = (data?.files || [])
    .filter((file) => isPlayableFile(file.name, 'audio'))
    .map((file) => {
      const track = scalar(file.title) || pathTitle(file.name)
      const performer = scalar(file.artist) || itemPerformer
      const fileSource = scalar(file.source)
      return {
        name: String(file.name),
        size: Number(file.size) || 0,
        url: `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${String(file.name).split('/').map(encodeURIComponent).join('/')}`,
        format: scalar(file.format),
        track,
        trackNumber: scalar(file.track),
        performer,
        recordingSource: /^(original|derivative)$/i.test(fileSource) ? itemRecordingSource : fileSource || itemRecordingSource,
        sourcePageUrl,
        license,
        usageScope: license.usageScope,
        attributionText: attributionText({ track, performer, license, sourcePageUrl })
      }
    })
    .sort((a, b) => fileScore(b.name, b.size, 'audio') - fileScore(a.name, a.size, 'audio'))
  return { identifier: id, title: itemTitle, creator: itemPerformer, license, usageScope: license.usageScope, sourcePageUrl, files }
}

function pathTitle(fileName) {
  const name = String(fileName || '').split('/').pop() || ''
  return name.replace(/\.[^.]+$/, '')
}

function buildLicensedMusicReceipt({ identifier, title, file, outputPath, bytes, sha256, downloadedAt = new Date().toISOString() } = {}) {
  if (!file?.license || !file?.usageScope) throw new Error('缺少已核验的音乐许可证')
  if (!/^[a-f0-9]{64}$/i.test(String(sha256 || ''))) throw new Error('下载文件哈希无效')
  return {
    schemaVersion: 1,
    kind: 'agentplay.licensed-music-receipt',
    downloadedAt,
    provider: { name: 'Internet Archive', identifier: String(identifier || ''), itemTitle: String(title || ''), sourcePageUrl: file.sourcePageUrl },
    track: { title: file.track, number: file.trackNumber || '' },
    recording: { performer: file.performer, source: file.recordingSource },
    license: { id: file.license.id, name: file.license.name, url: file.license.url, publicDomain: file.license.publicDomain },
    usageScope: { ...file.usageScope },
    attributionText: file.attributionText,
    file: {
      name: file.name,
      localName: String(outputPath || '').split(/[\\/]/).pop() || file.name,
      bytes: Number(bytes) || 0,
      sha256: String(sha256).toLowerCase()
    },
    disclaimer: '许可证元数据来自条目下载时的 Internet Archive 记录；发布前仍应复核来源页及可能存在的表演权、人格权等其他权利。'
  }
}

// 仅允许 archive.org 的 https 直链进入播放器/下载器（域名白名单，防任意 URL 注入）
function assertArchiveUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url || ''))
  } catch {
    throw new Error('链接无效')
  }
  if (parsed.protocol !== 'https:') throw new Error('只支持 https 链接')
  const host = parsed.hostname.toLowerCase()
  if (host !== 'archive.org' && !host.endsWith('.archive.org')) throw new Error('只允许播放 Internet Archive 的链接')
  return String(url)
}

// 书目文件：epub 优先（有章节结构），txt 兜底
async function listBookFiles(identifier, { timeoutMs, attempts, fetchImpl } = {}) {
  const id = String(identifier || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('条目编号无效')
  const data = await fetchJson(`${METADATA_URL}${encodeURIComponent(id)}`, { timeoutMs, attempts, fetchImpl })
  const files = (data?.files || [])
    .filter((file) => /\.(epub|txt)$/i.test(file.name || '') && !/_(djvu|bw|text)\.txt$/i.test(file.name))
    .map((file) => ({
      name: file.name,
      size: Number(file.size) || 0,
      url: `${DOWNLOAD_BASE}${encodeURIComponent(id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`,
      format: String(file.format || '')
    }))
    .sort((a, b) => Number(/\.epub$/i.test(b.name)) - Number(/\.epub$/i.test(a.name)) || a.size - b.size)
  const title = String(data?.metadata?.title || id)
  const creator = data?.metadata?.creator
  return { identifier: id, title, creator: Array.isArray(creator) ? creator.join('、') : String(creator || ''), files }
}

module.exports = {
  searchMedia,
  searchLicensedMusic,
  listPlayableFiles,
  listLicensedMusicFiles,
  listBookFiles,
  assertArchiveUrl,
  normalizeMusicLicense,
  buildLicensedMusicReceipt,
  COLLECTIONS,
  __test: { fetchWithTimeout, musicLicenseQuery, literalSearchQuery }
}
