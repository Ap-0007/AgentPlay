const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  DocumentWorkspaceService,
  estimatePromptTokens
} = require('../electron/document-workspace-service')
const { friendlyModelError } = require('../electron/llm-service')
const { chooseDocumentModel } = require('../electron/model-context-policy')

test('retrying the same file with a new authorization token keeps one attachment', async () => {
  const { dedupeAttachments } = await import('../src/attachment-policy.mjs')
  const first = { token: 'first', name: '合同.docx', ext: '.docx', size: 1024, previewPath: 'C:\\Docs\\合同.docx' }
  const retry = { ...first, token: 'retry', previewPath: 'c:\\docs\\合同.docx' }
  assert.deepEqual(dedupeAttachments([first, retry]), [retry])
})

test('document workspace deduplicates identical source paths before prompt construction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-context-dedupe-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, '合同.txt')
  fs.writeFileSync(source, '唯一正文', 'utf8')
  let prompt = ''
  const service = new DocumentWorkspaceService({
    outputRoot: path.join(dir, 'out'),
    historyRoot: path.join(dir, 'history'),
    complete: async (input) => {
      prompt = input.prompt
      return { text: JSON.stringify({ title: '结果', summary: '完成', content: '结果正文' }) }
    }
  })
  const result = await service.run([source, source], '总结并整理成 Word', 'docx', { contextWindow: 8192 })
  assert.equal(result.success, true)
  assert.equal((prompt.match(/===== 合同\.txt =====/g) || []).length, 1)
})

test('2K local model processes a long document in bounded chunks instead of sending an oversized request', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-context-chunks-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, '长文档.txt')
  fs.writeFileSync(source, Array.from({ length: 180 }, (_, index) => `第${index + 1}条：租赁合同条款与责任边界，必须保留原始事实。`).join('\n\n'), 'utf8')
  const calls = []
  const service = new DocumentWorkspaceService({
    outputRoot: path.join(dir, 'out'),
    historyRoot: path.join(dir, 'history'),
    complete: async (input) => {
      calls.push(input)
      assert.ok(estimatePromptTokens(`${input.systemPrompt}\n${input.prompt}`) + Number(input.maxTokens || 0) <= 2048)
      if (input.responseMode === 'section') return { text: `## 已整理分段 ${calls.length}\n保留事实。` }
      return { text: JSON.stringify({ title: '结果', summary: '完成', content: '结果正文' }) }
    }
  })
  const result = await service.run([source], '总结并整理成 Word', 'docx', {
    contextWindow: 2048,
    maxOutputTokens: 512,
    modelLabel: '内置 Qwen2.5-0.5B'
  })
  assert.equal(result.success, true)
  assert.ok(calls.length > 1)
  assert.match(result.summary, /分段/)
})

test('document model routing only uses configured cloud fallback after explicit approval', () => {
  const local = { providerId: 'bundled-lite', model: 'local', contextWindow: 2048, ready: true, local: true }
  const cloud = { providerId: 'volcengine-coding', model: 'glm-5.2', contextWindow: 128000, ready: true, local: false }
  const preflight = { exceedsSingleCall: true }
  assert.deepEqual(chooseDocumentModel({ current: local, fallback: cloud, preflight, cloudApproved: false }), {
    config: local,
    mode: 'local-chunked',
    requiresCloudApproval: true
  })
  assert.deepEqual(chooseDocumentModel({ current: local, fallback: cloud, preflight, cloudApproved: true }), {
    config: cloud,
    mode: 'cloud-fallback',
    requiresCloudApproval: false
  })
})

test('raw provider context errors become an actionable Chinese message', () => {
  const raw = '模型 API 400: {"error":{"message":"request (4803 tokens) exceeds the available context size (2048 tokens)","type":"exceed_context_size_error"}}'
  assert.equal(
    friendlyModelError(raw, { providerName: '内置模型', model: 'Qwen2.5-0.5B' }),
    '当前内置模型（Qwen2.5-0.5B）一次最多处理约 2048 tokens，本次请求约 4803 tokens。AgentPlay 将改用分段处理；如果仍失败，可在模型接入中心选择大上下文云模型。'
  )
})
