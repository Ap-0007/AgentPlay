import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { validateCalibrationManifest } = require('../electron/semantic-edit-calibration')
const manifestArg = process.argv.find((item) => item.startsWith('--manifest='))?.slice('--manifest='.length)
if (!manifestArg) throw new Error('请提供 --manifest=私有标定清单路径')
const manifestPath = path.resolve(manifestArg)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const validated = validateCalibrationManifest(manifest)
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const checks = []
for (const item of validated.categories) {
  for (const [caseKind, record] of [['source', item.source], ['positive', item.positiveCase]]) {
    for (const [kind, filePath, expected] of [['video', record.videoPath, record.videoSha256], ['subtitle', record.subtitlePath, record.subtitleSha256]]) {
      const resolved = path.resolve(filePath)
      const actual = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? sha256(resolved) : ''
      checks.push({ category: item.category, caseKind, kind, exists: Boolean(actual), hashMatches: actual === expected })
    }
  }
}
const passed = checks.every((item) => item.exists && item.hashMatches)
const receipt = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed, caseCount: validated.caseCount, categories: validated.categories.map((item) => item.category), checks }
const receiptPath = path.join(path.dirname(manifestPath), 'corpus-readiness.receipt.json')
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ passed, caseCount: receipt.caseCount, categories: receipt.categories, receiptPath })}\n`)
if (!passed) process.exitCode = 1
