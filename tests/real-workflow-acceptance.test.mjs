import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRealWorkflowAcceptance } from '../scripts/lib/real-workflow-acceptance.mjs'

const sha = 'a'.repeat(64)
const source = (path, chars, bytes) => ({ path, chars, bytes, beforeSha256: sha, afterSha256: sha, preserved: true })
const outputs = (formats) => formats.map((format) => ({ path: `out.${format}`, format, bytes: 100, sha256: sha, reopened: true }))
const workflow = (kind, formats, sources) => ({
  kind, sources, outputs: outputs(formats), quality: { passed: true, score: 100 }, deliveryConsistency: 'matched',
  continueModification: true, projectId: `project-${kind}`, modelCalls: kind === 'video-content-package' ? 4 : formats.length,
  ...(kind === 'video-content-package' ? { durationSeconds: 16, decoded: true, frameEvidenceCount: 6, workflowReceiptComplete: true } : {})
})

const valid = () => ({
  schemaVersion: 1, kind: 'agentplay.real-workflow-acceptance', controlledLocalModel: true, cloudUploads: 0,
  workflows: [
    workflow('contract', ['docx', 'xlsx', 'pdf'], [source('contract.docx', 4000, 20000)]),
    workflow('research', ['docx', 'pptx', 'xlsx'], [source('a.md', 6000, 6000), source('b.md', 5000, 5000)]),
    workflow('video-content-package', ['docx', 'pptx', 'xlsx'], [source('video.mp4', 0, 2 * 1024 * 1024)])
  ]
})

const dependencies = { exists: () => true, digest: () => sha }

test('real workflow acceptance requires contract, research and decoded video package together', () => {
  assert.equal(assertRealWorkflowAcceptance(valid(), dependencies).workflows.length, 3)
  const missing = valid(); missing.workflows.pop()
  assert.throws(() => assertRealWorkflowAcceptance(missing, dependencies), /必须同时验收/)
})

test('tiny fake sources, changed originals and unopened outputs fail closed', () => {
  const tiny = valid(); tiny.workflows[0].sources[0].chars = 20
  assert.throws(() => assertRealWorkflowAcceptance(tiny, dependencies), /正文不足/)
  const changed = valid(); changed.workflows[1].sources[0].afterSha256 = 'b'.repeat(64)
  assert.throws(() => assertRealWorkflowAcceptance(changed, dependencies), /改写了原始资料/)
  const unopened = valid(); unopened.workflows[2].outputs[0].reopened = false
  assert.throws(() => assertRealWorkflowAcceptance(unopened, dependencies), /无法回开/)
})

test('video workflow requires real decode, frame evidence and complete two-step orchestration', () => {
  const noFrames = valid(); noFrames.workflows[2].frameEvidenceCount = 0
  assert.throws(() => assertRealWorkflowAcceptance(noFrames, dependencies), /画面证据/)
  const repeated = valid(); repeated.workflows[2].modelCalls = 5
  assert.throws(() => assertRealWorkflowAcceptance(repeated, dependencies), /调用次数/)
})

test('private real-source acceptance cannot claim cloud uploads', () => {
  const uploaded = valid(); uploaded.cloudUploads = 1
  assert.throws(() => assertRealWorkflowAcceptance(uploaded, dependencies), /本机处理/)
})

test('packaged acceptance takes explicit real inputs and reopens every output without maintainer paths', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-packaged-real-workflows.mjs'), 'utf8')
  for (const input of ['--contract', '--research', '--video', '--ffmpeg-dir']) assert.match(smoke, new RegExp(input))
  assert.match(smoke, /assertRealWorkflowAcceptance\(receipt/)
  assert.match(smoke, /await reopenOutput\(outputPath\)/)
  assert.match(smoke, /sourceBefore\.get\(filePath\) === digest\(filePath\)/)
  assert.doesNotMatch(smoke, /C:\\Users\\Administrator|D:\\Ai工具升级/)
})
