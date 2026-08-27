const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MEDIA_EDIT_TASKS, assertMediaEditGovernance, freezeMediaEditGovernance, runGovernedMediaEdit } = require('../electron/media-edit-governance')
const { evaluateTaskResult } = require('../electron/task-result-quality')

test('E4 registers every persistent edit task in one governance table', () => {
  assert.equal(Object.keys(MEDIA_EDIT_TASKS).length, 20)
  for (const type of ['media.edit-trim', 'media.edit-music', 'media.edit-visual-effects', 'media.translate-subtitles', 'media.version-bundle', 'media.batch-edit']) assert.ok(MEDIA_EDIT_TASKS[type], type)
})

test('E4 freezes route, task-bound approval, budget, runtime and registry', () => {
  const route = { providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: 'https://api.example/v1', local: false, taskKind: 'subtitle-translation' }
  const decision = { kind: 'media.translate-subtitles' }
  const governance = freezeMediaEditGovernance({ taskType: 'media.translate-subtitles', decision, modelRoute: route, approvalContract: { action: 'cloud' } })
  assert.equal(governance.approval.scope, 'task-bound-token')
  assert.equal(governance.registry.hiddenExecutor, false)
  assert.equal(governance.runtime.name, 'PersistentTaskRuntime')
  assert.equal(governance.budget.maxToolCalls, 1)
  assert.equal(assertMediaEditGovernance(governance, { taskType: 'media.translate-subtitles', decision, modelRoute: route }), governance)
  assert.throws(() => freezeMediaEditGovernance({ taskType: 'media.translate-subtitles', decision, modelRoute: route }), /缺少统一审批对象/)
  const changed = structuredClone(governance); changed.budget.maxToolCalls = 9
  assert.throws(() => assertMediaEditGovernance(changed, { taskType: 'media.translate-subtitles', decision, modelRoute: route }), /已被修改/)
})

test('E4 wraps the real executor with one verified AgentRunLedger receipt', async () => {
  const decision = { kind: 'media.trim' }
  const editGovernance = freezeMediaEditGovernance({ taskType: 'media.edit-trim', decision })
  const result = await runGovernedMediaEdit({ task: { id: 'e4-run', type: 'media.edit-trim', spec: { decision, editGovernance }, approval: null }, executor: async () => ({ success: true }) })
  assert.equal(result.editGovernanceReceipt.verdict, 'matched')
  assert.equal(result.editGovernanceReceipt.run.status, 'completed')
  assert.equal(result.editGovernanceReceipt.run.budget.toolCalls, 1)
  assert.equal(result.editGovernanceReceipt.run.steps[0].evidence.verified, true)
})

test('E4 quality gate fails closed when a governed edit loses its run receipt', () => {
  const decision = { kind: 'media.trim', timeline: { durationSeconds: 2 }, verification: { toleranceSeconds: 0.2 } }
  const editGovernance = freezeMediaEditGovernance({ taskType: 'media.edit-trim', decision })
  const quality = evaluateTaskResult('media.edit-trim', { success: true }, { decision, editGovernance })
  assert.equal(quality.passed, false)
  assert.ok(quality.reasons.some((item) => item.code === 'EDIT_GOVERNANCE_RECEIPT_MISSING'))
})

test('E4 main process has no direct persistent edit registration and shares one executor registry with batch', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.doesNotMatch(main, /persistentTaskRuntime\.register\('media\.(?:edit|audio|rhythm|smart|visual|version|shift|translate|transform|subtitle|batch-edit)/)
  assert.match(main, /registerGovernedMediaEdit\('media\.edit-trim'/)
  assert.match(main, /registerGovernedMediaEdit\('media\.batch-edit'/)
  assert.ok((main.match(/mediaEditExecutors\.execute\(/g) || []).length >= 5)
  assert.match(main, /freezeMediaEditGovernance/)
  assert.match(main, /approvalContract/)
  assert.match(main, /编辑任务超过冻结时间预算/)
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-batch-edit-e3.mjs'), 'utf8')
  assert.match(smoke, /media-edit-governance-e4-packaged/)
  assert.match(smoke, /governance\?\.run\?\.budget\?\.toolCalls !== 1/)
})
