const fs = require('fs')
const path = require('path')
const { fingerprintArtifact } = require('./artifact-fingerprint')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'])
const OFFICE_ZIP_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub'])
const HARD_FAILURES = new Set([
  'RESULT_FAILED', 'ARTIFACT_MISSING', 'ARTIFACT_EMPTY', 'INVALID_FORMAT', 'SUBTITLE_EMPTY',
  'TARGET_LANGUAGE_MISSING', 'PARTIAL_BATCH', 'NO_BATCH_RESULTS', 'DURATION_MISMATCH', 'SEGMENT_RECEIPT_INCOMPLETE', 'PROJECT_CAPSULE_MISSING',
  'FRAME_PROOF_MISSING', 'FRAME_PROOF_UNAVAILABLE', 'FRAME_PROOF_INCOMPLETE', 'FRAME_BOUNDARY_MISMATCH',
  'EFFECT_RECEIPT_MISMATCH', 'EFFECT_CHANGE_MISSING', 'DIMENSION_MISMATCH',
  'REFRAME_OUTPUT_MISMATCH', 'TRACKING_EVIDENCE_MISSING', 'SUBJECT_COVERAGE_LOW',
  'VISUAL_REPAIR_PROOF_MISSING', 'STABILIZATION_NOT_IMPROVED', 'COLOR_REPAIR_NOT_IMPROVED', 'COMPARISON_MISSING',
  'STYLE_BLUEPRINT_MISSING', 'STYLE_STRUCTURE_MISMATCH', 'COPYRIGHT_BOUNDARY_FAILED',
  'UNIFIED_VISUAL_QC_FAILED',
  'AUDIO_PROOF_MISSING', 'AUDIO_SILENT', 'AUDIO_CHANGE_MISSING', 'AUDIO_OVERLOAD', 'AUDIO_FADE_PROOF_MISSING',
  'LOUDNESS_PROOF_MISSING', 'LOUDNESS_MISMATCH',
  'MULTITRACK_PROOF_MISSING', 'TRACK_ALIGNMENT_MISMATCH', 'TRACK_AUTOMATION_MISSING', 'DUCKING_RECEIPT_MISSING',
  'AUDIO_REPAIR_PROOF_MISSING', 'DENOISE_NOT_IMPROVED', 'DC_NOT_IMPROVED', 'SILENCE_REPAIR_MISMATCH', 'SEPARATION_PROOF_MISSING', 'SEPARATION_WARNING_MISSING',
  'BEAT_EVIDENCE_MISSING', 'BEAT_CUT_NOT_VISIBLE', 'HIGHLIGHT_DENSITY_MISMATCH', 'MUSIC_ALIGNMENT_MISSING', 'TAIL_FADE_MISSING',
  'DELIVERY_RECEIPT_MISSING', 'DELIVERY_RECEIPT_MISMATCH', 'SOURCE_RECEIPT_MISSING',
  'BUNDLE_INCOMPLETE', 'BUNDLE_INCONSISTENT', 'WORKFLOW_RECEIPT_INCOMPLETE'
])

function uniqueOutputs(result = {}) {
  const values = Array.isArray(result.outputs) ? result.outputs : result.outputPath ? [result.outputPath] : result.srtPath ? [result.srtPath] : []
  return [...new Set(values.map((value) => path.resolve(String(value || ''))).filter(Boolean))]
}

function hasVideoSignature(ext, sample) {
  if (['.mp4', '.mov', '.m4v'].includes(ext)) return sample.length >= 12 && sample.subarray(4, 8).toString('ascii') === 'ftyp'
  if (['.mkv', '.webm'].includes(ext)) return sample.length >= 4 && sample.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (ext === '.avi') return sample.length >= 12 && sample.subarray(0, 4).toString('ascii') === 'RIFF' && sample.subarray(8, 11).toString('ascii') === 'AVI'
  if (ext === '.wmv') return sample.length >= 4 && sample.subarray(0, 4).equals(Buffer.from([0x30, 0x26, 0xb2, 0x75]))
  if (ext === '.flv') return sample.length >= 3 && sample.subarray(0, 3).toString('ascii') === 'FLV'
  if (ext === '.ts') return sample.length >= 1 && sample[0] === 0x47 && (sample.length < 189 || sample[188] === 0x47)
  return false
}

function inspectArtifact(filePath) {
  try {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) return { exists: true, nonEmpty: fs.readdirSync(filePath).length > 0, formatOk: true, bytes: 0, kind: 'directory' }
    if (!stat.isFile()) return { exists: true, nonEmpty: false, formatOk: false, bytes: 0, kind: 'other' }
    const bytes = stat.size
    if (bytes <= 0) return { exists: true, nonEmpty: false, formatOk: false, bytes, kind: 'file' }
    const ext = path.extname(filePath).toLowerCase()
    const sample = fs.readFileSync(filePath).subarray(0, Math.min(bytes, 256 * 1024))
    let formatOk = true
    if (OFFICE_ZIP_EXTENSIONS.has(ext)) formatOk = sample.subarray(0, 2).toString('binary') === 'PK'
    else if (ext === '.pdf') formatOk = sample.subarray(0, 4).toString('ascii') === '%PDF'
    else if (ext === '.srt') formatOk = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(sample.toString('utf8'))
    else if (VIDEO_EXTENSIONS.has(ext)) formatOk = hasVideoSignature(ext, sample)
    return { exists: true, nonEmpty: true, formatOk, bytes, kind: 'file', ext, text: ext === '.srt' ? sample.toString('utf8') : '' }
  } catch {
    return { exists: false, nonEmpty: false, formatOk: false, bytes: 0, kind: 'missing' }
  }
}

function reason(code, message, repairable = false, detail = '') {
  return { code, message, repairable: Boolean(repairable), ...(detail ? { detail } : {}) }
}

