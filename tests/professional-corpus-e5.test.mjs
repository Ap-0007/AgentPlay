import test from 'node:test'
import assert from 'node:assert/strict'
import { E5_GROUPS, percentile, validateManualReview, validateTechnicalReceipt } from '../scripts/lib/professional-corpus-e5.mjs'

const samples = E5_GROUPS.flatMap((group) => Array.from({ length: 4 }, (_, index) => ({ id: `${group}-${index + 1}`, group, license: 'self-generated', sourceHashUnchanged: true, qualityScore: 100, output: { decodePassed: true }, governance: { verifiedStep: true }, elapsedMs: 100 + index })))
const technical = { schemaVersion: 1, kind: 'agentplay.professional-corpus-e5', installedAcceptance: true, samples, performance: { sampleCount: 20, totalElapsedMs: 2000, p95ElapsedMs: 103 }, cost: { cloudCalls: 0, estimatedUsd: 0, basis: 'local-deterministic-acceptance' }, restart: { persisted: true, repeatedCompletedTasks: 0 } }

test('E5 requires 20 installed self-generated samples across five professional groups', () => {
  assert.equal(validateTechnicalReceipt(technical), technical)
  assert.throws(() => validateTechnicalReceipt({ ...technical, samples: samples.slice(0, 19) }), /至少需要20个/)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5)
})

test('E5 manual review must explicitly pass every sample and every visual criterion', () => {
  const review = { schemaVersion: 1, kind: 'agentplay.professional-corpus-e5-manual-review', reviewer: 'Codex professional review', reviewedAt: new Date().toISOString(), contactSheets: E5_GROUPS.map((group) => `${group}.png`), decisions: samples.map((item) => ({ id: item.id, verdict: 'pass', visualContinuity: true, operationMatched: true, artifactFree: true, note: '接触表与技术回执一致' })) }
  assert.equal(validateManualReview(review, technical).manualReview.passed, 20)
  review.decisions[0].artifactFree = false
  assert.throws(() => validateManualReview(review, technical), /未通过/)
})

test('E5 installed smoke and finalizer keep technical evidence separate from human judgment', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const root = path.resolve(import.meta.dirname, '..')
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-packaged-professional-corpus-e5.mjs'), 'utf8')
  const finalizer = fs.readFileSync(path.join(root, 'scripts', 'finalize-professional-corpus-e5.mjs'), 'utf8')
  assert.match(smoke, /manualReviewStatus: 'pending'/)
  assert.match(smoke, /mediaTools\.runBatchEdit/)
  assert.match(smoke, /mediaTools\.trim/)
  assert.match(finalizer, /validateManualReview/)
})
