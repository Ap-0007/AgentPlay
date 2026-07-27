const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { DocumentWorkspaceService } = require('../electron/document-workspace-service')

const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AgentPanel.tsx'), 'utf8')
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'agentStore.ts'), 'utf8')

test('task card lives in agent store and panel renders progress, retry and outputs', () => {
  assert.match(store, /interface AgentTask/)
  assert.match(store, /setTask: \(patch: Partial<AgentTask>\) => void/)
  assert.match(panel, /task\.running/)
  assert.match(panel, /task\.error/)
  assert.match(panel, /重试/)
  assert.match(panel, /animate-pulse.*rounded-full bg-blue-400/)
})

test('feature menu is trimmed to the four daily entries', () => {
  const menuBlock = main.slice(main.indexOf("{ label: '功能', submenu: ["), main.indexOf("{ label: '窗口', submenu: ["))
  for (const keep of ['AI 对话窗', '模型接入中心', '拉片、深度解剖与原创重构', '设备、投屏与同步']) {
    assert.ok(menuBlock.includes(keep), `应保留：${keep}`)
  }
  for (const removed of ['AI 助手', '屏幕录制', '重复文件检查', '智能整理建议', '海报信息刮削', '插件管理', '电脑操作建议', '语音唤醒']) {
    assert.ok(!menuBlock.includes(removed), `应下线：${removed}`)
  }
})

test('image tasks classify edits locally and understanding as image-ask', () => {
  const workspace = new DocumentWorkspaceService({ outputRoot: os.tmpdir(), historyRoot: os.tmpdir() })
  const img = path.join(os.tmpdir(), '照片.png')
  fs.writeFileSync(img, Buffer.from([1, 2, 3]))
  const file = { path: img, name: '照片.png', ext: '.png', size: 3 }
  const editPlan = workspace.plan([img], '压缩到原来的50%，转成webp', 'auto')
  assert.equal(editPlan.kind, 'image-convert')
  assert.equal(editPlan.requiresAi, false)
  const askPlan = workspace.plan([img], '描述一下这张图里有什么', 'auto')
  assert.equal(askPlan.kind, 'image-ask')
  assert.equal(askPlan.requiresAi, true)
  assert.throws(() => workspace.plan([img], '你好', 'auto'), /图片任务请说明/)
})

test('image-ask runs describeImage and returns the answer as the summary', async () => {
  const workspace = new DocumentWorkspaceService({
    outputRoot: os.tmpdir(),
    historyRoot: os.tmpdir(),
    describeImage: async (imagePath, instruction) => {
      assert.ok(imagePath.endsWith('.png'))
      assert.match(instruction, /什么/)
      return '图里是三只猫。'
    }
  })
  const img = path.join(os.tmpdir(), 'cats.png')
  fs.writeFileSync(img, Buffer.from([9, 9]))
  const result = await workspace.run([img], '这张图里有什么？', 'auto', {})
  assert.equal(result.success, true)
  assert.equal(result.summary, '图里是三只猫。')
  assert.deepEqual(result.outputs, [])
})

test('image understanding wires vision first with OCR fallback, and images attach from chat open', () => {
  assert.match(main, /describeImage/)
  assert.match(main, /completeVision/)
  assert.match(main, /回落 OCR/)
  assert.doesNotMatch(main, /图片\/音视频走播放器/, '图片不再被分流到播放器')
  const llm = fs.readFileSync(path.join(__dirname, '..', 'electron', 'llm-service.js'), 'utf8')
  assert.match(llm, /completeVision/)
  assert.match(llm, /image_url/)
  assert.match(panel, /attachPaths/)
  assert.match(panel, /handleDropFiles/)
})