function evaluateTaskResult(type, result = {}, spec = {}) {
  const checks = []
  const reasons = []
  const add = (id, label, ratio, weight, failure = null, detail = '') => {
    const bounded = Math.max(0, Math.min(1, Number(ratio) || 0))
    const passed = bounded >= 1
    checks.push({ id, label, passed, weight, score: Math.round(weight * bounded), ...(detail ? { detail } : {}) })
    if (!passed && failure) reasons.push(failure)
  }
  const success = result?.success !== false
  const outputs = uniqueOutputs(result)
  const artifacts = outputs.map((outputPath) => ({ path: outputPath, ...inspectArtifact(outputPath) }))
  const artifactRatio = artifacts.length ? artifacts.filter((item) => item.exists && item.nonEmpty).length / artifacts.length : 0
  const formatRatio = artifacts.length ? artifacts.filter((item) => item.exists && item.nonEmpty && item.formatOk).length / artifacts.length : 0
  const firstMissing = artifacts.find((item) => !item.exists)
  const firstEmpty = artifacts.find((item) => item.exists && !item.nonEmpty)
  const firstInvalid = artifacts.find((item) => item.exists && item.nonEmpty && !item.formatOk)
  const artifactFailure = firstMissing
    ? reason('ARTIFACT_MISSING', '成果文件不存在或已被移动', true, firstMissing.path)
    : firstEmpty ? reason('ARTIFACT_EMPTY', '成果文件为空或目录没有内容', true, firstEmpty.path)
      : outputs.length ? null : reason('ARTIFACT_MISSING', '任务没有产生可验证的成果文件', true)
  const formatFailure = firstInvalid ? reason('INVALID_FORMAT', '成果文件格式或结构无效', true, firstInvalid.path) : null
  const taskType = String(type || '')

  if (taskType === 'media.dedup') {
    add('declared-success', '执行状态', success ? 1 : 0, 20, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('scan-count', '扫描计数', Number.isFinite(Number(result.filesScanned)) && Number(result.filesScanned) >= 0 ? 1 : 0, 40, reason('SCAN_COUNT_MISSING', '缺少扫描文件计数', true))
    add('duplicate-list', '重复结果结构', Array.isArray(result.duplicates) ? 1 : 0, 40, reason('DUPLICATE_LIST_MISSING', '缺少重复文件结果列表', true))
  } else if (taskType === 'media.batch') {
    const results = Array.isArray(result.results) ? result.results : []
    const expected = Math.max(results.length, Array.isArray(spec.sources) ? spec.sources.length : 0)
    const succeeded = results.filter((item) => item?.success && item?.outputPath).length
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('batch-results', '逐项结果', expected > 0 ? results.length / expected : 0, 20, reason('NO_BATCH_RESULTS', '批量任务没有完整逐项结果', true))
    add('batch-success', '批量成功率', expected > 0 ? succeeded / expected : 0, 50, reason('PARTIAL_BATCH', `批量任务只完成 ${succeeded}/${expected} 项`, true))
    add('artifacts', '成果文件', artifactRatio, 20, artifactFailure)
  } else if (taskType === 'outcome.workflow') {
    const workflowReceipt = result.workflowReceipt
    const steps = Array.isArray(workflowReceipt?.steps) ? workflowReceipt.steps : []
    const validSteps = steps.filter((item) => item?.state === 'completed' && Array.isArray(item?.outputs) && item.outputs.length > 0 && item.outputs.every((outputPath) => {
      const artifact = inspectArtifact(outputPath)
      return artifact.exists && artifact.nonEmpty && artifact.formatOk
    }))
    const stepIds = new Set(validSteps.map((item) => item.id))
    const workflowComplete = workflowReceipt?.schemaVersion === 1
      && workflowReceipt?.kind === 'agentplay.outcome-workflow-receipt'
      && /^[a-f0-9]{64}$/i.test(String(workflowReceipt?.source?.sha256 || ''))
      && stepIds.has('evidence-analysis')
      && stepIds.has('consistent-package')
    const receipt = result.deliveryReceipt
    const receiptArtifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
    const deliveryPaths = new Set(receiptArtifacts.map((item) => path.resolve(String(item?.path || ''))))
    const deliveryOk = receipt?.schemaVersion === 1
      && receipt?.kind === 'agentplay.delivery-receipt'
      && outputs.length === receiptArtifacts.length
      && outputs.every((outputPath) => deliveryPaths.has(path.resolve(outputPath)))
      && receiptArtifacts.every((item) => {
        try { return fingerprintArtifact(item.path).sha256 === item.sha256 } catch { return false }
      })
    const projectRequired = Boolean(spec.projectId)
    const projectOk = !projectRequired || (result.projectCapsule?.schemaVersion === 1 && String(result.projectCapsule?.projectId || '').startsWith('project-') && Number(result.projectCapsule?.revision) >= 1 && String(result.projectCapsule?.currentPath || ''))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '最终成果文件', artifactRatio, 25, artifactFailure)
    add('format', '最终成果格式', formatRatio, 10, formatFailure)
    add('workflow-receipt', '逐步成果回执', workflowComplete ? 1 : 0, 25, reason('WORKFLOW_RECEIPT_INCOMPLETE', '成果工作流缺少完整的上游分析或最终打包回执', true))
    add('delivery-receipt', '最终交付回执', deliveryOk ? 1 : 0, 20, !receipt ? reason('DELIVERY_RECEIPT_MISSING', '缺少最终成果交付回执', true) : reason('DELIVERY_RECEIPT_MISMATCH', '最终成果与交付回执不一致', true))
    add('project-capsule', '项目胶囊与当前版本', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '成果没有进入统一项目胶囊或缺少当前版本', true))
  } else if (taskType === 'document.run' && result.chatOnly) {
    add('declared-success', '执行状态', success ? 1 : 0, 20, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('chat-result', '回答内容', String(result.summary || '').trim().length >= 8 ? 1 : 0, 50, reason('EMPTY_CHAT_RESULT', '回答内容为空或过短', true))
    add('history', '历史记录', result.historyId ? 1 : 0, 30, reason('HISTORY_MISSING', '结果尚未写入任务历史', true))
  } else if (taskType === 'project.evidence-qa') {
    const receipt = result.evidenceReceipt
    const claims = Array.isArray(result.claims) ? result.claims : []
    const evidence = Array.isArray(result.evidence) ? result.evidence : []
    const schemaOk = receipt?.schemaVersion === 1 && receipt?.kind === 'agentplay.cross-material-answer-receipt'
    const sourceOk = schemaOk && Number(receipt.sourceCount) >= 2
    const labelsOk = schemaOk && receipt.allClaimsLabeled === true && claims.length > 0 && claims.every((item) => ['confirmed', 'inference', 'unknown'].includes(item?.status))
    const citationsOk = schemaOk && receipt.confirmedCitationsValid === true && claims.filter((item) => item.status === 'confirmed').every((item) => Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0)
    const evidenceOk = evidence.every((item) => item?.kind === 'agentplay.evidence-reference' && item.source && item.locatorLabel)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('source-count', '跨素材来源', sourceOk ? 1 : 0, 25, reason('EVIDENCE_MISSING', '跨素材问答未覆盖至少两个来源', false))
    add('claim-labels', '已确认/推断/未知标记', labelsOk ? 1 : 0, 25, reason('CLAIM_STATUS_MISSING', '回答存在未标记可确认程度的主张', false))
    add('citation-validity', '已确认结论引用', citationsOk ? 1 : 0, 25, reason('EVIDENCE_MISSING', '已确认结论缺少有效证据引用', false))
    add('evidence-locators', '来源定位结构', evidenceOk ? 1 : 0, 15, reason('EVIDENCE_LOCATOR_INVALID', '证据缺少可回开的来源定位', false))
  } else if (taskType === 'subtitle.generate') {
    const text = artifacts.map((item) => item.text || '').join('\n')
    const cueCount = (text.match(/-->/g) || []).length
    const target = String(result.targetLang || spec.targetLang || '')
    const hasTarget = target === '英文' ? /[A-Za-z]/.test(text) : target === '中文' ? /[\u3400-\u9fff]/.test(text) : cueCount > 0
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕文件', artifactRatio, 40, artifactFailure)
    add('format', '字幕结构', formatRatio, 20, formatFailure || reason('SUBTITLE_EMPTY', '字幕文件没有有效时间轴', true))
    add('subtitle-cues', '字幕条目', cueCount > 0 ? 1 : 0, 20, reason('SUBTITLE_EMPTY', '字幕文件没有有效字幕条目', true))
    add('target-language', '目标语言', hasTarget ? 1 : 0, 10, reason('TARGET_LANGUAGE_MISSING', `字幕中没有检测到${target || '目标语言'}文本`, true))
  } else if (taskType === 'analysis.run') {
    const semanticScore = Math.max(0, Math.min(100, Number(result.domainQuality?.score) || 0))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '报告文件', artifactRatio, 30, artifactFailure)
    add('format', '报告结构', formatRatio, 10, formatFailure)
    add('history', '历史记录', result.historyId ? 1 : 0, 10, reason('HISTORY_MISSING', '报告尚未写入历史记录', true))
    add('evidence', '证据覆盖', Number(result.cueCount || 0) + Number(result.frameCount || 0) > 0 ? 1 : 0, 10, reason('EVIDENCE_MISSING', '报告缺少字幕或画面证据计数', false))
    add('semantic-quality', '专业内容质量', semanticScore / 100, 20, reason('SEMANTIC_QUALITY_LOW', '报告专业内容质量未达到标准', false, (result.domainQuality?.reasons || []).join('；')))
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 10, reason('SUMMARY_MISSING', '缺少结果说明', true))
  } else if (taskType === 'document.run') {
    const receipt = result.deliveryReceipt
    const receiptArtifacts = Array.isArray(receipt?.artifacts) ? receipt.artifacts : []
    const receiptSources = Array.isArray(receipt?.sources) ? receipt.sources : []
    const receiptSchemaOk = receipt?.schemaVersion === 1 && receipt?.kind === 'agentplay.delivery-receipt'
    const receiptPaths = new Set(receiptArtifacts.map((item) => path.resolve(String(item?.path || ''))))
    const artifactsMatch = receiptSchemaOk
      && outputs.length === receiptArtifacts.length
      && outputs.every((outputPath) => receiptPaths.has(path.resolve(outputPath)))
      && receiptArtifacts.every((item) => {
        try { return /^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')) && fingerprintArtifact(item.path).sha256 === item.sha256 } catch { return false }
      })
    const expectedSources = Array.isArray(spec.sources) ? spec.sources.length : 0
    const provenanceOk = receiptSchemaOk
      && (expectedSources === 0 ? /^[a-f0-9]{64}$/i.test(String(receipt.instructionSha256 || '')) : receiptSources.length === expectedSources)
      && receiptSources.every((item) => /^[a-f0-9]{64}$/i.test(String(item?.sha256 || '')))
    const isBundle = result.plan?.kind === 'ai-bundle' || Boolean(receipt?.bundle)
    const requestedFormats = Array.isArray(receipt?.bundle?.requestedFormats) ? receipt.bundle.requestedFormats : []
    const completedFormats = new Set(Array.isArray(receipt?.bundle?.completedFormats) ? receipt.bundle.completedFormats : [])
    const failedFormats = receipt?.bundle?.failedFormats && typeof receipt.bundle.failedFormats === 'object' ? receipt.bundle.failedFormats : {}
    const bundleComplete = !isBundle || (
      receipt.status === 'complete'
      && requestedFormats.length >= 2
      && requestedFormats.every((format) => completedFormats.has(format))
      && Object.keys(failedFormats).length === 0
    )
    const bundleConsistent = !isBundle || (
      receipt?.bundle?.consistency?.verdict === 'matched'
      && receipt?.bundle?.consistency?.sharedSourceLedger === true
      && /^[a-f0-9]{64}$/i.test(String(receipt?.bundle?.sourceLedgerSha256 || ''))
      && receiptArtifacts.every((item) => item.sourceLedgerSha256 === receipt.bundle.sourceLedgerSha256 && Array.isArray(item.factIds) && item.factIds.length > 0)
    )
    const projectRequired = Boolean(spec.projectId)
    const projectOk = !projectRequired || (result.projectCapsule?.schemaVersion === 1 && String(result.projectCapsule?.projectId || '').startsWith('project-') && Number(result.projectCapsule?.revision) >= 1 && String(result.projectCapsule?.currentPath || ''))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '成果文件', artifactRatio, 20, artifactFailure)
    add('format', '文件结构', formatRatio, 10, formatFailure)
    add('history', '历史记录', result.historyId ? 1 : 0, 10, reason('HISTORY_MISSING', '成果尚未写入历史记录', true))
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 5, reason('SUMMARY_MISSING', '缺少结果说明', true))
    add('provenance-receipt', '来源与成果哈希回执', artifactsMatch && provenanceOk ? 1 : 0, 20,
      !receiptSchemaOk ? reason('DELIVERY_RECEIPT_MISSING', '缺少可核对的来源与成果交付回执', true)
        : !artifactsMatch ? reason('DELIVERY_RECEIPT_MISMATCH', '成果文件与交付回执不一致或已被改写', true)
          : reason('SOURCE_RECEIPT_MISSING', '交付回执没有覆盖全部来源', true))
    add('bundle-completeness', '成果包完整性', bundleComplete ? 1 : 0, 10, reason('BUNDLE_INCOMPLETE', '成果包存在未完成格式，不能按完整交付处理', true))
    add('bundle-consistency', '成果包共用冻结事实底稿', bundleConsistent ? 1 : 0, 10, reason('BUNDLE_INCONSISTENT', '成果包没有通过共享事实底稿一致性校验', true))
    add('project-capsule', '项目胶囊与当前版本', projectOk ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '成果没有进入统一项目胶囊或缺少当前版本', true))
  } else if (taskType === 'media.visual-repair') {
    const receipt = result.repairReceipt
    const expectedDuration = Number(spec.decision?.repair?.durationSeconds); const tolerance = Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const durationOk = expectedDuration > 0 && Number(result.durationSeconds) > 0 && Math.abs(Number(result.durationSeconds) - expectedDuration) <= tolerance
    const stabilizationOk = spec.decision?.repair?.stabilize ? ['improved', 'not-needed'].includes(receipt?.stabilization?.verdict) && Number(receipt?.stabilization?.before?.frameCount) >= 0 : receipt?.stabilization?.requested === false
    const rotationOk = receipt?.rotation?.matched === true && Number(receipt.rotation.degrees) === Number(spec.decision?.repair?.rotationDegrees) && Number(receipt.rotation.dimensions?.width) === Number(spec.decision?.repair?.expectedDimensions?.width) && Number(receipt.rotation.dimensions?.height) === Number(spec.decision?.repair?.expectedDimensions?.height)
    const colorOk = spec.decision?.repair?.autoColor ? receipt?.color?.verdict === 'improved' && Number(receipt?.color?.afterDistance) < Number(receipt?.color?.beforeDistance) : receipt?.color?.requested === false
    const comparisonOk = outputs.length === 2 && path.resolve(String(receipt?.comparison?.path || '')) === path.resolve(outputs[1]) && Number(receipt?.comparison?.dimensions?.width) > 0 && Number(receipt?.comparison?.dimensions?.height) > 0
    const findings = Array.isArray(receipt?.lowQualityFindings) ? receipt.lowQualityFindings : []
    const reviewOnlyOk = JSON.stringify(findings) === JSON.stringify(spec.decision?.repair?.lowQualityFindings || []) && findings.every((item) => item.action === 'review-only')
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && path.resolve(String(projectCapsule.currentPath || '')) === path.resolve(outputs[0] || '')
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && Array.isArray(result.visualQc?.artifacts) && result.visualQc.artifacts.length === 2
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '画面修复任务返回失败状态', false))
    add('artifacts', '修复版与对比版', outputs.length === 2 ? artifactRatio : 0, 10, artifactFailure || reason('COMPARISON_MISSING', '缺少修复版或前后对比版', true))
    add('formats', '视频文件结构', outputs.length === 2 ? formatRatio : 0, 10, formatFailure || reason('INVALID_FORMAT', '画面修复成果格式无效', true))
    add('duration', '时长保持', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '画面修复成果时长与原片不一致', true))
    add('stabilization', '防抖运动证明', stabilizationOk ? 1 : 0, 10, reason(stabilizationOk ? 'VISUAL_REPAIR_PROOF_MISSING' : 'STABILIZATION_NOT_IMPROVED', '防抖后运动幅度没有可验证改善', true))
    add('rotation', '旋转与尺寸', rotationOk ? 1 : 0, 10, reason('DIMENSION_MISMATCH', '旋转角度或成果尺寸与冻结决策不一致', true))
    add('color', '曝光与偏色改善', colorOk ? 1 : 0, 10, reason('COLOR_REPAIR_NOT_IMPROVED', '曝光/偏色统计没有改善', true))
    add('comparison', '处理前后对比', comparisonOk ? 1 : 0, 5, reason('COMPARISON_MISSING', '前后对比视频缺失或无效', true))
    add('review-only', '低质量片段仅提示', reviewOnlyOk ? 1 : 0, 5, reason('VISUAL_REPAIR_PROOF_MISSING', '低质量片段提示与冻结方案不一致', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '画面修复成果没有进入可撤销项目', true))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '修复版/对比版没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.smart-reframe') {
    const expected = spec.decision?.reframe?.outputs || []
    const versions = Array.isArray(result.versions) ? result.versions : []
    const versionsMatch = expected.length === 3 && versions.length === 3 && expected.every((item, index) => item.aspect === versions[index]?.aspect && Number(item.width) === Number(versions[index]?.dimensions?.width) && Number(item.height) === Number(versions[index]?.dimensions?.height))
    const tolerance = Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const duration = Number(spec.decision?.reframe?.durationSeconds)
    const durationsMatch = duration > 0 && versions.length === 3 && versions.every((item) => Math.abs(Number(item.durationSeconds) - duration) <= tolerance)
    const tracking = result.trackingReceipt
    const evidenceOk = tracking?.strategy === 'vision-keyframes-linear-follow-v1' && tracking?.frameCount === 5 && Number(tracking?.minimumConfidence) >= 0.75 && String(tracking?.subject?.description || '') === String(spec.decision?.reframe?.subject?.description || '')
    const coverageOk = Number(tracking?.minimumSubjectCoverage) >= Number(spec.decision?.verification?.minimumSubjectCoverage || 0.75)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 3
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '智能构图任务返回失败状态', false))
    add('artifacts', '三个构图成果', outputs.length === 3 ? artifactRatio : 0, 15, artifactFailure || reason('REFRAME_OUTPUT_MISMATCH', '智能构图没有交付三个成果', true))
    add('formats', '视频文件结构', outputs.length === 3 ? formatRatio : 0, 10, formatFailure || reason('INVALID_FORMAT', '智能构图成果格式无效', true))
    add('aspects', '三比例尺寸', versionsMatch ? 1 : 0, 15, reason('REFRAME_OUTPUT_MISMATCH', '16:9、9:16或1:1成果尺寸与冻结决策不一致', true))
    add('duration', '三版时长一致', durationsMatch ? 1 : 0, 10, reason('DURATION_MISMATCH', '智能构图成果时长与原片不一致', true))
    add('tracking', '冻结主体轨迹', evidenceOk ? 1 : 0, 10, reason('TRACKING_EVIDENCE_MISSING', '主体关键帧、置信度或目标对象与冻结决策不一致', true))
    add('coverage', '主体画幅覆盖', coverageOk ? 1 : 0, 10, reason('SUBJECT_COVERAGE_LOW', '主体在至少一个目标画幅中覆盖不足', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 5, reason('PROJECT_CAPSULE_MISSING', '智能构图首个成果没有进入可撤销项目', true))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '三比例成果没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.edit-visual-effects') {
    const receipt = result.effectReceipt
    const expectedKinds = spec.decision?.verification?.expectedEffectKinds || []
    const kindsMatch = Array.isArray(receipt?.effectKinds) && expectedKinds.length > 0 && JSON.stringify(receipt.effectKinds) === JSON.stringify(expectedKinds)
    const durationOk = Number(result.durationSeconds) > 0 && Number(result.expectedDurationSeconds) > 0 && Math.abs(Number(result.durationSeconds) - Number(result.expectedDurationSeconds)) <= Math.max(0.1, Number(spec.decision?.verification?.toleranceSeconds) || 0.35)
    const dimensionsOk = receipt?.dimensionMatch === true && Number(receipt?.outputDimensions?.width) > 0 && Number(receipt?.outputDimensions?.height) > 0
    const changed = receipt?.changed === true && Number(receipt?.representativeSample?.meanAbsDiff) > 0.2
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 1
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '视觉效果任务返回失败状态', false))
    add('artifact', '成片文件', artifactRatio, 15, artifactFailure)
    add('effects', '冻结效果清单', kindsMatch ? 1 : 0, 15, reason('EFFECT_RECEIPT_MISMATCH', '成片回执与冻结视觉效果清单不一致', true))
    add('duration', '成片时长', durationOk ? 1 : 0, 15, reason('DURATION_MISMATCH', '视觉效果成片时长不符合冻结决策', true))
    add('dimensions', '分辨率与裁切', dimensionsOk ? 1 : 0, 10, reason('DIMENSION_MISMATCH', '视觉效果成片分辨率与冻结决策不一致', true))
    add('pixel-change', '代表帧变化', changed ? 1 : 0, 10, reason('EFFECT_CHANGE_MISSING', '代表帧没有检测到视觉效果变化', true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '视觉效果成果没有进入可撤销项目', true))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '视觉效果成果没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.edit-audio-mix') {
    const expectedDuration = Number(result.expectedDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const expectedTracks = Array.isArray(spec.decision?.audioMix?.tracks) ? spec.decision.audioMix.tracks : []
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const timelineOk = timelineReceipt.length === expectedTracks.length + 1 && timelineReceipt.every((item) => String(item?.sourceRange || '').length > 0 && String(item?.outputRange || '').length > 0)
    const proof = result.audioMixProof
    const proofSchemaOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-multitrack-pcm-v1'
    const tracksAligned = proofSchemaOk && proof.verdict === 'matched' && Array.isArray(proof.tracks) && proof.tracks.length === expectedTracks.length && proof.tracks.every((item, index) => item.id === expectedTracks[index].id && item.role === expectedTracks[index].role && item.aligned === true)
    const outputOk = proofSchemaOk && proof.output?.nonSilent === true && proof.output?.overloadFree === true && Number.isFinite(Number(proof.output?.samplePeakDbfs))
    const automationExpected = Number(spec.decision?.audioMix?.dialogue?.automation?.length || 0) + expectedTracks.reduce((sum, track) => sum + Number(track.automation?.length || 0), 0)
    const automationOk = proofSchemaOk && Number(proof.automation?.requested) === automationExpected && Number(proof.automation?.configured) === automationExpected
    const duckExpected = proof?.dialogue?.configured ? expectedTracks.filter((track) => track.duckAgainstDialogue === true && spec.decision?.audioMix?.dialogue?.enabled === true).length : 0
    const duckOk = proofSchemaOk && Number(proof.ducking?.configuredTracks) === duckExpected
    const loudnessRequired = spec.decision?.audioMix?.master?.loudness?.enabled === true
    const loudnessProof = result.loudnessProof
    const loudnessOk = !loudnessRequired || (loudnessProof?.schemaVersion === 1 && loudnessProof?.method === 'ebur128-post-encode-v1' && loudnessProof?.verdict === 'matched' && Number.isFinite(Number(loudnessProof.integratedLufs)) && Number.isFinite(Number(loudnessProof.truePeakDbtp)))
    const projectCapsule = result.projectCapsule
    const projectOk = projectCapsule?.schemaVersion === 1 && String(projectCapsule.projectId || '').startsWith('edit-') && String(projectCapsule.versionId || '').startsWith('version-') && projectCapsule.canUndo === true && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '多轨音频任务返回失败状态', false))
    add('artifact', '多轨成片', artifactRatio, 15, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '多轨成果不是受支持的视频格式', true))
    add('duration', '成片时长', durationOk ? 1 : 0, 15, reason('DURATION_MISMATCH', '多轨成片时长与源片不一致', true))
    add('timeline', '轨道时间线', timelineOk ? 1 : 0, 10, reason('TIMELINE_RECEIPT_MISSING', '多轨时间线回执与冻结轨道数量不一致', true))
    add('track-proof', '轨道声音与对齐证明', tracksAligned && outputOk ? 1 : 0, 15, !proofSchemaOk ? reason('MULTITRACK_PROOF_MISSING', '缺少最终成片的多轨PCM证明', true) : !tracksAligned ? reason('TRACK_ALIGNMENT_MISMATCH', '至少一条音乐、环境声或音效没有通过目标时间对齐', true) : reason('AUDIO_OVERLOAD', '多轨成片静音或样本峰值不安全', true), proofSchemaOk ? `${proof.tracks.filter((item) => item.aligned).length}/${expectedTracks.length} 轨对齐` : '')
    add('automation-ducking', '分段音量与对白闪避', automationOk && duckOk ? 1 : 0, 10, !automationOk ? reason('TRACK_AUTOMATION_MISSING', '分段音量自动化回执不完整', true) : reason('DUCKING_RECEIPT_MISSING', '对白闪避回执与冻结轨道不一致', true))
    add('loudness', '编码后响度', loudnessOk ? 1 : 0, 5, !loudnessProof ? reason('LOUDNESS_PROOF_MISSING', '缺少编码后响度回执', true) : reason('LOUDNESS_MISMATCH', '多轨总线编码后响度未达标', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '多轨成果没有进入可撤销编辑项目', true))
  } else if (taskType === 'media.rhythm-edit') {
    const rhythm = spec.decision?.rhythm || {}
    const receipt = result.rhythmReceipt
    const proof = result.beatProof
    const expectedDuration = Number(rhythm.outputDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration >= 6 && actualDuration > 0 && Math.abs(expectedDuration - actualDuration) <= tolerance
    const receiptOk = receipt?.schemaVersion === 1 && receipt?.strategy === 'beat-synced-jump-cut-v1' && receipt.pace === rhythm.pace && Number(receipt.bpm) === Number(rhythm.bpm) && Number(receipt.supportRatio) >= 0.45 && Array.isArray(receipt.cutTimes) && receipt.cutTimes.length === rhythm.cutTimes?.length
    const proofOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-beat-cut-proof-v1'
    const visibleOk = proofOk && Number(proof.visibleCutRatio) >= Number(spec.decision?.verification?.minimumVisibleCutRatio || 0.5)
    const highlightOk = proofOk && proof.highlight?.denserThanOutside === true && Number(proof.highlight?.densityRatio) <= 0.8
    const musicOk = proofOk && Number(proof.musicCorrelation) >= 0.02
    const tailOk = proofOk && proof.tail?.audioFaded === true && proof.tail?.videoFaded === true
    const project = result.projectCapsule
    const projectOk = project?.schemaVersion === 1 && String(project.projectId || '').startsWith('edit-') && project.canUndo === true && outputs.some((item) => path.resolve(item) === path.resolve(String(project.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '节拍剪辑任务返回失败状态', false))
    add('artifact', '节拍成片', artifactRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, artifactFailure || reason('INVALID_FORMAT', '节拍成果不是受支持的视频格式', true))
    add('duration', '冻结时间线', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '节拍成片时长与冻结时间线不一致', true))
    add('beat-evidence', '真实节拍网格', receiptOk ? 1 : 0, 10, reason('BEAT_EVIDENCE_MISSING', '缺少解码PCM节拍、BPM或网格支持率回执', true))
    add('visible-cuts', '切点画面变化', visibleOk ? 1 : 0, 15, reason('BEAT_CUT_NOT_VISIBLE', '真实节拍切点没有形成足够可见的镜头变化', true))
    add('highlight-density', '高潮切镜密度', highlightOk ? 1 : 0, 15, reason('HIGHLIGHT_DENSITY_MISMATCH', '音乐高潮区切镜没有比普通段更密', true))
    add('music-alignment', '成片音乐对齐', musicOk ? 1 : 0, 10, reason('MUSIC_ALIGNMENT_MISSING', '成片高潮区没有检测到冻结音乐的PCM相关证据', true))
    add('natural-tail', '片尾自然收束', tailOk ? 1 : 0, 10, reason('TAIL_FADE_MISSING', '片尾画面或声音没有在冻结强拍处完成淡出', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '节拍剪辑成果没有进入可撤销项目', true))
  } else if (taskType === 'media.audio-repair') {
    const repair = spec.decision?.audioRepair || {}
    const expectedOutputs = repair.separation?.enabled ? 3 : 1
    const outputCountOk = outputs.length === expectedOutputs && artifactRatio === 1
    const expectedDuration = Number(result.expectedDurationSeconds || 0); const actualDuration = Number(result.durationSeconds || 0)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(expectedDuration - actualDuration) <= Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const proof = result.audioRepairProof
    const proofSchemaOk = proof?.schemaVersion === 1 && proof?.method === 'decoded-audio-repair-v1'
    const denoiseOk = !repair.denoise?.enabled || ['improved', 'not-needed'].includes(proof?.denoise?.verdict)
    const dcOk = !repair.dcRemoval?.enabled || ['improved', 'not-needed'].includes(proof?.dcRemoval?.verdict)
    const silenceOk = !repair.silenceRepair?.enabled || (['filled', 'not-needed'].includes(proof?.silenceRepair?.verdict) && proof?.silenceRepair?.restoresSpeech === false)
    const repairProofOk = proofSchemaOk && denoiseOk && dcOk && silenceOk
    const separation = result.separationProof
    const separationOk = !repair.separation?.enabled || (separation?.schemaVersion === 1 && separation?.method === 'stereo-mid-side-v1' && separation?.verdict === 'matched-with-artifact-warning' && separation?.outputs?.length === 2 && separation?.distinct === true)
    const warningOk = !repair.separation?.enabled || (String(separation?.artifactWarning || '').includes('不是AI专业分轨') && separation?.claims?.professionalAiSeparation === false && separation?.claims?.mayContainBleed === true)
    const loudness = result.loudnessProof
    const loudnessOk = !repair.loudness?.enabled || (loudness?.schemaVersion === 1 && loudness?.method === 'ebur128-post-encode-v1' && loudness?.verdict === 'matched')
    const project = result.projectCapsule
    const projectOk = project?.schemaVersion === 1 && String(project.projectId || '').startsWith('edit-') && project.canUndo === true && outputs.some((item) => path.resolve(item) === path.resolve(String(project.currentPath || '')))
    const proofFailure = !proofSchemaOk ? reason('AUDIO_REPAIR_PROOF_MISSING', '缺少修复前后PCM证明', true) : !denoiseOk ? reason('DENOISE_NOT_IMPROVED', '降噪没有取得可测改善', true) : !dcOk ? reason('DC_NOT_IMPROVED', '去直流没有取得可测改善', true) : reason('SILENCE_REPAIR_MISMATCH', '短静音底噪修复不完整或冒充恢复语音', true)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '音频修复任务返回失败状态', false))
    add('artifacts', '修复版与分离轨', outputCountOk ? 1 : 0, 15, artifactFailure || reason('BUNDLE_INCOMPLETE', `期望 ${expectedOutputs} 个音频修复成果`, true))
    add('duration', '声画时长', durationOk ? 1 : 0, 10, reason('DURATION_MISMATCH', '音频修复成片时长与源片不一致', true))
    add('repair-proof', '降噪/去直流/短静音证明', repairProofOk ? 1 : 0, 15, proofFailure)
    add('silence-honesty', '静音修复边界', silenceOk ? 1 : 0, 10, reason('SILENCE_REPAIR_MISMATCH', '静音修复必须明确只补连续底噪、不恢复丢失语音', true))
    add('separation', '基础人声/伴奏分离', separationOk ? 1 : 0, 15, reason('SEPARATION_PROOF_MISSING', '基础分离缺少两条不同且非静音的立体声成果', true))
    add('separation-warning', '分离伪影提示', warningOk ? 1 : 0, 5, reason('SEPARATION_WARNING_MISSING', '基础分离没有说明串音、变薄和非AI专业分轨边界', true))
    add('loudness', '编码后响度', loudnessOk ? 1 : 0, 10, reason('LOUDNESS_MISMATCH', '音频修复编码后响度未达标', true))
    add('project', '可撤销项目', projectOk ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '音频修复成果没有进入可撤销项目', true))
  } else if (taskType === 'media.edit-music') {
    const expectedDuration = Number(result.expectedDurationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const hasTimelineReceipt = timelineReceipt.some((item) => String(item?.sourceRange || '').includes('→') && String(item?.outputRange || '').includes('→'))
    const audioProof = result.audioProof
    const proofSchemaOk = audioProof?.schemaVersion === 1 && audioProof?.method === 'decoded-pcm-s16le-v1'
    const nonSilent = proofSchemaOk && audioProof.output?.hasAudio === true && audioProof.output?.nonSilent === true
    const changed = proofSchemaOk && audioProof.change?.verdict === 'changed' && Number(audioProof.change?.changedWindows) > 0
    const overloadFree = proofSchemaOk && audioProof.output?.overloadFree === true && Number.isFinite(Number(audioProof.output?.samplePeakDbfs))
    const fadeInRequired = Number(spec.decision?.audio?.fadeInSeconds ?? 1) > 0
    const fadeOutRequired = Number(spec.decision?.audio?.fadeOutSeconds ?? 1.5) > 0
    const fadesOk = proofSchemaOk
      && (!fadeInRequired || audioProof.fades?.fadeIn?.verdict === 'matched')
      && (!fadeOutRequired || audioProof.fades?.fadeOut?.verdict === 'matched')
    const proofOk = proofSchemaOk && audioProof.verdict === 'matched' && nonSilent && changed && overloadFree && fadesOk
    let audioFailure = null
    if (!proofSchemaOk) audioFailure = reason('AUDIO_PROOF_MISSING', '缺少解码后的声音质量证明，不能只凭音轨存在判定配乐成功', true)
    else if (!nonSilent) audioFailure = reason('AUDIO_SILENT', '成片音轨存在但采样结果为静音或近似静音', true)
    else if (!changed) audioFailure = reason('AUDIO_CHANGE_MISSING', '成片声音与原声采样没有可确认的变化，无法证明背景音乐已混入', true)
    else if (!overloadFree) audioFailure = reason('AUDIO_OVERLOAD', '成片声音样本峰值达到或超过安全上限', true)
    else if (!fadesOk) audioFailure = reason('AUDIO_FADE_PROOF_MISSING', '背景音乐淡入淡出窗口没有通过声音采样核对', true)
    const loudnessRequired = spec.decision?.audio?.loudness?.enabled === true
    const loudnessProof = result.loudnessProof
    const loudnessSchemaOk = loudnessProof?.schemaVersion === 1 && loudnessProof?.method === 'ebur128-post-encode-v1'
    const loudnessOk = !loudnessRequired || (loudnessSchemaOk && loudnessProof.verdict === 'matched' && Number.isFinite(Number(loudnessProof.integratedLufs)) && Number.isFinite(Number(loudnessProof.truePeakDbtp)))
    const loudnessFailure = !loudnessRequired
      ? null
      : !loudnessSchemaOk
        ? reason('LOUDNESS_PROOF_MISSING', '缺少 AAC 编码后的 EBU R128 响度与 true peak 回执', true)
        : reason('LOUDNESS_MISMATCH', `编码后响度未达到冻结目标：${loudnessProof.integratedLufs ?? '未知'} LUFS / ${loudnessProof.truePeakDbtp ?? '未知'} dBTP`, true)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && Number(projectCapsule.cursor) >= 1
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const proofDetail = proofSchemaOk
      ? `样本峰值 ${Number(audioProof.output?.samplePeakDbfs).toFixed(2)} dBFS；${Number(audioProof.change?.changedWindows) || 0}/${Number(audioProof.change?.comparedWindows) || 0} 个窗口确认变化`
      : ''
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '配乐视频', artifactRatio, 15, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '配乐成果不是受支持的视频格式', true))
    add('duration-receipt', '成品时长', durationOk ? 1 : 0, 15, reason('DURATION_MISMATCH', `成品时长与源片不一致：期望 ${expectedDuration || 0} 秒，实际 ${actualDuration || 0} 秒`, true))
    add('timeline-receipt', '配乐范围回执', hasTimelineReceipt ? 1 : 0, 10, reason('TIMELINE_RECEIPT_MISSING', '缺少背景音乐覆盖范围回执', true))
    add('audio-proof', '声音质量证明', proofOk ? 1 : 0, 15, audioFailure, proofDetail)
    add('loudness-proof', '编码后响度', loudnessOk ? 1 : 0, 15, loudnessFailure, loudnessSchemaOk ? `${loudnessProof.integratedLufs} LUFS；true peak ${loudnessProof.truePeakDbtp} dBTP` : '')
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 10, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.edit-trim' || taskType === 'media.edit-remove' || taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources' || taskType === 'media.edit-burn-subtitles' || taskType === 'media.edit-mux-subtitles') {
    const expectedDuration = Number(result.expectedDurationSeconds || spec.decision?.timeline?.durationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const mappedTimelineReceipts = timelineReceipt.filter((item) => String(item?.sourceRange || '').includes('→') && String(item?.outputRange || '').includes('→'))
    const expectedSegmentCount = taskType === 'media.edit-concat' && Array.isArray(spec.decision?.timeline?.segments)
      ? spec.decision.timeline.segments.length
      : taskType === 'media.edit-concat-sources' && Array.isArray(spec.decision?.sources) ? spec.decision.sources.length : 0
    const hasTimelineReceipt = expectedSegmentCount > 0
      ? timelineReceipt.length === expectedSegmentCount && mappedTimelineReceipts.length === expectedSegmentCount
      : mappedTimelineReceipts.length > 0
    const requiresFrameProof = taskType === 'media.edit-trim' || taskType === 'media.edit-remove' || taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources'
    const frameProof = result.frameProof
    const frameProofVerdict = String(frameProof?.verdict || '')
    const expectedFrameBoundaryCount = taskType === 'media.edit-trim' ? 1 : taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources' ? expectedSegmentCount : taskType === 'media.edit-remove' ? mappedTimelineReceipts.length : 0
    const frameProofComplete = taskType === 'media.edit-trim'
      ? Boolean(frameProof?.first && frameProof?.last)
      : Array.isArray(frameProof?.boundaries) && frameProof.boundaries.length === expectedFrameBoundaryCount && frameProof.boundaries.every((item) => item?.first && item?.last)
    let frameProofRatio = 1
    let frameProofFailure = null
    if (requiresFrameProof) {
      if (!frameProof) {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_MISSING', '缺少首尾帧边界证明，不能确认剪辑点', true)
      } else if (frameProofVerdict === 'unavailable') {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_UNAVAILABLE', '无法生成首尾帧边界证明，不能确认剪辑点', true)
      } else if (frameProofVerdict === 'mismatch') {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_BOUNDARY_MISMATCH', '成片首尾帧与决策切割点不符', true)
      } else if (!frameProofComplete) {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_INCOMPLETE', `帧边界证明不完整：期望 ${expectedFrameBoundaryCount} 个片段，实际 ${Array.isArray(frameProof.boundaries) ? frameProof.boundaries.length : 0} 个`, true)
      } else if (frameProofVerdict === 'matched') {
        frameProofRatio = 1
      } else if (frameProofVerdict === 'inconclusive') {
        frameProofRatio = 0.5
        frameProofFailure = reason('FRAME_BOUNDARY_INCONCLUSIVE', '画面内容过于相似，首尾帧证据无法唯一判定；已保留时长与时间线核验结果', false)
      } else {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_UNAVAILABLE', '无法生成首尾帧边界证明，不能确认剪辑点', true)
      }
    }
    const frameProofDetail = requiresFrameProof && frameProof
      ? Array.isArray(frameProof.boundaries) && frameProof.boundaries.length
        ? `${frameProof.boundaries.slice(0, 4).map((item, index) => `片段${index + 1}首差异 ${item.first?.matchDiff ?? '未知'}、余量 ${item.first?.margin ?? '未知'}；末差异 ${item.last?.matchDiff ?? '未知'}、余量 ${item.last?.margin ?? '未知'}`).join('｜')}${frameProof.boundaries.length > 4 ? `｜另${frameProof.boundaries.length - 4}个片段见完整回执` : ''}`
        : `首帧差异 ${frameProof.first?.matchDiff ?? '未知'}、余量 ${frameProof.first?.margin ?? '未知'}；尾帧差异 ${frameProof.last?.matchDiff ?? '未知'}、余量 ${frameProof.last?.margin ?? '未知'}`
      : ''
    const timelineFailure = expectedSegmentCount > 0
      ? reason('SEGMENT_RECEIPT_INCOMPLETE', `拼接时间线回执不完整：期望 ${expectedSegmentCount} 段，实际 ${mappedTimelineReceipts.length} 段`, true)
      : reason('TIMELINE_RECEIPT_MISSING', '缺少可核对的源片段与成品时间线回执', true)
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && Number(projectCapsule.cursor) >= 1
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '剪辑视频', artifactRatio, requiresFrameProof ? 20 : 25, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 10, formatFailure || reason('INVALID_FORMAT', '剪辑成果不是受支持的视频格式', true))
    add('duration-receipt', '成品时长', durationOk ? 1 : 0, 20, reason('DURATION_MISMATCH', `成品时长与决策不一致：期望 ${expectedDuration || 0} 秒，实际 ${actualDuration || 0} 秒`, true))
    add('timeline-receipt', '时间线回执', hasTimelineReceipt ? 1 : 0, 10, timelineFailure)
    if (requiresFrameProof) add('frame-proof', '帧边界证明', frameProofRatio, 10, frameProofFailure, frameProofDetail)
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, requiresFrameProof ? 20 : 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.shift-subtitles') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const droppedCueCount = Number(result.droppedCueCount || 0)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(sourceCueCount) && sourceCueCount - droppedCueCount === cueCount
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt' || item.ext === '.vtt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '调时成果不是有效的 srt/vtt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 25, reason('CUE_RECEIPT_MISMATCH', `字幕条目回执不一致：源 ${sourceCueCount || 0} 条、丢弃 ${droppedCueCount} 条、成果 ${cueCount || 0} 条`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.translate-subtitles') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(sourceCueCount) && sourceCueCount > 0 && cueCount >= sourceCueCount
    const targetLang = String(result.targetLang || '')
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    const artifactText = artifacts.map((item) => item.text || '').join('\n')
    const hasTargetText = targetLang === '英文' ? /[A-Za-z]/.test(artifactText) : /[一-鿿]/.test(artifactText)
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '翻译成果不是有效的 srt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 15, reason('CUE_RECEIPT_MISMATCH', `翻译条目回执不一致：源 ${sourceCueCount || 0} 条、成果 ${cueCount || 0} 条`, true))
    add('target-language', '目标语言', hasTargetText ? 1 : 0, 10, reason('TARGET_LANGUAGE_MISSING', `字幕中没有检测到${targetLang || '目标语言'}文本`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'media.edit-subtitle-cues') {
    const cueCount = Number(result.cueCount)
    const sourceCueCount = Number(result.sourceCueCount)
    const cueEdit = spec.decision?.cueEdit
    const expectedCueCount = cueEdit?.operation === 'replace'
      ? sourceCueCount
      : sourceCueCount - (Number(cueEdit?.endIndex) - Number(cueEdit?.startIndex) + 1)
    const cueReceiptOk = Number.isFinite(cueCount) && cueCount > 0 && Number.isFinite(expectedCueCount) && cueCount === expectedCueCount
    const projectCapsule = result.projectCapsule
    const hasProjectCapsule = projectCapsule?.schemaVersion === 1
      && String(projectCapsule.projectId || '').startsWith('edit-')
      && String(projectCapsule.versionId || '').startsWith('version-')
      && Number(projectCapsule.versionCount) >= 2
      && projectCapsule.canUndo === true
      && outputs.some((outputPath) => path.resolve(outputPath) === path.resolve(String(projectCapsule.currentPath || '')))
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '字幕成果', artifactRatio, 25, artifactFailure)
    add('format', '字幕结构', formatRatio && artifacts.every((item) => item.ext === '.srt' || item.ext === '.vtt') ? 1 : 0, 15, formatFailure || reason('INVALID_FORMAT', '校对成果不是有效的 srt/vtt 字幕', true))
    add('cue-receipt', '条目回执', cueReceiptOk ? 1 : 0, 25, reason('CUE_RECEIPT_MISMATCH', `校对条目回执不一致：期望 ${expectedCueCount || 0} 条，实际 ${cueCount || 0} 条`, true))
    add('project-capsule', '可撤销项目', hasProjectCapsule ? 1 : 0, 25, reason('PROJECT_CAPSULE_MISSING', '缺少可撤销的编辑项目版本回执', true))
  } else if (taskType === 'creative.recut-short') {
    const blueprint = result.styleBlueprint
    const receipt = result.styleReuseReceipt
    const shots = Array.isArray(result.styleShots) ? result.styleShots : []
    const blueprintOk = blueprint?.schemaVersion === 1 && blueprint?.strategy === 'abstract-style-blueprint-v1' && /^[a-f0-9]{64}$/i.test(String(blueprint?.sourceReportSha256 || '')) && blueprint?.sourceSpecificTextExcluded === true
    const structureOk = receipt?.structureMatched === true && shots.length >= 2 && shots.length === Number(result.clips) && shots.every((shot, index) => Number(shot.duration) === Number(blueprint?.rhythm?.durations?.[index]) && shot.shotSize === blueprint?.shotSizes?.[index] && shot.movement === blueprint?.movements?.[index])
    const copyrightOk = receipt?.rawReportSentToShotModel === false && receipt?.referenceImagesSent === 0 && receipt?.promptSafetyPassed === true && Array.isArray(receipt?.promptSha256) && receipt.promptSha256.length === shots.length && receipt.promptSha256.every((item) => /^[a-f0-9]{64}$/i.test(String(item)))
    const visualQcOk = result.visualQc?.strategy === 'unified-visual-export-qc-v1' && result.visualQc?.passed === true && result.visualQc?.artifacts?.length === 1
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '原创风格重构任务返回失败状态', false))
    add('artifact', '原创重构成片', artifactRatio, 20, artifactFailure)
    add('format', '成片结构', formatRatio, 10, formatFailure)
    add('blueprint', '抽象风格蓝图', blueprintOk ? 1 : 0, 15, reason('STYLE_BLUEPRINT_MISSING', '缺少不含专有表达的抽象风格蓝图', false))
    add('structure', '节奏景别运镜匹配', structureOk ? 1 : 0, 15, reason('STYLE_STRUCTURE_MISMATCH', '生成镜头没有遵循冻结的节奏/景别/运镜结构', false))
    add('copyright', '版权与原创边界', copyrightOk ? 1 : 0, 15, reason('COPYRIGHT_BOUNDARY_FAILED', '拉片正文、参考帧或专有表达可能进入了镜头生成', false))
    add('unified-visual-qc', '统一视觉导出质量门', visualQcOk ? 1 : 0, 15, reason('UNIFIED_VISUAL_QC_FAILED', '原创重构成片没有通过分辨率、比例、黑边、黑帧、编码与完整解码检查', true))
  } else if (taskType === 'media.compress') {
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '视频成果', artifactRatio, 50, artifactFailure)
    add('format', '视频格式', formatRatio && artifacts.every((item) => VIDEO_EXTENSIONS.has(item.ext)) ? 1 : 0, 20, formatFailure || reason('INVALID_FORMAT', '压缩成果不是受支持的视频格式', true))
    add('size-receipt', '大小回执', Number(result.afterBytes || artifacts[0]?.bytes || 0) > 0 ? 1 : 0, 20, reason('SIZE_RECEIPT_MISSING', '缺少压缩后大小回执', true))
  } else if (taskType.startsWith('download.') || taskType.startsWith('creative.')) {
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '成果文件', artifactRatio, 50, artifactFailure)
    add('format', '成果格式', formatRatio, 20, formatFailure)
    add('output-receipt', '成果回执', outputs.length ? 1 : 0, 20, reason('OUTPUT_RECEIPT_MISSING', '缺少成果路径回执', true))
  } else {
    add('declared-success', '执行状态', success ? 1 : 0, 30, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('result', '可验证结果', result.chatOnly || artifactRatio ? 1 : 0, 50, artifactFailure)
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 20, reason('SUMMARY_MISSING', '缺少结果说明', true))
  }

  const score = checks.reduce((sum, item) => sum + item.score, 0)
  const threshold = 80
  const uniqueReasons = [...new Map(reasons.filter(Boolean).map((item) => [item.code, item])).values()]
  const hardFailure = uniqueReasons.some((item) => HARD_FAILURES.has(item.code))
  const passed = score >= threshold && !hardFailure
  return {
    version: 1,
    profile: taskType === 'analysis.run' ? 'semantic-and-technical' : taskType === 'project.evidence-qa' ? 'semantic-evidence' : 'technical',
    score,
    threshold,
    passed,
    level: passed ? (uniqueReasons.length ? 'warning' : 'pass') : 'fail',
    reasons: uniqueReasons,
    checks,
    artifacts: artifacts.map(({ text, ...item }) => item)
  }
}

