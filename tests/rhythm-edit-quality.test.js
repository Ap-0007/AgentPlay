const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { evaluateTaskResult } = require('../electron/task-result-quality')

test('C3 quality is 100 only with all rhythm, highlight and tail evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-quality-rhythm-'))
  try {
    const output = path.join(dir, 'rhythm.mp4')
    fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
    const rhythm = { pace: 'balanced', bpm: 120, supportRatio: 0.9, outputDurationSeconds: 10, cutTimes: [2, 4, 6, 8] }
    const result = {
      success: true, outputs: [output], durationSeconds: 10,
      rhythmReceipt: { schemaVersion: 1, strategy: 'beat-synced-jump-cut-v1', ...rhythm },
      beatProof: { schemaVersion: 1, method: 'decoded-beat-cut-proof-v1', visibleCutRatio: 0.75, musicCorrelation: 0.4, highlight: { densityRatio: 0.5, denserThanOutside: true }, tail: { audioFaded: true, videoFaded: true } },
      audioExportQc: { schemaVersion: 1, method: 'unified-audio-export-qc-v1', verdict: 'matched', clipping: { verdict: 'matched', truePeakDbtp: -1.2 }, loudness: { verdict: 'matched', integratedLufs: -16 }, avSync: { verdict: 'matched', startDeltaSeconds: 0, endDeltaSeconds: 0 }, silence: { verdict: 'matched', maximumSilenceSeconds: 0 }, copyright: { verdict: 'documented', sources: [{ status: 'user-supplied-unverified' }] } },
      projectCapsule: { schemaVersion: 1, projectId: 'edit-rhythm', versionId: 'version-rhythm', currentPath: output, canUndo: true }
    }
    const spec = { decision: { rhythm, verification: { toleranceSeconds: 0.2, minimumVisibleCutRatio: 0.5 } } }
    const passed = evaluateTaskResult('media.rhythm-edit', result, spec)
    assert.equal(passed.passed, true)
    assert.equal(passed.score, 100)
    const failed = evaluateTaskResult('media.rhythm-edit', { ...result, beatProof: { ...result.beatProof, tail: { audioFaded: true, videoFaded: false } } }, spec)
    assert.equal(failed.passed, false)
    assert.ok(failed.reasons.some((item) => item.code === 'TAIL_FADE_MISSING'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
