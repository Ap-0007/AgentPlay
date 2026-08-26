import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const delegated = path.join(root, 'scripts', 'smoke-packaged-media-music.mjs')
const delegatedReceipt = path.join(root, 'artifacts', 'acceptance', 'media-music-packaged', 'receipt.json')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'audio-export-c5-packaged')

async function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) }); child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`配乐安装态验收退出码${code}：${stderr.slice(-1600)}`)))
  })
}

if (!fs.existsSync(executable)) throw new Error(`缺少待验收EXE：${executable}`)
await run(process.execPath, [delegated, `--exe=${executable}`])
if (!fs.existsSync(delegatedReceipt)) throw new Error('C5没有取得配乐安装态回执')
const base = JSON.parse(fs.readFileSync(delegatedReceipt, 'utf8'))
const task = base.pageResult?.task
const qc = task?.result?.audioExportQc
const required = {
  schema: qc?.schemaVersion === 1 && qc?.method === 'unified-audio-export-qc-v1' && qc?.verdict === 'matched',
  clipping: qc?.clipping?.verdict === 'matched',
  loudness: qc?.loudness?.verdict === 'matched',
  avSync: qc?.avSync?.verdict === 'matched',
  silence: String(qc?.silence?.verdict || '').startsWith('matched'),
  copyright: qc?.copyright?.verdict === 'documented' && Array.isArray(qc?.copyright?.sources) && qc.copyright.sources.length > 0,
  quality100: task?.quality?.score === 100 && task?.quality?.checks?.some((item) => item.id === 'unified-audio-qc' && item.passed),
  sourceHashesUnchanged: JSON.stringify(base.sourceBefore) === JSON.stringify(base.sourceAfter) && JSON.stringify(base.musicBefore) === JSON.stringify(base.musicAfter),
  receiptAbsolutePathOmitted: qc?.copyright?.sources?.every((item) => !('path' in item) && !('outputPath' in item))
}
const failed = Object.entries(required).filter(([, passed]) => !passed).map(([name]) => name)
if (failed.length) throw new Error(`C5安装态统一声音导出证据不完整：${failed.join('、')}`)
fs.mkdirSync(evidenceDir, { recursive: true })
const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, required, audioExportQc: qc, delegatedReceipt }
const receiptPath = path.join(evidenceDir, 'receipt.json')
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, required, audioExportQc: qc }, null, 2)}\n`)
