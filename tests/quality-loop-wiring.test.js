const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('main runtime wires one quality authority and a bounded safe repair planner', () => {
  const main = read('electron/main.js')
  assert.match(main, /task-result-quality/)
  assert.match(main, /qualityEvaluator:\s*evaluateTaskResult/)
  assert.match(main, /prepareRepair:/)
  assert.match(main, /maxQualityRepairs:\s*1/)
  assert.match(main, /media\.batch/)
  assert.match(main, /creative\./)
})

test('workspace task center renders quality score, reasons and automatic repair receipts', () => {
  const lifecycle = read('src/taskLifecycle.ts')
  const recovery = read('src/components/agent-panel/usePersistentTaskRuntime.ts')
  const center = read('src/components/TaskCenter.tsx')
  assert.match(lifecycle, /WorkspaceTaskQuality/)
  assert.match(recovery, /quality:/)
  assert.match(recovery, /repairHistory:/)
  assert.match(center, /质量评分/)
  assert.match(center, /自动修复/)
})
