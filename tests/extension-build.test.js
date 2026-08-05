const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ext = (...parts) => path.join(__dirname, '..', 'extension', ...parts)
const extBuilt = fs.existsSync(ext('manifest.json'))

test('extension build: manifest valid, all parts present, models complete', (t) => {
  if (!extBuilt) {
    t.skip('扩展构建产物不存在（CI 不出包；本机跑 scripts/build-extension.mjs 后此用例生效）')
    return
  }
  const manifest = JSON.parse(fs.readFileSync(ext('manifest.json'), 'utf8'))
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.background.service_worker, 'background.js')
  assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/)
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js'])

  for (const file of ['content.js', 'background.js', 'popup.html', 'popup.js', 'options.html', 'options.js']) {
    assert.ok(fs.statSync(ext(file)).size > 100, `缺 ${file}`)
  }
  // wasm 加载器与本体
  for (const file of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    assert.ok(fs.statSync(ext('ort', file)).size > 10000, `缺 ort/${file}`)
  }
  // OPUS-MT 全套（与应用内离线组件同构）
  const modelRoot = ext('models', 'Xenova', 'opus-mt-en-zh')
  for (const file of ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    assert.ok(fs.statSync(path.join(modelRoot, file)).size > 50, `缺模型 ${file}`)
  }
  for (const file of ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx']) {
    assert.ok(fs.statSync(path.join(modelRoot, 'onnx', file)).size > 10 * 1024 * 1024, `缺模型 ${file}`)
  }
  // content bundle 含 transformers 与双轨逻辑
  const bundle = fs.readFileSync(ext('content.js'), 'utf8')
  assert.ok(bundle.length > 500000, 'content.js 应是打包后的完整 bundle')
  assert.match(bundle, /opus-mt-en-zh/)
  assert.match(bundle, /ap-cloud-translate/)
  assert.match(bundle, /ap-translation-block/)
  // 云端走 background 中转（页面 CORS 不挡）
  const bg = fs.readFileSync(ext('background.js'), 'utf8')
  assert.match(bg, /chat\/completions/)
  assert.match(bg, /chrome\.storage\.local\.get/)
  for (const size of [16, 48, 128]) assert.ok(fs.statSync(ext('icons', `${size}.png`)).size > 100, `缺图标 ${size}`)
})

test('extension source: honest offline degradation, page restore wired, no eval in content', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension-src', 'content.js'), 'utf8')
  assert.match(src, /翻译中断/, '离线失败必须如实显示')
  assert.match(src, /restorePage/)
  assert.match(src, /ap-restore/)
  assert.ok(!/\beval\(/.test(src), 'content script 不得用 eval（CSP 红线）')
  assert.match(src, /allowRemoteModels = false/, '离线引擎禁止联网拉模型')
})
