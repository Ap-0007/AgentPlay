const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { UnlimitedOcrConfigStore, UnlimitedOcrService } = require('../electron/unlimited-ocr-service')
const { DocumentWorkspaceService, classifyTask, extractText } = require('../electron/document-workspace-service')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^sealed:/, '')
  }
}

test('advanced document OCR is disabled by default and only accepts loopback without remote approval', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())

  assert.deepEqual(store.publicConfig(), {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'baidu/Unlimited-OCR',
    local: true,
    hasApiKey: false
  })

  const local = store.save({ enabled: true, baseUrl: 'http://localhost:8000/v1', model: 'baidu/Unlimited-OCR' })
  assert.equal(local.enabled, true)
  assert.equal(local.local, true)

  assert.throws(
    () => store.save({ enabled: true, baseUrl: 'https://ocr.example.com/v1', model: 'baidu/Unlimited-OCR' }),
    /远端.*确认/
  )
  assert.throws(
    () => store.save({ enabled: true, baseUrl: 'http://ocr.example.com/v1' }, { remoteApproved: true }),
    /HTTPS/
  )
  const remote = store.save({ enabled: true, baseUrl: 'https://ocr.example.com/v1', model: 'baidu/Unlimited-OCR' }, { remoteApproved: true })
  assert.equal(remote.local, false)
  assert.throws(() => store.save({ baseUrl: 'https://name:secret@ocr.example.com/v1' }, { remoteApproved: true }), /用户名|密码/)
  assert.throws(() => store.save({ baseUrl: 'https://ocr.example.com/v1?api_key=secret' }, { remoteApproved: true }), /查询参数/)
})

test('probe verifies the configured model through the OpenAI-compatible models endpoint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())
  store.save({ enabled: true, baseUrl: 'http://127.0.0.1:8000/v1', model: 'baidu/Unlimited-OCR' })
  const requests = []
  const service = new UnlimitedOcrService({
    configStore: store,
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ data: [{ id: 'baidu/Unlimited-OCR' }] }) }
    }
  })

  const status = await service.status({ probe: true })
  assert.equal(status.ready, true)
  assert.equal(status.reason, '')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:8000/v1/models')
  assert.equal(requests[0].options.redirect, 'error')

  store.save({ enabled: false })
  const disabled = await service.status({ probe: true })
  assert.equal(disabled.ready, false)
  assert.match(disabled.reason, /未启用/)
  assert.equal(requests.length, 1)
})

test('request timeout still applies when the caller supplies its own abort signal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-timeout-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())
  store.save({ enabled: true })
  const caller = new AbortController()
  const service = new UnlimitedOcrService({
    configStore: store,
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(options.signal.aborted, true)
      throw new Error('request stopped')
    }
  })
  await assert.rejects(
    () => service.recognizeImages([{ data: Buffer.from('page'), mimeType: 'image/png' }], { signal: caller.signal }),
    /request stopped/
  )
  assert.equal(caller.signal.aborted, false)
})

test('multi-page parsing returns clean page-aware markdown and rejects looping output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())
  store.save({ enabled: true })
  const bodies = []
  const cleanService = new UnlimitedOcrService({
    configStore: store,
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '<|ref|>title<|/ref|><|det|>text [10,20,900,80]<|/det|>租赁合同\n<page>\n<|det|>table [20,100,900,800]<|/det|>| 月份 | 租金 |\n| 1 | 3000 |' } }]
        })
      }
    }
  })
  const parsed = await cleanService.recognizeImages([
    { data: Buffer.from('page-one'), mimeType: 'image/png' },
    { data: Buffer.from('page-two'), mimeType: 'image/png' }
  ])
  assert.equal(parsed.ok, true)
  assert.match(parsed.text, /## 第 1 页[\s\S]*租赁合同/)
  assert.match(parsed.text, /## 第 2 页[\s\S]*月份.*租金/)
  assert.doesNotMatch(parsed.text, /<\|(?:ref|det)\|>/)
  assert.equal(bodies[0].messages[0].content[0].text, '<image>Multi page parsing.')
  assert.equal(bodies[0].vllm_xargs.window_size, 1024)
  assert.equal(bodies[0].skip_special_tokens, false)

  const loopingService = new UnlimitedOcrService({
    configStore: store,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '重复内容\n'.repeat(40) } }] }) })
  })
  await assert.rejects(
    () => loopingService.recognizeImages([{ data: Buffer.from('one'), mimeType: 'image/png' }]),
    /重复|质量/
  )
})

test('PDF parsing rasterizes pages, uses advanced OCR when ready and falls back without hiding the cause', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())
  store.save({ enabled: true })
  let fallbackCalls = 0
  const service = new UnlimitedOcrService({
    configStore: store,
    rasterizePdf: async () => [Buffer.from('page-one'), Buffer.from('page-two')],
    fallbackRecognizePdf: async () => {
      fallbackCalls += 1
      return '## 第 1 页\n轻量 OCR 回退'
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'baidu/Unlimited-OCR' }] }) }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '第一页正文<page>第二页表格' } }] }) }
    }
  })
  const advanced = await service.recognizePdf('contract.pdf')
  assert.equal(advanced.engine, 'unlimited-ocr')
  assert.equal(fallbackCalls, 0)
  assert.match(advanced.text, /第二页表格/)

  const failing = new UnlimitedOcrService({
    configStore: store,
    rasterizePdf: async () => [Buffer.from('page')],
    fallbackRecognizePdf: async () => {
      fallbackCalls += 1
      return '## 第 1 页\n轻量 OCR 回退'
    },
    fetchImpl: async () => { throw new Error('GPU 服务未启动') }
  })
  const fallback = await failing.recognizePdf('contract.pdf')
  assert.equal(fallback.engine, 'fallback')
  assert.equal(fallbackCalls, 1)
  assert.match(fallback.text, /轻量 OCR 回退/)
  assert.match(fallback.warning, /GPU 服务未启动/)
})

