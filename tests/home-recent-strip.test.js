const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const library = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'MediaLibrary.tsx'), 'utf8')
const sidebar = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8')
const workbench = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Workbench.tsx'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
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

test('sidebar exposes open, analysis, cast, model center and computer use entries', () => {
  for (const label of ['📂', '打开', '🎬', '拉片', '📺', '投屏', '🧩', '模型接入中心', '🖥', '电脑观察']) {
    assert.ok(sidebar.includes(label), `左栏缺：${label}`)
  }
  // Windows 组合对话框看不到文件：「打开」改为应用内两段式（文件走 chat.openAny，文件夹走 home.openFolder）
  assert.match(sidebar, /ai-player-ask-open-mode/)
  assert.match(main, /ipcMain\.handle\('home:open-folder'/)
  assert.match(preload, /openFolder: \(\) => ipcRenderer\.invoke\('home:open-folder'\)/)
  // 分流逻辑在 App 层：文件走 chat.openAny，文件夹进媒体库浮层
  assert.match(app, /ai-player-open-folder/)
  assert.match(app, /ai-player-attach-docs/)
  // 媒体库入口并入「打开」的文件夹授权，不再是左栏独立按钮；媒体库本身为浮层
  assert.ok(!library.includes('📂 打开'), '媒体库内不应再有打开动作行')
  assert.match(app, /<Workbench/)
  assert.match(app, /<MediaLibrary onPlay=\{playMedia\} rootDir=\{libraryRoot\} \/>/)
})

test('analysis opens the chat flow from sidebar, and empty library has no duplicate open entry', () => {
  assert.match(sidebar, /openAnalysisChat/)
  assert.match(sidebar, /就自动下载并开始拉片/)
  assert.doesNotMatch(sidebar, /detail: 'analysis-studio'/)
  // 空态只剩引导，不再有第二个“打开”
  const emptyBlock = library.slice(library.indexOf('这里还没有媒体文件'), library.indexOf('这里还没有媒体文件') + 900)
  assert.ok(!emptyBlock.includes('📂 打开'), '空态不应再有打开按钮')
})

test('sidebar shows recent list replaying on click; workbench panes resize and pin via localStorage', () => {
  // 播放记录迁入左栏底部，点击即回播
  assert.match(sidebar, /播放记录/)
  assert.match(sidebar, /recentMedia\.map/)
  assert.match(sidebar, /setMedia\(item\.name, item\.src\)/)
  // 右侧竖排 RecentStrip 已随布局移除
  assert.ok(!library.includes('RecentStrip'), '媒体库内的 RecentStrip 应已移除')
  // 三栏可拖拽拉伸 + 钉住，宽度持久化
  assert.match(workbench, /cursor-col-resize/)
  assert.match(workbench, /aiplayer_left_w/)
  assert.match(workbench, /aiplayer_right_w/)
  assert.match(workbench, /aiplayer_left_pinned/)
  // 右栏有媒体自动展开、左栏未钉住自动收起；影院模式全部收起
  assert.match(workbench, /leftVisible = !theater && \(pinned \|\| !rightOpen\)/)
  assert.match(app, /rightOpen = Boolean\(videoSrc\)/)
  assert.match(app, /clearMedia/)
})
