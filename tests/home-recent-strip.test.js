const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'global.d.ts'), 'utf8')

test('home:open combines file and directory selection in one dialog', () => {
  assert.match(main, /ipcMain\.handle\('home:open'/)
  assert.match(main, /'openFile', 'openDirectory', 'multiSelections'/)
  assert.match(main, /authorizedFolders\.add\(folder\)/)
  assert.match(main, /splitAndApproveAny\(files\)/)
  assert.match(preload, /home: \{/)
  assert.match(preload, /open: \(\) => ipcRenderer\.invoke\('home:open'\)/)
  assert.match(types, /folders: string\[\]/)
})

test('home action row exposes open, agent panel, analysis, cast and model center', () => {
  for (const label of ['📂 打开', '🎙️ AI 对话窗', '🎬 拉片', '📺 投屏', '🧩 模型接入中心']) {
    assert.ok(library.includes(label), `动作行缺：${label}`)
  }
  assert.match(library, /window\.aiPlayer\?\.home\?\.open\(\)/)
  assert.match(library, /ai-player-open-folder/)
  assert.match(library, /ai-player-attach-docs/)
  // 空态只剩一个“打开”
  const emptyBlock = library.slice(library.indexOf('这里还没有媒体文件'), library.indexOf('这里还没有媒体文件') + 900)
  assert.ok(emptyBlock.includes('📂 打开'))
  assert.ok(!emptyBlock.includes('打开文件夹'))
})

test('recent strip auto-hides after idle, pins via localStorage and replays on click', () => {
  assert.match(library, /function RecentStrip/)
  assert.match(library, /aiplayer_recent_pinned/)
  assert.match(library, /setTimeout\(\(\) => setCollapsed\(true\), 4000\)/)
  assert.match(library, /writingMode: 'vertical-rl'/)
  assert.match(library, /onPlay\(item\.name, item\.src\)/)
  assert.match(library, /<RecentStrip onPlay=\{onPlay\} \/>/)
})