test('a remote OCR endpoint never receives document pages without per-task cloud approval', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-remote-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new UnlimitedOcrConfigStore(root, fakeSafeStorage())
  store.save({ enabled: true, baseUrl: 'https://ocr.example.com/v1' }, { remoteApproved: true })
  let networkCalls = 0
  let fallbackCalls = 0
  const service = new UnlimitedOcrService({
    configStore: store,
    rasterizePdf: async () => [Buffer.from('private-page')],
    fallbackRecognizePdf: async () => {
      fallbackCalls += 1
      return '## 第 1 页\n本机结果'
    },
    fetchImpl: async () => {
      networkCalls += 1
      throw new Error('不应发网')
    }
  })

  const result = await service.recognizePdf('private.pdf')
  assert.equal(result.engine, 'fallback')
  assert.match(result.warning, /远端.*授权/)
  assert.equal(networkCalls, 0)
  assert.equal(fallbackCalls, 1)
})

test('image-only PDF extraction accepts the optional advanced OCR result through the existing workspace boundary', async (t) => {
  const { PDFDocument } = require('pdf-lib')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-workspace-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  const filePath = path.join(root, 'scan.pdf')
  fs.writeFileSync(filePath, await pdf.save())

  const text = await extractText(filePath, {
    recognizePdf: async () => ({ engine: 'unlimited-ocr', text: '## 第 1 页\n复杂表格结构' })
  })
  assert.match(text, /复杂表格结构/)
  assert.match(text, /高级文档 OCR/)
})

test('scan PDF text extraction is a deterministic document task and writes reviewable Markdown', async (t) => {
  const { PDFDocument } = require('pdf-lib')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-unlimited-ocr-output-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 200])
  const filePath = path.join(root, 'scan.pdf')
  fs.writeFileSync(filePath, await pdf.save())

  const instruction = '使用高级文档解析提取当前扫描 PDF 的文字并整理成 Markdown'
  assert.deepEqual(classifyTask([{ path: filePath }], instruction, 'auto'), {
    kind: 'text-extract', outputFormat: 'md', requiresAi: false, summary: '扫描文档文字提取'
  })

  let modelCalls = 0
  const service = new DocumentWorkspaceService({
    outputRoot: path.join(root, 'outputs'),
    historyRoot: path.join(root, 'history'),
    complete: async () => { modelCalls += 1; throw new Error('不应调用通用模型') },
    ocr: { recognizePdf: async () => ({ engine: 'unlimited-ocr', text: '## 第 1 页\n可核对的租赁合同正文' }) }
  })
  const result = await service.run([filePath], instruction, 'auto')
  assert.equal(result.success, true)
  assert.equal(result.plan.requiresAi, false)
  assert.equal(path.extname(result.outputs[0]), '.md')
  assert.match(fs.readFileSync(result.outputs[0], 'utf8'), /可核对的租赁合同正文/)
  assert.equal(modelCalls, 0)
})

test('main, preload and advanced settings expose the optional OCR adapter without bundling model weights', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
  const ui = fs.readFileSync(path.join(root, 'src', 'components', 'ModelCenter.tsx'), 'utf8')
  const types = fs.readFileSync(path.join(root, 'src', 'types', 'global.d.ts'), 'utf8')
  const executor = fs.readFileSync(path.join(root, 'src', 'agentToolExecutor.ts'), 'utf8')
  const documentTasks = fs.readFileSync(path.join(root, 'src', 'components', 'agent-panel', 'useDocumentAnalysisTasks.ts'), 'utf8')
  const builders = fs.readFileSync(path.join(root, 'electron-builder.lean.yml'), 'utf8') + fs.readFileSync(path.join(root, 'package.json'), 'utf8')

  assert.match(main, /new UnlimitedOcrConfigStore/)
  assert.match(main, /new UnlimitedOcrService/)
  assert.match(main, /ipcMain\.handle\('unlimitedOcr:status'/)
  assert.match(main, /ipcMain\.handle\('unlimitedOcr:save'/)
  assert.match(main, /ocrRemote/)
  assert.match(main, /ocrRoute/)
  assert.match(main, /cloudApproved:\s*task\.spec\.ocrRemote === true/)
  assert.match(preload, /unlimitedOcr:\s*\{/)
  assert.match(types, /unlimitedOcr\?:/)
  assert.match(ui, /高级文档解析 · Unlimited-OCR/)
  assert.match(ui, /客户自行部署/)
  assert.match(executor, /start_advanced_document_ocr/)
  assert.match(documentTasks, /ai-player-agent-document-task/)
  assert.doesNotMatch(builders, /model-00001-of-000001\.safetensors|Unlimited-OCR\/.*safetensors/)
})
