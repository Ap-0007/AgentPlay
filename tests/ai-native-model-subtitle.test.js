const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { agentPanelSource } = require('./helpers/agent-panel-source')

const root = path.join(__dirname, '..')

test('AI-native shell hides the legacy menu while preserving the application menu behind Alt', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  assert.match(main, /autoHideMenuBar:\s*true/)
  assert.match(main, /window:setPlaybackChromeVisible[\s\S]{0,520}setAutoHideMenuBar\(true\)[\s\S]{0,180}setMenuBarVisibility\(false\)/)
})

test('runtime settings lead to the single AI usage flow instead of exposing a second mode switch', () => {
  const panel = agentPanelSource()
  const center = fs.readFileSync(path.join(root, 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  assert.match(panel, /更改 AI 使用方式/)
  assert.match(panel, /const openModelCenter[\s\S]{0,240}model-center/)
  assert.match(panel, /onClick={openModelCenter}>更改 AI 使用方式/)
  assert.doesNotMatch(panel, /models\?\.quickSwitch/)
  assert.match(center, /接入一个云端服务/)
  assert.match(center, /API Key/)
})

test('English-language prompt orchestrates subtitle generation and labels online subtitle credentials honestly', () => {
  const player = fs.readFileSync(path.join(root, 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const prompt = player.slice(player.indexOf('{langPrompt && ('), player.indexOf('{playbackNotice &&'))
  assert.match(prompt, /显示\{langPrompt\.targetLang\}字幕/)
  assert.match(prompt, /generateBilingual/)
  assert.doesNotMatch(prompt, /搜索现成字幕/)
  assert.doesNotMatch(prompt, /译成英文/)
  assert.match(player, /OpenSubtitles API Key（不是 AI 模型）/)
})

test('downloaded media under the player video root remains subtitle-authorized after restart', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const bilingualStart = main.indexOf('const preparePersistentSubtitleTask')
  const liveStart = main.indexOf("ipcMain.handle('subtitle:live-start'")
  const bilingual = main.slice(bilingualStart, bilingualStart + 1800)
  const live = main.slice(liveStart, liveStart + 1800)
  assert.ok(bilingualStart >= 0 && liveStart >= 0, '字幕 IPC 必须存在')
  assert.match(bilingual, /assertAllowedPath\(input\.path\)/)
  assert.match(live, /isPathInsideRoots\(mediaPath, allowedRoots\(\)/)
})
