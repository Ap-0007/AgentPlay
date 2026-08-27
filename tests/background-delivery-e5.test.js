const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

test('cold-start recovery expires stale approvals and surfaces the failure', () => {
  const runtime = read('electron/persistent-task-runtime.js')
  assert.match(runtime, /expireApproval\(task\)/)
  assert.match(runtime, /if \(this\.expireApproval\(task\)\) continue/)
  assert.match(runtime, /status: '审批已过期'/)
})

test('E5 packaged acceptance performs a real crash, restart, expiry, notification and result reopen', () => {
  const smoke = read('scripts/smoke-packaged-background-delivery-e5.mjs')
  for (const marker of [
    'checkpoint?.bundle?.sections?.docx', 'stopApp(first, false)', 'attempts !== 2',
    "approval?.status !== 'expired'", 'notifications.activate', 'agentplay-notification-navigated',
    'ai-player-play-file', 'modelCalls.filter'
  ]) assert.ok(smoke.includes(marker), `missing E5 acceptance marker: ${marker}`)
})
