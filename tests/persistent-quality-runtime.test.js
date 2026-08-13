const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { PersistentTaskRuntime } = require('../electron/persistent-task-runtime')

const quality = (result) => ({
  version: 1, profile: 'technical', score: result.good ? 100 : 20, threshold: 80,
  passed: Boolean(result.good), level: result.good ? 'pass' : 'fail',
  reasons: result.good ? [] : [{ code: 'BAD_RESULT', message: '结果不合格', repairable: true }], checks: []
})

test('persistent runtime performs one bounded repair and persists its receipt', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-runtime-'))
  try {
    let calls = 0
    const runtime = new PersistentTaskRuntime({
      rootDir,
      qualityEvaluator: (_type, result) => quality(result),
      prepareRepair: () => ({ checkpoint: { stage: 'quality-repair', result: null } })
    })
    runtime.register('sample', async () => ({ good: ++calls > 1 }), { autoResume: true })
    runtime.enqueue({ id: 'quality-repair-1', type: 'sample', spec: {} })
    const task = await runtime.run('quality-repair-1')
    assert.equal(task.state, 'completed')
    assert.equal(task.quality.passed, true)
    assert.equal(task.repairHistory.length, 1)
    assert.equal(task.repairHistory[0].fromScore, 20)
    assert.equal(task.repairHistory[0].toScore, 100)
    assert.equal(calls, 2)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('persistent runtime fails closed after the bounded repair remains below threshold', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-fail-'))
  try {
    let calls = 0
    const runtime = new PersistentTaskRuntime({ rootDir, qualityEvaluator: (_type, result) => quality(result), prepareRepair: () => ({ checkpoint: {} }) })
    runtime.register('sample', async () => { calls += 1; return { good: false } })
    runtime.enqueue({ id: 'quality-fail-1', type: 'sample', spec: {} })
    const task = await runtime.run('quality-fail-1')
    assert.equal(task.state, 'failed')
    assert.equal(task.failure.code, 'QUALITY_GATE_FAILED')
    assert.equal(task.quality.score, 20)
    assert.equal(task.repairHistory.length, 1)
    assert.equal(calls, 2)
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})
