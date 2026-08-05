// 构建 AgentPlay 网页翻译扩展：
// esbuild 打包 content.js（含 transformers.js 浏览器版）→ extension/content.js；
// 拷贝 manifest/popup/options/background、onnxruntime-web wasm、OPUS-MT 模型（应用内组件同一份）、图标。
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'extension-src')
const outDir = path.join(root, 'extension')

function copyRecursive(source, target) {
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source)) copyRecursive(path.join(source, entry), path.join(target, entry))
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
}

// 1. 打包 content.js（浏览器环境，transformers 走 web 构建）
await build({
  entryPoints: [path.join(srcDir, 'content.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  outfile: path.join(outDir, 'content.js'),
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' }
})

// 2. 静态文件
for (const file of ['manifest.json', 'popup.html', 'popup.js', 'options.html', 'options.js', 'background.js']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file))
}

// 3. onnxruntime-web 的 wasm 资源（jsep 加载器 + wasm 本体全套）
// exports map 不含 package.json：从 transformers 包内解析 onnxruntime-web 入口再反推包目录
const transformersEntry = require.resolve('@huggingface/transformers', { paths: [root] })
const innerRequire = createRequire(transformersEntry)
const ortEntry = innerRequire.resolve('onnxruntime-web')
let ortPkgDir = path.dirname(ortEntry)
while (!fs.existsSync(path.join(ortPkgDir, 'package.json'))) ortPkgDir = path.dirname(ortPkgDir)
const ortDist = path.join(ortPkgDir, 'dist')
// 只带 jsep/jspi/asyncify 加载器与 wasm 本体（全量 dist 有 125MB 的重复 bundle 与 source map）
fs.mkdirSync(path.join(outDir, 'ort'), { recursive: true })
for (const file of fs.readdirSync(ortDist)) {
  if (!/^ort-wasm-simd-threaded\.(jsep|asyncify)?\.?(mjs|wasm)$/.test(file)) continue
  fs.copyFileSync(path.join(ortDist, file), path.join(outDir, 'ort', file))
}

// 4. OPUS-MT 模型（与应用内离线翻译组件同一份，源目录取 userData 组件位，缺则从 release 暂存位取）
const modelSources = [
  path.join(process.env.APPDATA || '', 'ai-player', 'translate-pack', 'models', 'Xenova', 'opus-mt-en-zh'),
  path.join(root, 'release', 'translate-pack', 'models', 'Xenova', 'opus-mt-en-zh')
]
const modelDir = modelSources.find((dir) => fs.existsSync(dir))
if (!modelDir) throw new Error('找不到 OPUS-MT 模型（先运行应用下载离线翻译组件，或先构建 translate-pack）')
copyRecursive(modelDir, path.join(outDir, 'models', 'Xenova', 'opus-mt-en-zh'))

// 5. 图标（极简地球标，三种尺寸，PIL 现画）
const { execFileSync } = await import('node:child_process')
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true })
const pyCode = `
from PIL import Image, ImageDraw
import sys
for size in (16, 48, 128):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([1, 1, size - 1, size - 1], fill=(37, 99, 235, 255))
    w = max(1, size // 12)
    d.arc([size // 5, size // 5, size - size // 5, size - size // 5], 200, 340, fill=(255, 255, 255, 255), width=w)
    d.line([size // 2, size // 5, size // 2, size - size // 5], fill=(255, 255, 255, 255), width=w)
    img.save(sys.argv[1] + f'/icons/{size}.png')
`
execFileSync('C:/Windows/py.exe', ['-3', '-X', 'utf8', '-c', pyCode, outDir])

const totalBytes = (dir) => fs.readdirSync(dir, { recursive: true }).reduce((sum, f) => { try { return sum + fs.statSync(path.join(dir, f)).size } catch { return sum } }, 0)
console.log(`OK extension/ 构建完成（${(totalBytes(outDir) / 1024 / 1024).toFixed(1)}MB，含模型与 wasm）`)
