const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// 维基文库（zh.wikisource.org）中文公版书服务：检索、按页序取章节目录、按页取正文。
// 法律边界：维基文库只收公共领域内容（作者逝世多年/古籍），MediaWiki 官方 API，合法免费。
// 礼貌用 API：带身份 UA、请求间隔 ≥400ms、正文按页缓存零重复请求。

const API = 'https://zh.wikisource.org/w/api.php'
const UA = 'AgentPlay/0.7 (public-domain Chinese books; contact: wg5759@users.noreply.github.com)'
const MIN_INTERVAL_MS = 400
const FETCH_TIMEOUT_MS = 30000

let lastRequestAt = 0
async function apiGet(params) {
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt))
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
  lastRequestAt = Date.now()
  const url = `${API}?${new URLSearchParams({ format: 'json', utf8: '1', ...params }).toString()}`
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal })
      if (!response.ok) throw new Error(`维基文库返回 ${response.status}`)
      return response.json()
    } catch (error) {
      lastError = error.name === 'AbortError' ? new Error('维基文库请求超时，请检查网络后重试') : error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

// 检索书名：先按标题搜（intitle:），避免"西游记搜出判决书"这类全文噪音；标题结果少再放宽到全文
async function searchBooks(query) {
  const q = String(query || '').trim()
  if (!q) return []
  // 标题命中先行；全文命中只作补足且剔除司法文书/公报类页面（它们不是书）
  const NON_BOOK = /判决书|裁定书|决定书|通知书|公报|案例|批复|复函|裁定|公告|诉|纠纷/
  let data = await apiGet({ action: 'query', list: 'search', srsearch: `intitle:"${q}"`, srlimit: '20', srnamespace: '0' })
  let hits = (data?.query?.search || []).filter((h) => !NON_BOOK.test(String(h.title || '')))
  if (hits.length < 3) {
    data = await apiGet({ action: 'query', list: 'search', srsearch: q, srlimit: '20', srnamespace: '0' })
    const extra = (data?.query?.search || []).filter((h) => !NON_BOOK.test(String(h.title || '')))
    hits = [...hits, ...extra]
  }
  const seen = new Set()
  const items = []
  for (const hit of hits) {
    const title = String(hit.title || '').trim()
    if (!title || title.includes('/') || seen.has(title)) continue // 章节子页不出现在书目层
    seen.add(title)
    items.push({
      identifier: `ws:${title}`,
      title,
      year: '',
      creator: '维基文库',
      downloads: 0,
      source: 'ws'
    })
  }
  return items
}

// 章节目录：按书页内链接顺序取子页。两个坑都要处理：
// ① 简体书名常是繁体正页的重定向（西游记→西遊記），必须 redirects=1 并用解析后的规范名做前缀
// ② 部分书主页不直接列回目，而是列版本页（如"某某本"），此时探测版本页取子页最多者
async function listChapters(bookTitle) {
  const title = String(bookTitle || '').trim()
  if (!title) throw new Error('书名无效')
  const collect = (pageTitle, links) => {
    const chapters = []
    const seen = new Set()
    for (const link of links) {
      if (!link.startsWith(`${pageTitle}/`) || seen.has(link)) continue
      seen.add(link)
      chapters.push({ page: link, title: link.slice(pageTitle.length + 1) })
    }
    return chapters
  }
  const data = await apiGet({ action: 'parse', page: title, prop: 'links', redirects: '1' })
  const resolvedTitle = String(data?.parse?.title || title)
  const links = (data?.parse?.links || []).map((link) => String(link['*'] || ''))
  let chapters = collect(resolvedTitle, links)
  if (chapters.length < 3) {
    // 版本页回退：主页链接里找候选版本页（含括号版本标注或同名异写），探测子页最多者
    const candidates = links.filter((link) => !link.includes('/') && (link.includes('（') || link.includes('(') || link !== resolvedTitle && link.slice(0, 2) === resolvedTitle.slice(0, 2))).slice(0, 5)
    for (const candidate of candidates) {
      try {
        const sub = await apiGet({ action: 'parse', page: candidate, prop: 'links', redirects: '1' })
        const subTitle = String(sub?.parse?.title || candidate)
        const subLinks = (sub?.parse?.links || []).map((link) => String(link['*'] || ''))
        const found = collect(subTitle, subLinks)
        if (found.length > chapters.length) chapters = found
        if (chapters.length >= 10) break
      } catch { /* 单个版本页失败换下一个 */ }
    }
  }
  if (chapters.length === 0) {
    // 单页书（短篇/文章）：整页即一章
    return [{ page: resolvedTitle, title: resolvedTitle }]
  }
  return chapters
}

function stripExtract(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^(回目录|上一回|下一回|目錄|返回目录)/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cachePath(cacheRoot, bookTitle, pageTitle) {
  const hash = crypto.createHash('sha1').update(String(pageTitle)).digest('hex').slice(0, 16)
  const bookHash = crypto.createHash('sha1').update(String(bookTitle)).digest('hex').slice(0, 10)
  return path.join(cacheRoot, 'ws', bookHash, `${hash}.txt`)
}

// 取章节正文（按页缓存；目录注释/导航行剥掉）
async function fetchChapterText(cacheRoot, bookTitle, pageTitle) {
  const cached = cachePath(cacheRoot, bookTitle, pageTitle)
  try {
    const text = fs.readFileSync(cached, 'utf8')
    if (text.trim()) return text
  } catch { /* 未缓存 */ }
  const data = await apiGet({ action: 'query', prop: 'extracts', explaintext: '1', titles: pageTitle, redirects: '1' })
  const pages = data?.query?.pages || {}
  const first = Object.values(pages)[0]
  const text = stripExtract(first?.extract || '')
  if (!text) throw new Error('这一页没有可读正文（可能是尚未录入的扫描页）')
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  const tempPath = `${cached}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, text, 'utf8')
  fs.renameSync(tempPath, cached)
  return text
}

module.exports = { searchBooks, listChapters, fetchChapterText }
