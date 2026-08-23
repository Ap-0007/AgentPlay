const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { TaskNotificationService, notificationText } = require('../electron/task-notification-service')

class FakeNotification extends EventEmitter {
  constructor(options) { super(); this.options = options; this.shown = false }
  show() { this.shown = true }
}

const makeTask = (state, extra = {}) => ({ id: `task-${state}`, workspaceTaskId: `workspace-${state}`, type: 'document.run', state, ...extra })

test('notification text reflects real completed, approval and failure states without exposing full paths', () => {
  const completed = notificationText(makeTask('completed', { result: { outputs: ['C:\\secret\\合同处理版.docx'] } }))
  assert.equal(completed.title, 'AgentPlay 已完成')
  assert.match(completed.body, /合同处理版\.docx/)
  assert.doesNotMatch(completed.body, /C:\\secret/)
  assert.match(notificationText(makeTask('waiting_approval', { approval: { summary: '发送本地提取片段，不上传原文件' } })).title, /等待确认/)
  assert.match(notificationText(makeTask('failed', { failure: { message: '模型上下文不足' } })).body, /上下文不足/)
})

test('native notification is shown once and clicking routes to the exact workspace task', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-notifications-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const native = []
  const activated = []
  let now = 1000
  const service = new TaskNotificationService({
    rootDir: root, now: () => ++now, isSupported: () => true,
    notificationFactory: (options) => { const item = new FakeNotification(options); native.push(item); return item },
    onActivate: (record) => activated.push(record)
  })
  const task = makeTask('completed', { result: { outputs: ['D:\\out\\result.pdf'] } })
  const first = service.notify(task)
  const duplicate = service.notify(task)
  assert.equal(first.id, duplicate.id)
  assert.equal(native.length, 1)
  assert.equal(native[0].shown, true)
  native[0].emit('click')
  assert.equal(activated[0].workspaceTaskId, 'workspace-completed')
  assert.equal(activated[0].outputPath, 'D:\\out\\result.pdf')
  assert.ok(service.history()[0].activatedAt > 0)
})

test('notification receipts survive restart and foreground suppression does not forge native delivery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-notifications-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = new TaskNotificationService({ rootDir: root, isSupported: () => true, shouldShowNative: () => false, notificationFactory: () => new FakeNotification({}) })
  const record = first.notify(makeTask('failed', { error: '处理失败' }))
  assert.equal(record.nativeSupported, true)
  assert.equal(record.nativeShown, false)
  const restarted = new TaskNotificationService({ rootDir: root })
  assert.equal(restarted.history()[0].state, 'failed')
  assert.equal(restarted.history()[0].body, '文档任务：处理失败')
})

test('running, queued and cancelled tasks never produce completion notifications', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-notifications-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const service = new TaskNotificationService({ rootDir: root })
  for (const state of ['queued', 'running', 'cancelled']) assert.equal(service.notify(makeTask(state)), null)
  assert.equal(service.history().length, 0)
})
