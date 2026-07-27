// 远程媒体直链下载：严格 URL 策略（禁凭据、禁元数据/私网、DNS 校验、限重定向、限大小），
// 临时文件 + 原子重命名；进度与取消经回调透出。站点链接（B站/YouTube等）由 yt-dlp 组件负责，不走这里。
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { isProtectedAddress } = require('./network-policy')

const MAX_REDIRECTS = 3
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.ts', '.flv', '.avi', '.wmv', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.wav'])

function isMediaUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
    return VIDEO_EXTENSIONS.has(path.extname(parsed.pathname).toLowerCase())
  } catch {
    return false
  }
}

function extractUrl(text) {
  const match = /https?:\/\/[^\s"'）)】\]]+/i.exec(String(text || ''))
  return match ? match[0] : ''
}

function isDownloadIntent(text) {
  const url = extractUrl(text)
  if (!url) return false
  if (isMediaUrl(url)) return true
  return /下载|保存|拉片|解剖|分析|双语|字幕|转写|播放/i.test(String(text || ''))
}

function sanitizeFileName(name) {
  const cleaned = String(name || '').split('').map((ch) => {
    const code = ch.codePointAt(0)
    return code < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch
  }).join('').trim()
  return cleaned || `远程视频-${Date.now()}`
}
async function assertUrlAllowed(url, { dnsLookup } = {}) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http/https 链接')
  if (parsed.username || parsed.password) throw new Error('链接不得包含账号或密码')
  const hostname = parsed.hostname.toLowerCase()
  if (['169.254.169.254', 'metadata.google.internal'].includes(hostname)) throw new Error('已拒绝云元数据地址')
  const lookup = dnsLookup || require('dns').promises.lookup
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((item) => item?.address || item)
  if (!list.length) throw new Error('链接域名没有可用地址')
  if (list.some((address) => isProtectedAddress(address))) throw new Error('链接解析到了私网或保留地址，已拒绝')
  return parsed
}

function fileNameFor(parsed, contentType) {
  const base = path.basename(parsed.pathname || '') || '远程视频'
  const decoded = decodeURIComponent(base).split('?')[0]
  if (path.extname(decoded)) return sanitizeFileName(decoded)
  const extByType = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'audio/mpeg': '.mp3' }
  return sanitizeFileName(decoded + (extByType[contentType] || '.mp4'))
}

async function downloadRemoteMedia(url, { destDir, onProgress, signal, fetchImpl, dnsLookup } = {}) {
  const fetcher = fetchImpl || globalThis.fetch
  if (!fetcher) throw new Error('当前环境缺少下载能力')
  let current = String(url || '').trim()
  let response = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertUrlAllowed(current, { dnsLookup })
    response = await fetcher(current, { redirect: 'manual', signal })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`链接返回 ${response.status} 但没有跳转地址`)
      current = new URL(location, current).toString()
      response = null
      continue
    }
    break
  }
  if (!response) throw new Error('链接重定向次数过多')
  if (!response.ok) throw new Error(`链接返回 ${response.status}，无法下载`)
  const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !contentType.startsWith('video/') && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error(`链接内容不是音视频（${contentType}）；站点链接（B站/YouTube/抖音）请等 yt-dlp 组件，或直接给视频文件直链`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  if (total > MAX_BYTES) throw new Error('文件超过 2GB 下载上限')
  const parsed = new URL(current)
  fs.mkdirSync(destDir, { recursive: true })
  const finalPath = path.join(destDir, fileNameFor(parsed, contentType))
  const tempPath = `${finalPath}.${process.pid}.part`
  const out = fs.createWriteStream(tempPath)
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      if (signal?.aborted) throw new Error('下载已取消')
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_BYTES) throw new Error('文件超过 2GB 下载上限')
      out.write(Buffer.from(value))
      onProgress?.({ received, total })
    }
    await new Promise((resolve, reject) => { out.end((error) => (error ? reject(error) : resolve())) })
    if (total && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`)
    fs.renameSync(tempPath, finalPath)
    return { outputPath: finalPath, bytes: received, finalUrl: current }
  } catch (error) {
    try { out.destroy() } catch { /* 已关闭 */ }
    try { fs.rmSync(tempPath, { force: true }) } catch { /* 临时文件不存在 */ }
    throw error
  }
}

module.exports = {
  MAX_BYTES,
  downloadRemoteMedia,
  extractUrl,
  isDownloadIntent,
  isMediaUrl
}
