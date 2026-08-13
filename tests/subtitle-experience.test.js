const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const player = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'PlayerView.tsx'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')

test('the player exposes one primary translation action and hides subtitle-source plumbing', () => {
  const prompt = player.slice(player.indexOf('{langPrompt && ('), player.indexOf('{playbackNotice &&'))
  assert.match(prompt, /显示\{langPrompt\.targetLang\}字幕/)
  assert.doesNotMatch(prompt, /搜索现成字幕/)
  assert.match(player, /data-smart-translate-subtitle="true"/)
  assert.match(player, /data-smart-translate-subtitle="true"[\s\S]{0,760}bilingualBusy \? '正在处理字幕…' : '翻译字幕'[\s\S]{0,80}<\/button>/)
  assert.match(player, /data-subtitle-progress="true"/)
  assert.match(preload, /cancel: \(requestId\) => ipcRenderer\.invoke\('subtitle:bilingual-cancel', requestId\)/)
  assert.match(player, /data-cancel-subtitle-translation="true"/)
  assert.match(player, /bilingualInFlightRef/)
  assert.match(player, /bilingualBusy \? '正在处理字幕…' : '翻译字幕'/)
})

test('HTML5 subtitles carry language metadata and live translations use reactive state', () => {
  assert.match(player, /<track[^>]+srcLang=\{subtitleTrackLang\}[^>]+label=\{subtitleTrackLang === 'en' \? 'English' : '中文字幕'\}/)
  assert.ok(player.includes("ext.trim().replace(/^\\./, '').toLowerCase()"), 'subtitle format accepts .srt as well as srt')
  assert.doesNotMatch(player, /liveTranslationsRef/)
  assert.match(player, /setLiveTranslations\(\(current\)/)
  assert.match(player, /liveTranslations\.get\(cue\.index\)/)
  const liveOverlay = player.slice(player.indexOf('{liveSub && !useMpv'), player.indexOf('{useMpv &&'))
  assert.doesNotMatch(liveOverlay, />\{cue\.text\}</)
  assert.match(liveOverlay, /data-live-translated-caption="true"/)
})

test('translated subtitles use a bounded professional cue style', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8')
  assert.match(css, /video::cue/)
  assert.match(css, /font-size:\s*clamp\(/)
  assert.match(css, /background-color:\s*rgba\(/)
})

test('a cached translated subtitle result is described as immediately displayed', () => {
  const generate = player.slice(player.indexOf('const generateBilingual'), player.indexOf('const liveRequestIdRef'))
  assert.match(generate, /result\.cached/)
  assert.match(generate, /displayedLanguage/)
  assert.match(generate, /字幕已显示/)
})
