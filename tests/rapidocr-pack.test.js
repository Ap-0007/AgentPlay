const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
const modelCenter = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ModelCenter.tsx'), 'utf8')
const RAPIDOCR_PACK = require('../electron/rapidocr-pack-manifest.js')
const { RapidOcrService } = require('../electron/rapidocr-service.js')

test('rapidocr pack manifest matches staged assets byte for byte', (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'release', 'rapidocr-pack'))) {
    t.skip('组件包暂存目录不存在（CI 不出包）')
    return
  }
  assert.equal(RAPIDOCR_PACK.tag, 'rapidocr-pack-v1')
  assert.equal(RAPIDOCR_PACK.assets.length, 4)
  for (const asset of RAPIDOCR_PACK.assets) {
    assert.match(asset.url, /^https:\/\/github\.com\/wg5759\/AgentPlay\/releases\/download\/rapidocr-pack-v1\//)
    const staged = path.join(__dirname, '..', 'release', 'rapidocr-pack', asset.url.split('/').pop())
    assert.ok(fs.existsSync(staged), `缺少暂存资产 ${staged}`)
    assert.equal(fs.statSync(staged).size, asset.size, asset.id)
    const hash = crypto.createHash('sha256').update(fs.readFileSync(staged)).digest('hex')
    assert.equal(hash, asset.sha256, asset.id)
  }
})

test('rapidocr wired: download service, IPC trio, preload, model center card, OCR chain preference', () => {
  assert.match(main, /RAPIDOCR_PACK = require\('\.\/rapidocr-pack-manifest'\)/)
  assert.match(main, /rapidocrDownload = new LocalAiDownloadService/)
  assert.match(main, /ipcMain\.handle\('rapidocrPack:status'/)
  assert.match(main, /ipcMain\.handle\('rapidocrPack:download'/)
  assert.match(main, /ipcMain\.handle\('rapidocrPack:cancel-download'/)
  assert.match(preload, /rapidocrPack: \{/)
  assert.match(modelCenter, /高精度 OCR 组件 · PP-OCRv4 中文识别/)
  assert.match(modelCenter, /startRapidocrDownload/)
  // 扫描件 OCR 链路：高精度组件在位优先，WinRT 系统 OCR 兜底
  assert.match(main, /useRapid = rapidOcr\.availability\(\)\.available/)
  assert.match(main, /useRapid \? await rapidOcr\.recognize/)
})

test('availability reports missing files honestly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidocr-missing-'))
  try {
    const service = new RapidOcrService({ modelRoot: dir })
    const status = service.availability()
    assert.equal(status.available, false)
    assert.equal(status.missing.length, 3)
    assert.match(status.reason, /高精度 OCR 组件未安装/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('real PP-OCRv4 model recognizes Chinese text from image offline', { timeout: 180000 }, async (t) => {
  // 模型来自 npm 依赖 @gutenye/ocr-models（与组件包同一份）；CI 有 pnpm store 即可跑
  const ocrNodeEntry = require.resolve('@gutenye/ocr-node')
  let scopeDir = path.dirname(ocrNodeEntry)
  while (path.basename(scopeDir) !== '@gutenye') scopeDir = path.dirname(scopeDir)
  const assetsDir = path.join(scopeDir, 'ocr-models', 'assets')
  if (!fs.existsSync(path.join(assetsDir, 'ch_PP-OCRv4_rec_infer.onnx'))) {
    t.skip('@gutenye/ocr-models 资产缺失')
    return
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidocr-real-'))
  try {
    const modelsDir = path.join(dir, 'models')
    fs.mkdirSync(modelsDir, { recursive: true })
    for (const file of ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt']) {
      fs.copyFileSync(path.join(assetsDir, file), path.join(modelsDir, file))
    }
    const service = new RapidOcrService({ modelRoot: dir })
    assert.equal(service.availability().available, true)
    const fixture = path.join(__dirname, 'fixtures', 'ocr-sample.png')
    assert.ok(fs.existsSync(fixture), '缺少 OCR 测试图 tests/fixtures/ocr-sample.png')
    const results = await service.recognize([fixture])
    const entry = results.get(fixture)
    assert.ok(entry?.ok, entry?.error || '识别失败')
    assert.ok(entry.text.includes('高精度'), `应识别出"高精度"，实际：${entry.text}`)
    assert.ok(entry.text.includes('扫描件'), `应识别出"扫描件"，实际：${entry.text}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
