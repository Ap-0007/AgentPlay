const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { classifyScript } = require('../electron/language-detect-service')

test('classifyScript separates Chinese, English and unclear samples', () => {
  assert.equal(classifyScript('大家好，今天我们来讲一讲存储板块为什么下跌，这里面有几个关键的逻辑。'), 'zh')
  assert.equal(classifyScript('Hello everyone, today we are going to talk about the global economy and technology trends.'), 'en')
  assert.equal(classifyScript('Q1 Q2 Q3'), 'other')
  assert.equal(classifyScript(''), 'other')
  assert.equal(classifyScript('Hello 你好'), 'other')
})

test('language detect IPC, preload bridge and prompt banner are wired', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.ok(main.includes("ipcMain.handle('media:detect-language'"))
  assert.match(main, /languageDetect\.detect\(resolved\)/)
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  assert.ok(preload.includes("invoke('media:detect-language'"))
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
  assert.match(view, /langPrompt/)
  assert.match(view, /detectLanguage/)
  assert.match(view, /译成中文/)
  assert.match(view, /译成英文/)
  assert.match(view, /本会话不再提示/)
  // 翻译方向必须传到实时翻译通道
  assert.match(view, /targetLang, requestId/)
  assert.match(view, /toggleLiveTranslate = async \(targetLang\?: string\)/)
})
