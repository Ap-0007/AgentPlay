import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseSubtitleCues } = require('../electron/analysis-studio-service')
const { scoreSemanticSuiteCalibration, validateSemanticSuiteManifest } = require('../electron/semantic-suite-calibration')
const { validateCalibrationManifest } = require('../electron/semantic-edit-calibration')

const manifestArg = process.argv.find((item) => item.startsWith('--manifest='))?.slice('--manifest='.length)
if (!manifestArg) throw new Error('请提供 --manifest=A5私有标定清单路径')
const manifestPath = path.resolve(manifestArg)
const manifest = validateSemanticSuiteManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
const base = validateCalibrationManifest(JSON.parse(fs.readFileSync(path.resolve(manifest.baseManifestPath), 'utf8')))
const statePath = path.join(path.dirname(manifestPath), 'suite-calibration.state.json')
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
const detailByCategory = new Map((state.details || []).map((item) => [item.category, item]))
const baseByCategory = new Map(base.categories.map((item) => [item.category, item]))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const normalize = (value) => String(value || '').toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—-]+/g, '')
const records = []
const fileChecks = []
for (const rubric of manifest.categories) {
  const source = baseByCategory.get(rubric.category)
  for (const record of [source.source, source.positiveCase]) {
    for (const [kind, filePath, expected] of [['video', record.videoPath, record.videoSha256], ['subtitle', record.subtitlePath, record.subtitleSha256]]) {
      const actual = fs.existsSync(filePath) ? sha256(filePath) : ''
      fileChecks.push({ category: rubric.category, kind, exists: Boolean(actual), hashMatches: actual === expected })
    }
  }
  const detail = detailByCategory.get(rubric.category)
  if (!detail || detail.error) {
    records.push({ category: rubric.category, quotePassed: false, topicExpected: rubric.topic.expectedCueIndexes, topicActual: [], duplicatePassed: false, versionsPassed: false, unsafeVisualDeletion: 0, processingFailed: true, exportQuality: 0 })
    continue
  }
  const cues = parseSubtitleCues(fs.readFileSync(source.source.subtitlePath, 'utf8'), path.extname(source.source.subtitlePath)).map((cue, index) => ({ cueIndex: index + 1, text: cue.text }))
  const exactTopic = normalize(rubric.topic.query)
  const deterministic = exactTopic.length >= 3 ? cues.filter((cue) => normalize(cue.text).includes(exactTopic)).map((cue) => cue.cueIndex) : []
  const topicActual = deterministic.length ? deterministic : (detail.topic?.selectedCueIndexes || [])
  const actualAnchors = new Set((detail.reviewed?.highlights || []).flatMap((item) => Array.from({ length: item.endCueIndex - item.startCueIndex + 1 }, (_, index) => item.startCueIndex + index)))
  const anchorHits = rubric.versions.anchorCueIndexes.filter((item) => actualAnchors.has(item)).length
  const exported = detail.exported || []
  const exportQuality = exported.length ? Math.min(...exported.map((item) => fs.existsSync(item.outputPath) ? Number(item.quality) || 0 : 0)) : 0
  records.push({
    category: rubric.category,
    quotePassed: detail.quoteDecision?.semanticLocate?.cueIndex === rubric.quote.expectedCueIndex,
    topicExpected: rubric.topic.expectedCueIndexes, topicActual,
    duplicatePassed: Boolean(detail.visualDuplicate || detail.subtitleDuplicate),
    versionsPassed: detail.reviewed?.chapters?.[0]?.startCueIndex === 1 && detail.reviewed?.chapters?.at(-1)?.endCueIndex === cues.length && anchorHits >= Math.ceil(rubric.versions.anchorCueIndexes.length * 0.5) && exported.length >= rubric.versions.requiredExports && exportQuality >= 95,
    unsafeVisualDeletion: Number(detail.record?.unsafeVisualDeletion || 0), processingFailed: false, exportQuality
  })
}
const score = scoreSemanticSuiteCalibration(records)
const passed = score.passed && fileChecks.every((item) => item.exists && item.hashMatches)
const completedAt = new Date().toISOString()
const resultPath = path.join(path.dirname(manifestPath), 'suite-calibration-final.private.json')
const receiptPath = path.join(path.dirname(manifestPath), 'suite-calibration-final.receipt.json')
fs.writeFileSync(resultPath, `${JSON.stringify({ schemaVersion: 1, completedAt, model: state.model, score: { ...score, passed }, records, details: state.details }, null, 2)}\n`, 'utf8')
fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, checkedAt: completedAt, passed, score: { ...score, passed }, categories: manifest.categories.map((item) => item.category), fileChecks, privateResultSha256: sha256(resultPath) }, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ passed, score: { ...score, passed }, resultPath, receiptPath })}\n`)
if (!passed) process.exitCode = 1
