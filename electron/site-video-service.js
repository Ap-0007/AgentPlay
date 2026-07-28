// 站点视频服务：yt-dlp 组件解析与下载（B站/YouTube/抖音等公开视频页）。
// 只处理公开可访问内容；VIP/付费/DRM 内容由 yt-dlp 原样报错，不绕过、不伪装。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const RESOLVE_TIMEOUT_MS = 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

function assertHttpUrl(value) {
  const text = String(value || '').trim()
  if (!/^https?:\/\//i.test(text)) throw new Error('只支持 http/https 链接')
  if (/[\r\n]/.test(text)) throw new Error('链接格式无效')
  return text
}

// 短链域名 → cookies 文件主域（导入的 cookies.txt 按主域命名存放）
const SITE_ALIASES = {
  'b23.tv': 'bilibili.com',
  'youtu.be': 'youtube.com'
}

function registrableDomain(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean)
  return parts.slice(-2).join('.')
}

// 由链接推导出对应的 cookies.txt 路径（如 v.douyin.com → <cookiesDir>/douyin.com.txt）
function cookiesFileForUrl(cookiesDir, url) {
  if (!cookiesDir) return ''
  try {
    const base = registrableDomain(new URL(url).hostname)
    const domain = SITE_ALIASES[base] || base
    if (!/^[a-z0-9.-]+$/.test(domain) || !domain.includes('.')) return ''
    return path.join(cookiesDir, `${domain}.txt`)
  } catch {
    return ''
  }
}

// 兼容 JSON 导出（J2TEAM Cookies / Cookie-Editor 等）：统一转成 Netscape cookies.txt 文本；非 JSON 原样返回
function normalizeCookiesText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (!raw.startsWith('[') && !raw.startsWith('{')) return raw
  let data
  try { data = JSON.parse(raw) } catch { return null }
  const list = Array.isArray(data) ? data : (Array.isArray(data.cookies) ? data.cookies : null)
  if (!list) return null
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of list) {
    if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') continue
    const hostOnly = c.hostOnly === true
    const domain = hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : `.${c.domain}`)
    const expires = Number.isFinite(c.expirationDate) ? Math.floor(c.expirationDate) : 0
    lines.push([domain, hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', String(expires), c.name, String(c.value ?? '')].join('\t'))
  }
  return lines.length > 1 ? lines.join('\n') : null
}

// 从 cookies.txt 内容识别主域（取出现次数最多的注册域），用于导入时命名
function detectCookiesDomain(text) {
  const counts = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const cols = line.split('\t')
    if (cols.length < 7) continue
    const base = SITE_ALIASES[registrableDomain(cols[0])] || registrableDomain(cols[0])
    if (!/^[a-z0-9.-]+$/.test(base) || !base.includes('.')) continue
    counts.set(base, (counts.get(base) || 0) + 1)
  }
  let domain = ''
  let count = 0
  for (const [name, n] of counts) {
    if (n > count) { domain = name; count = n }
  }
  return domain ? { domain, count } : null
}

