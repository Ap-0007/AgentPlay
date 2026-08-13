const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { evaluateTaskResult, classifyTaskFailure } = require('../electron/task-result-quality')

test('subtitle quality score verifies a real target-language SRT artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-srt-'))
  try {
    const output = path.join(dir, 'translated.srt')
    fs.writeFileSync(output, '1\n00:00:00,000 --> 00:00:02,000\n这是一条有效字幕。\n', 'utf8')
    const quality = evaluateTaskResult('subtitle.generate', { success: true, outputs: [output], count: 1, targetLang: '中文' }, { targetLang: '中文' })
    assert.equal(quality.passed, true)
    assert.ok(quality.score >= quality.threshold)
    assert.equal(quality.reasons.length, 0)
    assert.ok(quality.checks.some((item) => item.id === 'subtitle-cues' && item.passed))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('missing artifacts and partial batches expose stable repairable failure reasons', () => {
  const missing = evaluateTaskResult('media.compress', { success: true, outputs: ['Z:\\missing.mp4'] }, {})
  assert.equal(missing.passed, false)
  assert.ok(missing.reasons.some((item) => item.code === 'ARTIFACT_MISSING' && item.repairable))

  const batch = evaluateTaskResult('media.batch', {
    success: true,
    results: [{ success: true, outputPath: __filename }, { success: false, error: '转写失败' }],
    outputs: [__filename]
  }, { kind: 'transcribe', sources: [{}, {}] })
  assert.equal(batch.passed, false)
  assert.ok(batch.reasons.some((item) => item.code === 'PARTIAL_BATCH' && item.repairable))
})

test('runtime failures are classified into actionable stable codes', () => {
  assert.deepEqual(classifyTaskFailure(new Error('request exceeds the available context size')), {
    code: 'MODEL_CONTEXT_EXCEEDED', message: '模型上下文容量不足，请减少内容或切换大上下文模型', retryable: true
  })
  assert.equal(classifyTaskFailure(new Error('源文件已发生变化')).code, 'SOURCE_CHANGED')
  assert.equal(classifyTaskFailure(new Error('缺少 ffmpeg 组件')).code, 'COMPONENT_MISSING')
})

test('video artifacts require a real supported container signature', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-video-'))
  try {
    const invalid = path.join(dir, 'invalid.mp4')
    const valid = path.join(dir, 'valid.mp4')
    fs.writeFileSync(invalid, Buffer.alloc(2048, 2))
    fs.writeFileSync(valid, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const invalidQuality = evaluateTaskResult('creative.video-generate', { success: true, outputs: [invalid] }, {})
    const validQuality = evaluateTaskResult('creative.video-generate', { success: true, outputs: [valid] }, {})
    assert.equal(invalidQuality.passed, false)
    assert.ok(invalidQuality.reasons.some((item) => item.code === 'INVALID_FORMAT'))
    assert.equal(validQuality.passed, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('media trim quality requires a verified timeline and duration receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-trim-'))
  try {
    const output = path.join(dir, 'trimmed.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)]))
    const spec = { decision: { timeline: { durationSeconds: 16 }, verification: { toleranceSeconds: 0.2 } } }
    const passed = evaluateTaskResult('media.edit-trim', {
      success: true,
      outputs: [output],
      durationSeconds: 16.04,
      expectedDurationSeconds: 16,
      timelineReceipt: [{ sourceRange: '00:04.000 → 00:20.000', outputRange: '00:00.000 → 00:16.000' }]
    }, spec)
    assert.equal(passed.passed, true)
    assert.ok(passed.checks.some((item) => item.id === 'duration-receipt' && item.passed))

    const failed = evaluateTaskResult('media.edit-trim', {
      success: true, outputs: [output], durationSeconds: 14.8, expectedDurationSeconds: 16, timelineReceipt: []
    }, spec)
    assert.equal(failed.passed, false)
    assert.ok(failed.reasons.some((item) => item.code === 'DURATION_MISMATCH'))
    assert.ok(failed.reasons.some((item) => item.code === 'TIMELINE_RECEIPT_MISSING'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
