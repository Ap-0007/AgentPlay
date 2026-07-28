// 站点登录态服务：App 内嵌窗口扫码登录（持久分区），并支持登录后静默重取 Cookies 续期。
// 背景：直读浏览器 Cookies 被锁库/ABE 堵死、扩展导出太折腾——一次扫码后由本分区自己保鲜。
// Electron cookies → Netscape 文本为纯函数，便于测试；窗口部分仅装配在 main.js。
const fs = require('fs')
const path = require('path')

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const LOGIN_MARKERS = ['sessionid', 'sid_guard', 'passport_csrf_token', 'LOGIN_STATUS']
const SITE_HOME = {
  'douyin.com': 'https://www.douyin.com/',
  'bilibili.com': 'https://www.bilibili.com/',
  'youtube.com': 'https://www.youtube.com/'
}

// Electron session cookies → Netscape cookies.txt 文本
function electronCookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies || []) {
    if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') continue
    lines.push([
      c.domain,
      c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(Math.floor(c.expirationDate || 0)),
      c.name,
      String(c.value ?? '')
    ].join('\t'))
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function hasLoginMarker(cookies) {
  return (cookies || []).some((c) => LOGIN_MARKERS.includes(c.name) && String(c.value || '').length > 0)
}

class SiteLoginService {
  // deps: { partition, cookiesDir, createWindow({show}) → { loadURL(url), getCookies(), close(), onClosed(fn), isDestroyed() } }
  constructor({ partition = 'persist:site-login', cookiesDir, createWindow, ua } = {}) {
    this.partition = partition
    this.cookiesDir = cookiesDir || ''
    this.createWindow = createWindow
    this.ua = ua || DEFAULT_UA
  }

  // 分区里是否已有登录态标记（不开窗、快速判断）
  async hasSession(getCookies) {
    try {
      const cookies = await getCookies()
      return hasLoginMarker(cookies)
    } catch {
      return false
    }
  }

  writeCookiesFile(domain, cookies) {
    const text = electronCookiesToNetscape(cookies.filter((c) => c.domain.includes(domain.split('.')[0])))
    if (!text) return ''
    fs.mkdirSync(this.cookiesDir, { recursive: true })
    const file = path.join(this.cookiesDir, `${domain}.txt`)
    fs.writeFileSync(file, text)
    return file
  }

  // 静默续期：分区已有登录态时，隐藏窗访问站点首页刷新 cookies 并落盘
  async silentRefresh(domain, getSessionCookies) {
    if (!this.createWindow || !getSessionCookies) return false
    if (!(await this.hasSession(getSessionCookies))) return false
    const home = SITE_HOME[domain] || `https://www.${domain}/`
    let win = null
    try {
      win = this.createWindow({ show: false })
      await win.loadURL(home, this.ua)
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const cookies = await win.getCookies()
      return Boolean(this.writeCookiesFile(domain, cookies))
    } catch {
      return false
    } finally {
      try { win?.close() } catch { /* 忽略 */ }
    }
  }

  // 可见登录窗：用户扫码/登录，轮询登录标记，成功后落盘 cookies；返回是否成功
  async openLogin(domain, getSessionCookies, { timeoutMs = 3 * 60 * 1000 } = {}) {
    if (!this.createWindow) return { success: false, error: '登录窗口不可用' }
    const home = SITE_HOME[domain] || `https://www.${domain}/`
    let win = null
    let closed = false
    try {
      win = this.createWindow({ show: true })
      win.onClosed(() => { closed = true })
      await win.loadURL(home, this.ua)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (closed) return { success: false, canceled: true }
        const cookies = await getSessionCookies()
        if (hasLoginMarker(cookies)) {
          const file = this.writeCookiesFile(domain, cookies)
          try { win.close() } catch { /* 忽略 */ }
          return file ? { success: true, domain, file } : { success: false, error: '登录成功但 Cookies 落盘失败' }
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      return { success: false, error: '等待登录超时（3 分钟），需要时点重试重新打开' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      try { win?.close() } catch { /* 忽略 */ }
    }
  }
}

module.exports = {
  SiteLoginService,
  electronCookiesToNetscape,
  hasLoginMarker,
  LOGIN_MARKERS,
  SITE_HOME
}
