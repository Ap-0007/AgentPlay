import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { AgentEngine } = require('../electron/llm-service')
const { parseSubtitleCues } = require('../electron/analysis-studio-service')
const { candidateKey, scoreSemanticCalibration, validateCalibrationManifest } = require('../electron/semantic-edit-calibration')
const { reviewSemanticTranscript } = require('../electron/semantic-transcript-review')
const { reviewSemanticCandidateVisuals } = require('../electron/semantic-visual-review')
const { VideoFrameService } = require('../electron/video-frame-service')
const { normalizeConfig } = require('../electron/model-providers')

const manifestArg = process.argv.find((item) => item.startsWith('--manifest='))?.slice('--manifest='.length)
const allowed = process.argv.includes('--allow-cloud-calibration=yes')
if (!manifestArg) throw new Error('请提供 --manifest=私有标定清单路径')
if (!allowed) throw new Error('云端标定未获显式允许；需要 --allow-cloud-calibration=yes')
if (!process.env.AGNES_API_KEY) throw new Error('AGNES_API_KEY 未配置')
const manifestPath = path.resolve(manifestArg)
const manifest = validateCalibrationManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
const textConfig = normalizeConfig({ providerId: 'agnes', model: 'agnes-2.5-flash', apiKey: process.env.AGNES_API_KEY }, 'chat')
const visionConfig = normalizeConfig({ providerId: 'agnes', model: 'agnes-2.5-flash', apiKey: process.env.AGNES_API_KEY }, 'chat')
const CALIBRATION_ALGORITHM_VERSION = 5
const textModel = { providerId: textConfig.providerId, providerName: textConfig.providerName, model: textConfig.model, local: false }
const visionModel = { providerId: visionConfig.providerId, providerName: visionConfig.providerName, model: visionConfig.model, local: false }
const engine = new AgentEngine(null)
const ffmpegDir = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const frames = new VideoFrameService({ ffmpegPath: path.join(ffmpegDir, 'ffmpeg.exe'), ffprobePath: path.join(ffmpegDir, 'ffprobe.exe') })
if (!frames.availability().available) throw new Error('缺少本机ffmpeg，不能执行镜头交叉标定')
const statePath = path.join(path.dirname(manifestPath), 'model-calibration.state.json')
const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')
let state = { schemaVersion: 1, algorithmVersion: CALIBRATION_ALGORITHM_VERSION, manifestSha256, textModel, visionModel, records: [], details: [] }
try {
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  if (saved.manifestSha256 === manifestSha256 && saved.textModel?.model === textModel.model && saved.visionModel?.model === visionModel.model) {
    if (saved.algorithmVersion === CALIBRATION_ALGORITHM_VERSION) state = saved
    else {
      const passingKeys = new Set((saved.details || []).filter((item) => {
        const expected = new Set((item.expected || []).map(candidateKey)); const actual = new Set((item.actual || []).map(candidateKey))
        return !item.semanticError && !item.visualError && expected.size === actual.size && [...expected].every((key) => actual.has(key)) && (item.actual || []).every((candidate) => candidate.humanApproved === true)
      }).map((item) => `${item.category}/${item.caseKind}`))
      state = { schemaVersion: 1, algorithmVersion: CALIBRATION_ALGORITHM_VERSION, manifestSha256, textModel, visionModel, records: (saved.records || []).filter((item) => passingKeys.has(`${item.category}/${item.caseKind}`)), details: (saved.details || []).filter((item) => passingKeys.has(`${item.category}/${item.caseKind}`)) }
    }
  }
} catch { /* 首次运行 */ }
const records = state.records
const details = state.details
const saveState = () => { const temporary = `${statePath}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8'); try { fs.renameSync(temporary, statePath) } catch { fs.copyFileSync(temporary, statePath); fs.unlinkSync(temporary) } }
let lastTextResponse = ''
const completeText = async (input) => {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { const result = await engine.completeText([{ role: 'user', content: input.prompt }], textConfig, { systemPrompt: input.systemPrompt, timeoutMs: input.timeoutMs, maxTokens: input.maxTokens }); lastTextResponse = String(result?.text || ''); return result } catch (error) {
      lastError = error
      if (!/模型没有返回内容/.test(String(error?.message || error)) || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  throw lastError
}

async function runCase(category, caseKind, videoPath, subtitlePath, expected) {
  const key = `${category}/${caseKind}`
  if (details.some((item) => `${item.category}/${item.caseKind}` === key)) { process.stdout.write(`SKIP ${key} checkpoint\n`); return }
  const durationSeconds = await frames.probeDuration(videoPath)
  const cues = parseSubtitleCues(fs.readFileSync(subtitlePath, 'utf8'), path.extname(subtitlePath)).map((cue, index) => ({ cueIndex: index + 1, startSeconds: cue.start, endSeconds: cue.end, text: cue.text }))
  process.stdout.write(`CALIBRATE ${category}/${caseKind} cues=${cues.length}\n`)
  lastTextResponse = ''
  let semantic
  let semanticError = ''
  try { semantic = await reviewSemanticTranscript({ cues, model: textModel, complete: completeText }) } catch (error) {
    semanticError = error instanceof Error ? error.message : String(error)
    semantic = { available: false, topicSummary: '', candidates: [], model: textModel }
  }
  let visual = { available: true, validations: [], safeCandidateIndexes: [], blockedCandidateIndexes: [] }
  let visualError = ''
  if (semantic.candidates.length) {
    try {
      visual = await reviewSemanticCandidateVisuals({
        sourcePath: videoPath, cues, review: semantic, durationSeconds, model: visionModel,
        readFrame: (filePath, seconds, options) => frames.readJpegFrame(filePath, seconds, options),
        completeVisionMulti: (input) => engine.completeVisionMulti({ prompt: input.prompt, systemPrompt: input.systemPrompt, imageDataUrls: input.images.map((item) => item.dataUrl), labels: input.images.map((item) => item.label), apiKey: visionConfig, timeoutMs: input.timeoutMs, maxTokens: input.maxTokens })
      })
    } catch (error) {
      visualError = error instanceof Error ? error.message : String(error)
      visual = { available: false, validations: [], safeCandidateIndexes: [], blockedCandidateIndexes: semantic.candidates.map((_, index) => index + 1) }
    }
  }
  const safe = new Set(visual.safeCandidateIndexes || [])
  const expectedKeys = new Set((expected || []).map(candidateKey))
  const actual = semantic.candidates.filter((_, index) => safe.has(index + 1)).map((candidate) => {
    const result = { type: candidate.type, removeCueIndexes: candidate.removeCueIndexes, visualVerdict: 'safe' }
    return { ...result, humanApproved: expectedKeys.has(candidateKey(result)) }
  })
  records.push({ category, caseKind, expected, actual, processingFailed: Boolean(semanticError || visualError) })
  details.push({ category, caseKind, durationSeconds, cueCount: cues.length, semantic, semanticError, rawTextResponse: lastTextResponse, visual, visualError, expected, actual })
  saveState()
}

for (const item of manifest.categories) {
  await runCase(item.category, 'negative', item.source.videoPath, item.source.subtitlePath, [])
  await runCase(item.category, 'positive', item.positiveCase.videoPath, item.positiveCase.subtitlePath, item.positiveCase.expected)
}
const score = scoreSemanticCalibration(records)
const resultPath = path.join(path.dirname(manifestPath), 'model-calibration.private.json')
fs.writeFileSync(resultPath, `${JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), textModel, visionModel, score, records, details }, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ textModel, visionModel, score, resultPath, statePath })}\n`)
if (!score.passed) process.exitCode = 1
