const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

test('Electron 43 拖入文件通过 webUtils 取真实路径，不能依赖已移除的 File.path', () => {
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const incoming = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useIncomingFiles.ts'), 'utf8')
  const types = fs.readFileSync(path.join(root, 'src', 'types', 'global.d.ts'), 'utf8')
  assert.match(preload, /webUtils/)
  assert.match(preload, /getPathForFile:\s*\(file\)\s*=>\s*webUtils\.getPathForFile\(file\)/)
  assert.match(types, /getPathForFile:\s*\(file:\s*File\)\s*=>\s*string/)
  assert.match(incoming, /files\?\.getPathForFile\?\.\(file\)/)
})

test('粘贴和拖入共用同一附件授权与立即预览函数', () => {
  const panel = fs.readFileSync(path.join(root, 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const incoming = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useIncomingFiles.ts'), 'utf8')
  assert.match(panel, /import useIncomingFiles from '.\/agent-panel\/useIncomingFiles'/)
  assert.match(panel, /onPaste=\{\(event\)\s*=>\s*void handlePasteFiles\(event\)\}/)
  assert.match(incoming, /const attachIncomingFiles = async/)
  assert.match(incoming, /handleDropFiles[\s\S]{0,400}attachIncomingFiles/)
  assert.match(incoming, /handlePasteFiles[\s\S]{0,400}attachIncomingFiles/)
  assert.match(incoming, /selectDocumentPreviewPath\(result\)/)
  assert.match(panel, /data-agent-attachment=\{file\.name\}/)
})

test('普通文字粘贴不被文件入口拦截', () => {
  const incoming = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useIncomingFiles.ts'), 'utf8')
  assert.match(incoming, /if\s*\(!files\.length\)\s*return/)
  assert.match(incoming, /event\.preventDefault\(\)/)
})

test('打开预览引发布局切换时附件由工作区 store 持有，不能随 AgentPanel 重挂载丢失', () => {
  const panel = fs.readFileSync(path.join(root, 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const store = fs.readFileSync(path.join(root, 'src', 'stores', 'agentStore.ts'), 'utf8')
  assert.doesNotMatch(panel, /useState<AgentAttachment\[\]>/)
  assert.match(panel, /useAgentStore\(\(s\) => s\.attachments\)/)
  assert.match(store, /attachments: AgentDocumentAttachment\[\]/)
  assert.match(store, /setAttachments:/)
  assert.doesNotMatch(store, /partialize:[^\n]*attachments/)
})
