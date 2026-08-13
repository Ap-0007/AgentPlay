const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { snapshotDocumentSources, validateDocumentSources, outputsStillExist } = require('../electron/persistent-document-task')

test('document task freezes source fingerprints and rejects changed input on recovery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-persistent-doc-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, '合同.txt')
  fs.writeFileSync(source, '原始内容', 'utf8')
  const snapshot = snapshotDocumentSources([source])

  assert.deepEqual(validateDocumentSources(snapshot), [source])
  fs.writeFileSync(source, '被替换的内容', 'utf8')
  assert.throws(() => validateDocumentSources(snapshot), /源文件已发生变化/)
})

test('document recovery only trusts checkpoint outputs that still exist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-persistent-doc-out-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const output = path.join(root, '结果.docx')
  fs.writeFileSync(output, 'result')
  assert.equal(outputsStillExist({ outputs: [output] }), true)
  fs.rmSync(output)
  assert.equal(outputsStillExist({ outputs: [output] }), false)
})

test('document workspace persists an outputs-written checkpoint before history completion', async () => {
  const { DocumentWorkspaceService } = require('../electron/document-workspace-service')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-doc-checkpoint-'))
  try {
    const source = path.join(root, '原文.txt')
    fs.writeFileSync(source, '第一段\n第二段', 'utf8')
    const checkpoints = []
    const service = new DocumentWorkspaceService({ outputRoot: root, historyRoot: path.join(root, 'history') })
    const result = await service.run([source], '\u8f6c\u6362\u4e3a TXT', 'txt', { onCheckpoint: (value) => checkpoints.push(value) })
    assert.equal(result.success, true)
    assert.equal(checkpoints[0].stage, 'outputs-written')
    assert.deepEqual(checkpoints[0].result.outputs, result.outputs)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
