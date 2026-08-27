import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { AgentEngine } = require('../electron/llm-service')
const { parseSubtitleCues } = require('../electron/analysis-studio-service')
const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { MediaAutoInspection } = require('../electron/media-auto-inspection')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { buildAutoInspectionDecision, buildExactQuoteStartDecision, analyzeTextCleanupCues, parseSilenceEvents } = require('../electron/semantic-edit-service')
const { reviewTopicSelection } = require('../electron/semantic-transcript-review')
const { compileLongVideoVersionBundle, planLongVideoVersions } = require('../electron/long-video-version-service')
const { scoreSemanticSuiteCalibration, validateSemanticSuiteManifest } = require('../electron/semantic-suite-calibration')
const { validateCalibrationManifest } = require('../electron/semantic-edit-calibration')
const { normalizeConfig } = require('../electron/model-providers')

const manifestArg = process.argv.find((item) => item.startsWith('--manifest='))?.slice('--manifest='.length)
if (!manifestArg) throw new Error('请提供 --manifest=A5私有标定清单路径')
if (!process.argv.includes('--allow-cloud-calibration=yes')) throw new Error('A5云端标定未获显式允许')
if (!process.env.AGNES_API_KEY) throw new Error('AGNES_API_KEY 未配置')
const manifestPath = path.resolve(manifestArg)
const manifest = validateSemanticSuiteManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
const base = validateCalibrationManifest(JSON.parse(fs.readFileSync(path.resolve(manifest.baseManifestPath), 'utf8')))
const baseByCategory = new Map(base.categories.map((item) => [item.category, item]))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
for (const item of base.categories) {
  for (const record of [item.source, item.positiveCase]) {
    if (sha256(record.videoPath) !== record.videoSha256 || sha256(record.subtitlePath) !== record.subtitleSha256) throw new Error(`${item.category}私有语料哈希不一致`)
  }
}

