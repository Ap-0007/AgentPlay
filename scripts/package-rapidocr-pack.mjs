// 构建"高精度 OCR 组件包"：PP-OCRv4 det/rec/cls ONNX 模型 + 字典（源自 MIT 许可的 @gutenye/ocr-models），
// 输出到 release/rapidocr-pack/ 并生成应用内置清单 electron/rapidocr-pack-manifest.js（含真实 SHA-256）。
// GitHub Release 资产名不能带路径，统一扁平命名（文件名本身已唯一）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// pnpm 布局：ocr-models 与 ocr-node 是 @gutenye 作用域下的同级包（纯资产包，无可解析入口）
const ocrNodeEntry = require.resolve('@gutenye/ocr-node', { paths: [root] })
let scopeDir = path.dirname(ocrNodeEntry)
while (path.basename(scopeDir) !== '@gutenye') scopeDir = path.dirname(scopeDir)
const assetsDir = path.join(scopeDir, 'ocr-models', 'assets')
const outDir = path.join(root, 'release', 'rapidocr-pack')
const TAG = 'rapidocr-pack-v1'
const BASE_URL = `https://github.com/wg5759/AgentPlay/releases/download/${TAG}`
const FILES = [
  { name: 'ch_PP-OCRv4_det_infer.onnx', role: 'model', label: 'PP-OCRv4 文字检测模型' },
  { name: 'ch_PP-OCRv4_rec_infer.onnx', role: 'model', label: 'PP-OCRv4 中文识别模型' },
  { name: 'ch_ppocr_mobile_v2.0_cls_infer.onnx', role: 'model', label: '方向分类模型' },
  { name: 'ppocr_keys_v1.txt', role: 'config', label: '识别字典（6623 字）' }
]

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

if (!fs.existsSync(assetsDir)) throw new Error(`缺少模型源目录（先 pnpm install）: ${assetsDir}`)
fs.mkdirSync(outDir, { recursive: true })

const assets = []
for (const file of FILES) {
  const source = path.join(assetsDir, file.name)
  if (!fs.existsSync(source)) throw new Error(`缺少组件包源文件: ${source}`)
  const staged = path.join(outDir, file.name)
  fs.copyFileSync(source, staged)
  assets.push({
    id: file.name.replace(/\W+/g, '-').replace(/^-|-$/g, ''),
    kind: 'file',
    label: file.label,
    path: `models/${file.name}`,
    role: file.role,
    url: `${BASE_URL}/${file.name}`,
    size: fs.statSync(staged).size,
    sha256: sha256File(staged)
  })
}

const manifest = {
  schemaVersion: 1,
  tag: TAG,
  product: 'AgentPlay 高精度 OCR 组件（PP-OCRv4 中文，onnxruntime）',
  assets
}
const banner = '// 本文件由 scripts/package-rapidocr-pack.mjs 生成，请勿手改。\n// 组件包托管在 GitHub Release 的 rapidocr-pack-v1 标签；SHA-256 与发布资产一一对应。\n'
fs.writeFileSync(path.join(root, 'electron', 'rapidocr-pack-manifest.js'), `${banner}module.exports = ${JSON.stringify(manifest, null, 2)}\n`)
console.log(`OK: ${assets.length} 个资产，共 ${(assets.reduce((sum, a) => sum + a.size, 0) / 1024 / 1024).toFixed(1)}MB`)
