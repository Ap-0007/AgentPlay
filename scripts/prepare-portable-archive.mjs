import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function cliValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}
function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

function findSevenZip(rootDir) {
  const pnpmDir = path.join(rootDir, 'node_modules', '.pnpm')
  const packages = fs.readdirSync(pnpmDir).filter((name) => name.startsWith('7zip-bin@')).sort()
  for (const packageName of packages) {
    const candidate = path.join(pnpmDir, packageName, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('找不到 electron-builder 使用的 7za.exe')
}

export function preparePortableArchive({
  rootDir = moduleRoot,
  version,
  sourceDir,
  outputPath,
  replace = false,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
    throw new Error(`版本号无效：${version || ''}`)
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  if (packageJson.version !== version) throw new Error(`package.json 版本 ${packageJson.version} 与便携包版本 ${version} 不一致`)

  const resolvedSource = path.resolve(sourceDir)
  const resolvedOutput = path.resolve(outputPath)
  if (path.extname(resolvedOutput).toLowerCase() !== '.zip') throw new Error('便携包输出必须是 .zip 文件')

  const required = [
    'AgentPlay.exe',
    'resources/app.asar',
    'resources/bin/win/mpv.com',
    'resources/legal/LICENSE',
    'resources/legal/PRIVACY.md',
  ]
  for (const relativePath of required) {
    if (!fs.existsSync(path.join(resolvedSource, ...relativePath.split('/')))) {
      throw new Error(`win-unpacked 缺少便携包必需文件：${relativePath}`)
    }
  }

  if (fs.existsSync(resolvedOutput)) {
    if (!replace) throw new Error(`便携包已存在，请使用新的输出路径或传入 --replace：${resolvedOutput}`)
    fs.rmSync(resolvedOutput, { force: true })
  }
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })

  const sevenZip = findSevenZip(rootDir)
  const packed = spawnSync(sevenZip, ['a', '-tzip', '-mx=9', resolvedOutput, '.\\*'], {
    cwd: resolvedSource,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (packed.status !== 0) throw new Error(`便携包压缩失败：${packed.stderr || packed.stdout}`)

  const listed = spawnSync(sevenZip, ['l', resolvedOutput], { encoding: 'utf8', windowsHide: true })
  if (listed.status !== 0) throw new Error(`便携包枚举失败：${listed.stderr || listed.stdout}`)
  for (const relativePath of required) {
    const archivePath = relativePath.replaceAll('/', '\\')
    if (!listed.stdout.includes(archivePath)) throw new Error(`便携包缺少必需文件：${relativePath}`)
  }
  for (const forbidden of ['Qwen2.5-0.5B-Instruct-Q4_0.gguf', 'llama-server.exe', 'bundled-ai-manifest.json']) {
    if (listed.stdout.includes(forbidden)) throw new Error(`标准便携包误带本地 AI 资源：${forbidden}`)
  }

  return {
    version,
    path: path.relative(rootDir, resolvedOutput).split(path.sep).join('/'),
    bytes: fs.statSync(resolvedOutput).size,
    sha256: sha256(resolvedOutput),
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8'))
  const version = cliValue('--version') ?? packageJson.version
  const result = preparePortableArchive({
    rootDir: moduleRoot,
    version,
    sourceDir: cliValue('--source') ?? path.join(moduleRoot, 'release', 'win-unpacked'),
    outputPath: cliValue('--output') ?? path.join(moduleRoot, 'release', `AgentPlay-${version}-Windows-x64-Portable.zip`),
    replace: process.argv.includes('--replace'),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
