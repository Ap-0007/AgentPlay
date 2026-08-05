const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const reader = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'EbookReader.tsx'), 'utf8')
const ebook = require('../electron/ebook-service')

test('translate target: three targets, offline locked to zh, cache isolated per target', () => {
  // 三向提示词
  assert.match(main, /vernacular: '你是古文今译助手。把内容翻成通顺易懂的现代白话文/)
  assert.match(main, /en: 'You are a literary translator\./)
  // 离线轨非中文目标如实拒绝
  assert.match(main, /离线翻译组件只支持英译中；翻白话文\/英文请用云模型/)
  // 缓存键含 engine+target
  assert.match(main, /`\$\{engine\}-\$\{target\}`/)
  // UI 三选 + 离线按钮非中文目标禁用
  assert.match(reader, /白话文/)
  assert.match(reader, /English/)
  assert.match(reader, /disabled=\{target !== 'zh'\}/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebook-target-cache-'))
  try {
    ebook.writeTranslationCache(dir, 'ws:紅樓夢', 'cloud-vernacular', 0, '白话译文')
    ebook.writeTranslationCache(dir, 'ws:紅樓夢', 'cloud-en', 0, 'English translation')
    assert.equal(ebook.readTranslationCache(dir, 'ws:紅樓夢', 'cloud-vernacular', 0), '白话译文')
    assert.equal(ebook.readTranslationCache(dir, 'ws:紅樓夢', 'cloud-en', 0), 'English translation')
    assert.equal(ebook.readTranslationCache(dir, 'ws:紅樓夢', 'cloud-zh', 0), null, '不同目标缓存必须隔离')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
