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
  constructor({ enginePath, ffmpegDir, spawnImpl, resolveTimeoutMs, downloadTimeoutMs } = {}) {
    this.enginePath = enginePath ? path.resolve(enginePath) : enginePath
    this.ffmpegDir = ffmpegDir ? path.resolve(ffmpegDir) : null
    this.spawnImpl = spawnImpl || spawn
    this.resolveTimeoutMs = resolveTimeoutMs || RESOLVE_TIMEOUT_MS
    this.downloadTimeoutMs = downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS
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


  // 匿名→chrome→edge 的 Cookies 尝试链；浏览器锁住库时给可执行提示
  async attemptWithCookies(run, { signal, onRetryNote } = {}) {
    const attempts = [null, 'chrome', 'edge']
    let lastError = null
    for (const browser of attempts) {
      if (browser) onRetryNote?.(`需要登录态，正在用本机 ${browser} 浏览器 Cookies 重试`)
      try {
        return await run(browser)
      } catch (error) {
        lastError = error
        if (signal?.aborted) throw error
        const message = String(error.message || '')
        if (/Could not copy .*cookie database/i.test(message)) {
          throw new Error('浏览器正在运行并锁住了 Cookies 文件：请完全退出 Chrome/Edge 后点重试（或先不登录直接用公开视频）')
        }
        if (!/fresh cookies|login|登录|cookie|会员|VIP|注册/i.test(message)) break
      }
    }
    throw lastError
  }

  async resolve(url, { signal, onRetryNote } = {}) {
    const target = assertHttpUrl(url)
    if (!this.availability().available) throw new Error('站点视频解析组件未下载')
    const { stdout } = await this.attemptWithCookies(
      (browser) => this.exec([...(browser ? ['--cookies-from-browser', browser] : []), '--dump-single-json', '--no-playlist', '--no-warnings', target], { timeoutMs: this.resolveTimeoutMs, signal }),
      { signal, onRetryNote }
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
    // 优先 1080p 内 mp4 单文件（不依赖 ffmpeg 合并），取不到再退任意最佳单文件
    const { ffmpegOk } = this.availability()
    const format = ffmpegOk
      ? 'bv*[height<=1080][vcodec^=avc1]+ba/bv*[height<=1080]+ba/bv*/b'
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
      (browser) => this.runDownload(browser ? [...baseArgs, '--cookies-from-browser', browser] : baseArgs, destDir, onProgress, signal),
      { signal, onRetryNote }
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
    return { outputPath: finalPath, bytes: fs.statSync(finalPath).size }
  }
}

module.exports = {
  SiteVideoService,
  parseProgressLine,
  sanitizeTitle
}