// 下载产物文件名去 #：它是 URL 片段符，不处理会把 file:// / HTTP 直链（播放器/DLNA/投屏）全截断
function stripHashFromName(filePath) {
  const base = path.basename(filePath)
  if (!base.includes('#')) return filePath
  const target = path.join(path.dirname(filePath), base.replace(/#/g, ''))
  if (fs.existsSync(target)) return filePath
  try {
    fs.renameSync(filePath, target)
    return target
  } catch {
    return filePath
  }
}

function sanitizeTitle(title) {
  const cleaned = String(title || '').split('').map((ch) => {
    const code = ch.codePointAt(0)
    return code < 32 || '<>:"/\\|?*'.includes(ch) ? '_' : ch
  }).join('').trim()
  return cleaned.slice(0, 80) || `站点视频-${Date.now()}`
}

// [download]  45.2% of 100.00MiB at 1.20MiB/s / [download] 100% of 50.00MiB
function parseProgressLine(line) {
  const match = /\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?([\d.]+\s*\w+)/.exec(line)
  if (!match) return null
  return { percent: Number(match[1]), size: match[2] }
}

class SiteVideoService {
  constructor({ enginePath, ffmpegDir, spawnImpl, resolveTimeoutMs, downloadTimeoutMs, cookiesDir } = {}) {
    this.enginePath = enginePath ? path.resolve(enginePath) : enginePath
    this.ffmpegDir = ffmpegDir ? path.resolve(ffmpegDir) : null
    this.spawnImpl = spawnImpl || spawn
    this.resolveTimeoutMs = resolveTimeoutMs || RESOLVE_TIMEOUT_MS
    this.downloadTimeoutMs = downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS
    this.cookiesDir = cookiesDir || ''
  }

  availability() {
    const engineOk = Boolean(this.enginePath && fs.existsSync(this.enginePath))
    const ffmpegOk = Boolean(this.ffmpegDir && fs.existsSync(path.join(this.ffmpegDir, 'ffmpeg.exe')))
    return { available: engineOk, ffmpegOk, enginePath: this.enginePath, reason: engineOk ? '' : '站点视频解析组件未下载' }
  }

  exec(args, { timeoutMs, signal, onLine } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.enginePath, args, { windowsHide: true, shell: false })
      let stdout = ''
      let stderr = ''
      let lineBuffer = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('yt-dlp 执行超时'))
      }, timeoutMs)
      const finish = (fn, value) => {
        if (finish.done) return
        finish.done = true
        clearTimeout(timer)
        fn(value)
      }
      const onAbort = () => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('已取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        stdout += text
        lineBuffer += text
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() || ''
        for (const line of lines) if (line.trim()) onLine?.(line)
      })
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        stderr = (stderr + text).slice(-8000)
      })
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (code === 0) finish(resolve, { stdout, stderr })
        else finish(reject, new Error(stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || `yt-dlp 退出码 ${code}`))
      })
    })
  }


  // 匿名 → 已导入 cookies.txt 的尝试链。
  // --cookies-from-browser 在本机不可用：浏览器运行时独占锁定 Cookies 库，且新版 Chrome/Edge 为 ABE 加密，
  // 因此只认用户主动导入的 cookies.txt；链路保持「先匿名、被站点拒绝后带凭证重试」。
  async attemptWithCookies(run, { signal, onRetryNote, target } = {}) {
    const cookiesFile = cookiesFileForUrl(this.cookiesDir, target || '')
    const hasFile = Boolean(cookiesFile && fs.existsSync(cookiesFile))
    const attempts = hasFile ? [null, cookiesFile] : [null]
    let lastError = null
    for (const attempt of attempts) {
      if (attempt) onRetryNote?.('匿名访问被站点拒绝，正在用已导入的浏览器 Cookies 重试')
      try {
        return await run(attempt)
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
        if (!/fresh cookies|login|登录|cookie|会员|VIP|注册/i.test(String(error.message || ''))) break
      }
    }
    const message = String(lastError?.message || '')
    if (/fresh cookies|login required|需要登录/i.test(message)) {
      if (hasFile) throw new Error('已导入的 Cookies 失效或站点仍拒绝：请重新导出本站 cookies.txt 后再导入（VIP/付费/DRM 内容不支持）')
      throw new Error('该站点需要浏览器登录态 Cookies：在 Edge/Chrome 安装扩展「Get cookies.txt LOCALLY」，打开本站页面后导出 cookies.txt，然后点下方「导入 Cookies」')
    }
    throw lastError
  }

  async resolve(url, { signal, onRetryNote } = {}) {
    const target = assertHttpUrl(url)
    if (!this.availability().available) throw new Error('站点视频解析组件未下载')
    const { stdout } = await this.attemptWithCookies(
      (cookiesFile) => this.exec([...(cookiesFile ? ['--cookies', cookiesFile] : []), '--dump-single-json', '--no-playlist', '--no-warnings', target], { timeoutMs: this.resolveTimeoutMs, signal }),
      { signal, onRetryNote, target }
    )
    let info
    try {
      info = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')
    } catch {
      throw new Error('解析结果不是有效 JSON')
    }
    if (!info || !info.title) throw new Error('没有解析到视频信息（可能不是视频页，或页面已失效）')
    return {
      title: String(info.title),
      duration: Number(info.duration) || 0,
      uploader: String(info.uploader || info.channel || ''),
      extractor: String(info.extractor_key || info.extractor || ''),
      isLive: Boolean(info.is_live)
    }
  }

  async download(url, { destDir, onProgress, signal, onRetryNote } = {}) {
    const target = assertHttpUrl(url)
    const status = this.availability()
    if (!status.available) throw new Error(status.reason)
    fs.mkdirSync(destDir, { recursive: true })
    // 优先 1080p 内 h264/avc1 单文件：横屏按 height 卡、竖屏按 width 卡（抖音竖屏 720x1280），
    // 编码标注两种都认（B站/YouTube 标 avc1，抖音标 h264），保证产物在 HTML5 也能硬解
    const { ffmpegOk } = this.availability()
    const format = ffmpegOk
      ? 'bv*[height<=1080][vcodec^=avc1]+ba/bv*[width<=1080][vcodec^=avc1]+ba/bv*[height<=1080][vcodec^=h264]+ba/bv*[width<=1080][vcodec^=h264]+ba/b[vcodec^=avc1]/b[vcodec^=h264]/bv*[height<=1080]+ba/bv*[width<=1080]+ba/b/bv*/b'
      : 'b[acodec!=none][vcodec!=none][ext=mp4]/b[acodec!=none][vcodec!=none]'
    const outTemplate = path.join(destDir, '%(title).80s-%(id)s.%(ext)s')
    const baseArgs = [
      ...(ffmpegOk ? ['--ffmpeg-location', this.ffmpegDir] : []),
      '-f', format,
      '--no-playlist', '--no-warnings', '--newline',
      '-o', outTemplate,
      '--print', 'after_move:filepath',
      target
    ]
    return this.attemptWithCookies(
      (cookiesFile) => this.runDownload(cookiesFile ? [...baseArgs, '--cookies', cookiesFile] : baseArgs, destDir, onProgress, signal),
      { signal, onRetryNote, target }
    )
  }

  async runDownload(args, destDir, onProgress, signal) {
    let finalPath = ''
    const { stdout, stderr } = await this.exec(args, {
      timeoutMs: this.downloadTimeoutMs,
      signal,
      onLine: (line) => {
        const progress = parseProgressLine(line)
        if (progress) onProgress?.(progress)
      }
    })
    const printed = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (printed && fs.existsSync(printed)) finalPath = printed
    if (!finalPath) {
      const candidates = fs.readdirSync(destDir).map((name) => path.join(destDir, name))
        .filter((file) => fs.statSync(file).isFile() && Date.now() - fs.statSync(file).mtimeMs < 10 * 60 * 1000)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      finalPath = candidates[0] || ''
    }
    if (!finalPath || !fs.existsSync(finalPath) || fs.statSync(finalPath).size === 0) {
      throw new Error(stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || '下载结束但没有产出文件')
    }
    finalPath = stripHashFromName(finalPath)
    return { outputPath: finalPath, bytes: fs.statSync(finalPath).size }
  }
}

module.exports = {
  SiteVideoService,
  parseProgressLine,
  sanitizeTitle,
  cookiesFileForUrl,
  detectCookiesDomain,
  normalizeCookiesText,
  stripHashFromName
}
