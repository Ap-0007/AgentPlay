const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OnlineMediaLibrary.tsx'), 'utf8')
const agentPanel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
const wikisource = require('../electron/wikisource-service')
const ebook = require('../electron/ebook-service')

test('wiring: book search merges wikisource, ws items open reader directly, movie rows get 拉片 button', () => {
  assert.match(main, /wikisource\.searchBooks\(input\.query\)/, '书籍检索必须合并维基文库')
  assert.match(main, /startsWith\('ws:'\)/, 'ebook 章节必须按 ws: 前缀路由')
  assert.match(main, /wikisource\.fetchChapterText/, '维基文库正文按页现取')
  assert.match(panel, /维基文库/)
  assert.match(panel, /source === 'ws'/)
  assert.match(panel, /ai-player-link-analysis/, '电影文件行必须能一键拉片')
  assert.match(agentPanel, /ai-player-link-analysis/)
  assert.match(agentPanel, /runLinkAnalysisTaskRef\.current\(url, ''\)/, '与对话窗粘贴链接同一拉片链路')
})

test('translation cache handles non-ASCII identifiers via hashed dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-ws-cache-'))
  try {
    ebook.writeTranslationCache(dir, 'ws:紅樓夢', 'offline', 0, '译文')
    assert.equal(ebook.readTranslationCache(dir, 'ws:紅樓夢', 'offline', 0), '译文')
    assert.equal(ebook.readTranslationCache(dir, 'ws:紅樓夢', 'offline', 1), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real wikisource: search Chinese book, ordered chapters, chapter text clean', { timeout: 120000 }, async (t) => {
  let items
  try {
    items = await wikisource.searchBooks('红楼梦')
  } catch (error) {
    t.skip(`维基文库不可用：${error.message}`)
    return
  }
  assert.ok(items.length > 0, '红楼梦应能搜到')
  assert.ok(items.every((item) => item.source === 'ws'))
  const target = items.find((item) => item.title === '紅樓夢')
  assert.ok(target, '书目里应有正本紅樓夢')
  const chapters = await wikisource.listChapters('紅樓夢')
  assert.ok(chapters.length >= 100, `应有百回以上，实际 ${chapters.length}`)
  assert.equal(chapters[0].title, '第001回', '回目必须按页序')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-real-'))
  try {
    const text = await wikisource.fetchChapterText(dir, '紅樓夢', chapters[0].page)
    assert.ok(text.length > 3000)
    assert.ok(text.includes('甄士隱'), '第一回正文应含原文')
    assert.ok(!/^回目录/m.test(text), '导航行必须剥掉')
    // 缓存命中：二次取不再请求（读盘即回）
    const again = await wikisource.fetchChapterText(dir, '紅樓夢', chapters[0].page)
    assert.equal(again, text)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