const config = normalizeConfig({ providerId: 'agnes', model: 'agnes-2.5-flash', apiKey: process.env.AGNES_API_KEY }, 'chat')
const model = { providerId: config.providerId, providerName: config.providerName, model: config.model, local: false }
const engine = new AgentEngine(null)
const ffmpegDir = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const frames = new VideoFrameService({ ffmpegPath: path.join(ffmpegDir, 'ffmpeg.exe'), ffprobePath: path.join(ffmpegDir, 'ffprobe.exe') })
if (!frames.availability().available) throw new Error('缺少本机ffmpeg')
const inspection = new MediaAutoInspection({ frames })
const editor = new MediaEditService({ frames })
const outputRoot = path.join(path.dirname(manifestPath), 'a5-outputs')
fs.mkdirSync(outputRoot, { recursive: true })
const statePath = path.join(path.dirname(manifestPath), 'suite-calibration.state.json')
const resultPath = path.join(path.dirname(manifestPath), 'suite-calibration.private.json')
const manifestSha256 = sha256(manifestPath)
let state = { schemaVersion: 1, algorithmVersion: 5, manifestSha256, model, records: [], details: [] }
try { const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (saved.algorithmVersion === 5 && saved.manifestSha256 === manifestSha256 && saved.model?.model === model.model) state = saved } catch {}
const save = () => { const temp = `${statePath}.tmp`; fs.writeFileSync(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8'); try { fs.renameSync(temp, statePath) } catch { fs.copyFileSync(temp, statePath); fs.rmSync(temp, { force: true }) } }
let modelCalls = 0
const completeText = async (input) => {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { modelCalls += 1; return await engine.completeText([{ role: 'user', content: input.prompt }], config, { systemPrompt: input.systemPrompt, timeoutMs: input.timeoutMs, maxTokens: input.maxTokens }) } catch (error) {
      lastError = error
      if (!/模型没有返回内容|fetch failed|network|timeout|econn|socket/i.test(String(error?.message || error)) || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }
  throw lastError
}
const readCues = (subtitlePath) => parseSubtitleCues(fs.readFileSync(subtitlePath, 'utf8'), path.extname(subtitlePath)).map((cue, index) => ({ cueIndex: index + 1, startSeconds: cue.start, endSeconds: cue.end, text: cue.text }))
const buildDecision = (sourcePath, entry, plan) => {
  const raw = entry.segments || [{ sourceStartSeconds: entry.sourceStartSeconds, sourceEndSeconds: entry.sourceEndSeconds, durationSeconds: entry.durationSeconds }]
  const common = { schemaVersion: 1, instruction: plan.instruction, source: { path: sourcePath, name: path.basename(sourcePath) }, output: { container: 'mp4', overwrite: false, suffix: entry.label }, verification: { toleranceSeconds: Math.max(0.25, Number(entry.durationSeconds || entry.targetSeconds || 0) * 0.03), semanticEvidence: { strategy: plan.strategy, id: entry.id, model: plan.model } } }
  if (raw.length === 1) return attachEditDecisionList({ ...common, kind: 'media.trim', timeline: { startSeconds: raw[0].sourceStartSeconds, endSeconds: raw[0].sourceEndSeconds, durationSeconds: Number((raw[0].sourceEndSeconds - raw[0].sourceStartSeconds).toFixed(3)) } })
  let cursor = 0; const segments = raw.map((item) => { const durationSeconds = Number((item.sourceEndSeconds - item.sourceStartSeconds).toFixed(3)); const segment = { sourceStartSeconds: item.sourceStartSeconds, sourceEndSeconds: item.sourceEndSeconds, durationSeconds, targetStartSeconds: Number(cursor.toFixed(3)), targetEndSeconds: Number((cursor + durationSeconds).toFixed(3)) }; cursor += durationSeconds; return segment })
  return attachEditDecisionList({ ...common, kind: 'media.concat-segments', timeline: { segments, durationSeconds: Number(cursor.toFixed(3)) } })
}
const exportEntry = async (category, sourcePath, entry, plan, index) => {
  const decision = buildDecision(sourcePath, entry, plan)
  const decisionHash = crypto.createHash('sha256').update(JSON.stringify(decision)).digest('hex').slice(0, 12)
  const outputPath = path.join(outputRoot, `${category}-${index + 1}-${entry.id}-${decisionHash}.mp4`)
  const result = fs.existsSync(outputPath) ? await editor.verify({ sourcePath, outputPath, decision }) : decision.kind === 'media.trim' ? await editor.trim({ sourcePath, outputPath, decision }) : await editor.concatSegments({ sourcePath, outputPath, decision })
  const durationOk = Math.abs(Number(result.durationSeconds) - Number(decision.timeline.durationSeconds)) <= 0.25
  const frameOk = result.frameProof?.verdict === 'matched' || result.frameProof?.verdict === 'inconclusive'
  return { outputPath, durationSeconds: result.durationSeconds, expectedDurationSeconds: decision.timeline.durationSeconds, quality: durationOk && frameOk ? 100 : 0, frameProof: result.frameProof }
}

for (const rubric of manifest.categories) {
  if (state.records.some((item) => item.category === rubric.category && !item.processingFailed)) { process.stdout.write(`SKIP ${rubric.category} checkpoint\n`); continue }
  const source = baseByCategory.get(rubric.category)
  const cues = readCues(source.source.subtitlePath)
  const positiveCues = readCues(source.positiveCase.subtitlePath)
  const durationSeconds = await frames.probeDuration(source.source.videoPath)
  const beforeHash = sha256(source.source.videoPath)
  const callStart = modelCalls
  const detail = { category: rubric.category, durationSeconds, cueCount: cues.length }
  let record
  try {
    const quoteDecision = buildExactQuoteStartDecision({ instruction: `从他说到“${rubric.quote.query}”开始`, sourcePath: source.source.videoPath, subtitlePath: source.source.subtitlePath, durationSeconds, cues })
    const quotePassed = quoteDecision.semanticLocate.cueIndex === rubric.quote.expectedCueIndex && Math.abs(quoteDecision.timeline.startSeconds - cues[rubric.quote.expectedCueIndex - 1].startSeconds) <= 0.05
    const topic = await reviewTopicSelection({ cues, requestedTopic: rubric.topic.query, model, complete: completeText })
    const topicActual = topic.selectedCueIndexes || []
    const positiveDuration = await frames.probeDuration(source.positiveCase.videoPath)
    const [sourceVisual, positiveVisual] = await Promise.all([
      inspection.inspect({ sourcePath: source.source.videoPath, durationSeconds }),
      inspection.inspect({ sourcePath: source.positiveCase.videoPath, durationSeconds: positiveDuration })
    ])
    const insertedCue = positiveCues[Number(source.positiveCase.insertedCueIndex) - 1]
    const positiveTextAnalysis = analyzeTextCleanupCues(positiveCues, positiveDuration)
    const subtitleDuplicate = positiveTextAnalysis.detected.some((item) => Number(item.cueIndex) === Number(source.positiveCase.insertedCueIndex) && /重复/.test(String(item.reason || '')))
    const visualDuplicate = positiveVisual.duplicateRanges.some((item) => !insertedCue || item.endSeconds > insertedCue.startSeconds - 1.5 && item.startSeconds < insertedCue.endSeconds + 1.5)
    const duplicatePassed = !rubric.inspection.expectDerivedDuplicate || visualDuplicate || subtitleDuplicate
    let unsafeVisualDeletion = 0
    try {
      const hasAudio = await frames.probeHasAudio(source.source.videoPath)
      let silences = []
      if (hasAudio) { const scan = await frames.run(['-hide_banner', '-nostats', '-i', source.source.videoPath, '-map', '0:a:0', '-af', 'silencedetect=noise=-35dB:d=0.900', '-f', 'null', '-'], { timeoutMs: 180000 }); silences = parseSilenceEvents(scan.stderr) }
      const autoDecision = buildAutoInspectionDecision({ instruction: '自动检查视频并给剪辑方案', sourcePath: source.source.videoPath, subtitlePath: source.source.subtitlePath, durationSeconds, silences, textAnalysis: analyzeTextCleanupCues(cues, durationSeconds), visual: sourceVisual })
      unsafeVisualDeletion = autoDecision.autoInspection.safeRemovals.filter((item) => item.kinds.includes('blur') || item.kinds.includes('duplicate-shot')).length
    } catch { /* 没有安全删除项也属于有效负样本 */ }
    const reviewed = await planLongVideoVersions({ cues, model, complete: completeText })
    const versionPlan = compileLongVideoVersionBundle({ instruction: '生成短版精华版章节版和平台版', sourcePath: source.source.videoPath, subtitlePath: source.source.subtitlePath, durationSeconds, cues, reviewed })
    const actualAnchors = new Set(reviewed.highlights.flatMap((item) => Array.from({ length: item.endCueIndex - item.startCueIndex + 1 }, (_, index) => item.startCueIndex + index)))
    const anchorHits = rubric.versions.anchorCueIndexes.filter((item) => actualAnchors.has(item)).length
    const exports = [versionPlan.variants[0], versionPlan.chapters[0]].slice(0, rubric.versions.requiredExports)
    const exported = []
    for (let index = 0; index < exports.length; index += 1) exported.push(await exportEntry(rubric.category, source.source.videoPath, exports[index], versionPlan, index))
    const exportQuality = Math.min(...exported.map((item) => item.quality))
    const versionsPassed = reviewed.chapters[0].startCueIndex === 1 && reviewed.chapters.at(-1).endCueIndex === cues.length && anchorHits >= Math.ceil(rubric.versions.anchorCueIndexes.length * 0.5) && exported.length >= rubric.versions.requiredExports && exportQuality >= 95
    record = { category: rubric.category, quotePassed, topicExpected: rubric.topic.expectedCueIndexes, topicActual, duplicatePassed, versionsPassed, unsafeVisualDeletion, processingFailed: false, exportQuality, modelCalls: modelCalls - callStart }
    Object.assign(detail, { quoteDecision, topic, sourceVisual, positiveVisual, positiveTextAnalysis, insertedCue, visualDuplicate, subtitleDuplicate, reviewed, versionPlan, exported, anchorHits, record })
  } catch (error) {
    record = { category: rubric.category, quotePassed: false, topicExpected: rubric.topic.expectedCueIndexes, topicActual: [], duplicatePassed: false, versionsPassed: false, unsafeVisualDeletion: 0, processingFailed: true, exportQuality: 0, modelCalls: modelCalls - callStart, error: error instanceof Error ? error.message : String(error) }
    Object.assign(detail, { error: record.error, record })
  }
  if (sha256(source.source.videoPath) !== beforeHash) throw new Error(`${rubric.category}标定改变了源视频`)
  state.records = state.records.filter((item) => item.category !== rubric.category).concat(record)
  state.details = state.details.filter((item) => item.category !== rubric.category).concat(detail)
  save()
  process.stdout.write(`${rubric.category} ${JSON.stringify(record)}\n`)
}

const score = scoreSemanticSuiteCalibration(state.records)
fs.writeFileSync(resultPath, `${JSON.stringify({ schemaVersion: 1, completedAt: new Date().toISOString(), model, score, records: state.records, details: state.details }, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ model, score, resultPath, statePath, outputRoot })}\n`)
if (!score.passed) process.exitCode = 1
