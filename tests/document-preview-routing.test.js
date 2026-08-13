const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('统一打开：仅有文档时立即预览第一个已授权文档', async () => {
  const { selectPrimaryPreviewPath } = await import('../src/document-preview-routing.mjs')
  const path = selectPrimaryPreviewPath([], [
    { token: 'doc-1', name: '合同.docx', ext: '.docx', size: 100, previewPath: 'D:/合同.docx' }
  ])
  assert.equal(path, 'D:/合同.docx')
})

test('统一打开：媒体与文档同选时媒体优先显示，文档仍可作为附件', async () => {
  const { selectPrimaryPreviewPath } = await import('../src/document-preview-routing.mjs')
  const path = selectPrimaryPreviewPath(['D:/演示.mp4'], [
    { token: 'doc-1', name: '提纲.docx', ext: '.docx', size: 100, previewPath: 'D:/提纲.docx' }
  ])
  assert.equal(path, 'D:/演示.mp4')
})

test('附件批次：忽略缺失路径的旧记录，预览第一个可用文档', async () => {
  const { selectDocumentPreviewPath } = await import('../src/document-preview-routing.mjs')
  const path = selectDocumentPreviewPath([
    { token: 'legacy', name: '旧记录.pdf', ext: '.pdf', size: 10 },
    { token: 'doc-2', name: '报表.xlsx', ext: '.xlsx', size: 100, previewPath: 'D:/报表.xlsx' }
  ])
  assert.equal(path, 'D:/报表.xlsx')
})

test('扩展办公格式走已授权的内置正文预览，不退化成空白附件', () => {
  const root = path.join(__dirname, '..')
  const player = fs.readFileSync(path.join(root, 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  assert.match(player, /'\.odt'[\s\S]{0,80}'\.ods'[\s\S]{0,80}'\.odp'[\s\S]{0,80}'\.rtf'/)
  assert.match(player, /documents\?\.previewText\(videoSrc\)/)
  assert.match(main, /documents:preview-text[\s\S]{0,240}assertAllowedPath[\s\S]{0,240}extractText/)
})

test('主进程只为已批准附件返回预览路径，三个界面入口复用同一预览策略', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const panel = fs.readFileSync(path.join(root, 'src', 'components', 'AgentPanel.tsx'), 'utf8')
  const incomingFiles = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useIncomingFiles.ts'), 'utf8')
  assert.ok((main.match(/previewPath:\s*file\.path/g) || []).length >= 2)
  assert.match(app, /selectPrimaryPreviewPath\(result\.media, result\.documents\)/)
  assert.match(panel, /selectPrimaryPreviewPath\(result\.media, result\.documents\)/)
  assert.equal((panel.match(/selectDocumentPreviewPath\(/g) || []).length, 2)
  assert.equal((incomingFiles.match(/selectDocumentPreviewPath\(/g) || []).length, 1)
})
