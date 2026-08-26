const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { compileBatchEditPlan, assertBatchEditPlan } = require('../electron/batch-edit-plan')
const { BatchEditService } = require('../electron/batch-edit-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')

test('E3 freezes one equivalent edit plan for every selected source', () => {
  const planResult = compileBatchEditPlan({ instruction: '全部保留第1秒到第3秒', sourcePaths: ['D:/a.mp4', 'D:/b.mp4', 'D:/c.mp4'] })
  assert.equal(planResult.matched, true)
  assert.equal(assertBatchEditPlan(planResult.plan), planResult.plan)
  assert.equal(planResult.plan.strategy, 'independent-media-edit-batch-v1')
  assert.deepEqual(planResult.plan.items.map((item) => item.decision.kind), ['media.trim', 'media.trim', 'media.trim'])
  const changed = structuredClone(planResult.plan); changed.items[0].decision.timeline.endSeconds = 9
  assert.throws(() => assertBatchEditPlan(changed), /已被修改/)
})

test('E3 isolates a failed item and resumes without repeating completed items', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-batch-edit-e3-'))
  const outputs = [0, 1, 2].map((index) => path.join(root, `${index}.mp4`))
  const task = { id: 'batch-e3', spec: { planDigest: 'a'.repeat(64), items: outputs.map((outputPath, index) => ({ id: `item-${index + 1}`, sourceName: `${index}.mp4`, outputPath, taskType: 'media.edit-trim', decision: {}, sources: [{ fingerprint: `${index}` }] })) }, checkpoint: {} }
  const checkpoints = []
  const service = new BatchEditService({
    executeItem: async ({ index, item }) => {
      if (index === 1) throw new Error('片段结束时间超出视频时长')
      fs.writeFileSync(item.outputPath, Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(24)]))
      return { success: true, outputs: [item.outputPath] }
    },
    evaluateItem: () => ({ passed: true, score: 100 }),
    classifyFailure: (error) => ({ code: 'MEDIA_RANGE_OUT_OF_BOUNDS', message: error.message, retryable: false }),
    cleanupOutput: (outputPath) => { try { fs.rmSync(outputPath, { force: true }) } catch {} }
  })
  const result = await service.run({ task, signal: new AbortController().signal, checkpoint: (value) => checkpoints.push(structuredClone(value)), status: () => {} })
  assert.equal(result.outputs.length, 2)
  assert.deepEqual(result.results.map((item) => item.state), ['succeeded', 'failed', 'succeeded'])
  assert.equal(result.results[1].outputPath, undefined)
  assert.equal(result.batchEditReceipt.verdict, 'complete-with-isolated-failures')
  const quality = evaluateTaskResult('media.batch-edit', result, task.spec)
  assert.equal(quality.passed, true)
  assert.equal(quality.score, 100)

  let calls = 0
  const resumed = new BatchEditService({ executeItem: async () => { calls += 1 }, evaluateItem: () => ({ passed: true, score: 100 }), classifyFailure: () => ({}) })
  task.checkpoint = checkpoints.at(-1)
  const recovered = await resumed.run({ task, signal: new AbortController().signal, checkpoint: () => {}, status: () => {} })
  assert.equal(calls, 0)
  assert.equal(recovered.batchEditReceipt.recovery.repeatedCompletedItems, 0)
})
