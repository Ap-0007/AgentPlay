const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PersistentTaskRuntime, APPROVAL_ACTIONS } = require('../electron/persistent-task-runtime')

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-task-runtime-'))
}

test('a running download survives process loss and resumes from its persisted checkpoint', async (t) => {
  const root = tempRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = new PersistentTaskRuntime({ rootDir: root, now: () => 1000 })
  const created = first.enqueue({ id: 'download-1', type: 'download.direct', workspaceTaskId: 'workspace-1', spec: { url: 'https://cdn.example/video.mp4' } })
  first.markRunningForTest(created.id, { received: 4096, tempPath: 'video.part' })

  const checkpoints = []
  const second = new PersistentTaskRuntime({ rootDir: root, now: () => 2000 })
  second.register('download.direct', async ({ task, checkpoint }) => {
    checkpoints.push(task.checkpoint)
    checkpoint({ received: 8192 })
    return { outputPath: 'video.mp4', bytes: 8192 }
  }, { autoResume: true })
  await second.startRecoverable()

  assert.deepEqual(checkpoints, [{ received: 4096, tempPath: 'video.part' }])
  const resumed = second.get('download-1')
  assert.equal(resumed.state, 'completed')
  assert.equal(resumed.attempts, 2)
  assert.equal(resumed.workspaceTaskId, 'workspace-1')
  assert.equal(resumed.result.outputPath, 'video.mp4')
})

test('approval token is bound to frozen task spec, expires and can only be consumed once', async (t) => {
  const root = tempRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = 5000
  const runtime = new PersistentTaskRuntime({ rootDir: root, now: () => now })
  const created = runtime.enqueue({
    id: 'cloud-1',
    type: 'analysis.cloud',
    spec: { sourcePath: 'D:/video.mp4', model: 'agnes-2.0-flash' },
    approval: { action: 'cloud', summary: '把视频关键帧发送到云端', ttlMs: 60_000 }
  })

  assert.equal(created.state, 'waiting_approval')
  assert.equal(created.approval.action, 'cloud')
  assert.throws(() => runtime.approve(created.approval.id, 'wrong-token'), /审批令牌无效/)
  const approved = runtime.approve(created.approval.id, created.approval.token)
  assert.equal(approved.state, 'queued')
  assert.throws(() => runtime.approve(created.approval.id, created.approval.token), /已经使用/)

  const expiring = runtime.enqueue({ id: 'paid-1', type: 'render.paid', spec: { prompt: 'x' }, approval: { action: 'paid', summary: '调用付费模型', ttlMs: 10 } })
  now += 1001
  assert.throws(() => runtime.approve(expiring.approval.id, expiring.approval.token), /已经过期/)
})

test('all sensitive actions use one closed approval vocabulary', () => {
  assert.deepEqual([...APPROVAL_ACTIONS].sort(), ['cloud', 'credential', 'delete', 'paid', 'publish'])
})

test('tampered persisted execution spec fails closed instead of resuming modified work', (t) => {
  const root = tempRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const first = new PersistentTaskRuntime({ rootDir: root })
  first.enqueue({ id: 'publish-1', type: 'release.publish', spec: { repo: 'wg5759/AgentPlay', tag: 'v0.8.0' }, approval: { action: 'publish', summary: '公开发布' } })
  const statePath = path.join(root, 'task-runtime-v1.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.tasks[0].spec.tag = 'v9.9.9'
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8')

  const restored = new PersistentTaskRuntime({ rootDir: root }).get('publish-1')
  assert.equal(restored.state, 'failed')
  assert.match(restored.error, /执行规范完整性校验失败/)
})