function classifyTaskFailure(error) {
  const message = error instanceof Error ? error.message : String(error || '任务执行失败')
  if (/context size|context length|上下文|token.*(?:exceed|limit)|exceed.*token/i.test(message)) return { code: 'MODEL_CONTEXT_EXCEEDED', message: '模型上下文容量不足，请减少内容或切换大上下文模型', retryable: true }
  if (/源.*(?:变化|不存在|移动)|source.*(?:changed|missing)|fingerprint/i.test(message)) return { code: 'SOURCE_CHANGED', message: '源文件已变化或不存在，请重新选择后执行', retryable: false }
  if (/ffmpeg|ffprobe|whisper|组件.*(?:缺少|未安装)|component.*missing/i.test(message)) return { code: 'COMPONENT_MISSING', message: '所需本地组件未安装或不可用，请先完成组件安装', retryable: true }
  if (/授权|approval|credential|api key|凭证/i.test(message)) return { code: 'AUTHORIZATION_REQUIRED', message: '任务需要重新确认授权或配置凭证', retryable: true }
  if (/network|fetch failed|timed? ?out|econn|socket|网络/i.test(message)) return { code: 'NETWORK_FAILURE', message: '网络或远端服务暂时不可用，可稍后重试', retryable: true }
  if (/cancel|取消|abort/i.test(message)) return { code: 'CANCELLED', message: '任务已取消', retryable: true }
  return { code: 'EXECUTION_FAILED', message, retryable: true }
}

module.exports = { evaluateTaskResult, classifyTaskFailure, inspectArtifact, uniqueOutputs, hasVideoSignature }
