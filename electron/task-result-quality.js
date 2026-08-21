const fs = require('fs')
const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts'])
const OFFICE_ZIP_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.epub'])
const HARD_FAILURES = new Set([
  'RESULT_FAILED', 'ARTIFACT_MISSING', 'ARTIFACT_EMPTY', 'INVALID_FORMAT', 'SUBTITLE_EMPTY',
  'TARGET_LANGUAGE_MISSING', 'PARTIAL_BATCH', 'NO_BATCH_RESULTS', 'DURATION_MISMATCH', 'SEGMENT_RECEIPT_INCOMPLETE', 'PROJECT_CAPSULE_MISSING',
  'FRAME_PROOF_MISSING', 'FRAME_PROOF_UNAVAILABLE', 'FRAME_BOUNDARY_MISMATCH'
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
  } else if (taskType === 'document.run' && result.chatOnly) {
    add('declared-success', '执行状态', success ? 1 : 0, 20, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('chat-result', '回答内容', String(result.summary || '').trim().length >= 8 ? 1 : 0, 50, reason('EMPTY_CHAT_RESULT', '回答内容为空或过短', true))
    add('history', '历史记录', result.historyId ? 1 : 0, 30, reason('HISTORY_MISSING', '结果尚未写入任务历史', true))
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
    add('declared-success', '执行状态', success ? 1 : 0, 10, reason('RESULT_FAILED', '任务返回失败状态', false))
    add('artifacts', '成果文件', artifactRatio, 45, artifactFailure)
    add('format', '文件结构', formatRatio, 15, formatFailure)
    add('history', '历史记录', result.historyId ? 1 : 0, 20, reason('HISTORY_MISSING', '成果尚未写入历史记录', true))
    add('summary', '结果说明', String(result.summary || '').trim() ? 1 : 0, 10, reason('SUMMARY_MISSING', '缺少结果说明', true))
  } else if (taskType === 'media.edit-trim' || taskType === 'media.edit-remove' || taskType === 'media.edit-concat' || taskType === 'media.edit-concat-sources' || taskType === 'media.edit-burn-subtitles' || taskType === 'media.edit-mux-subtitles') {
    const expectedDuration = Number(result.expectedDurationSeconds || spec.decision?.timeline?.durationSeconds || 0)
    const actualDuration = Number(result.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(spec.decision?.verification?.toleranceSeconds) || 0.2)
    const durationOk = expectedDuration > 0 && actualDuration > 0 && Math.abs(actualDuration - expectedDuration) <= tolerance
    const timelineReceipt = Array.isArray(result.timelineReceipt) ? result.timelineReceipt : []
    const mappedTimelineReceipts = timelineReceipt.filter((item) => String(item?.sourceRange || '').includes('→') && String(item?.outputRange || '').includes('→'))
    const expectedSegmentCount = taskType === 'media.edit-concat' && Array.isArray(spec.decision?.timeline?.segments)
      ? spec.decision.timeline.segments.length
      : 0
    const hasTimelineReceipt = expectedSegmentCount > 0
      ? timelineReceipt.length === expectedSegmentCount && mappedTimelineReceipts.length === expectedSegmentCount
      : mappedTimelineReceipts.length > 0
    const requiresFrameProof = taskType === 'media.edit-trim'
    const frameProof = result.frameProof
    const frameProofVerdict = String(frameProof?.verdict || '')
    let frameProofRatio = 1
    let frameProofFailure = null
    if (requiresFrameProof) {
      if (!frameProof) {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_MISSING', '缺少首尾帧边界证明，不能确认剪辑点', true)
      } else if (frameProofVerdict === 'matched') {
        frameProofRatio = 1
      } else if (frameProofVerdict === 'inconclusive') {
        frameProofRatio = 0.5
        frameProofFailure = reason('FRAME_BOUNDARY_INCONCLUSIVE', '画面内容过于相似，首尾帧证据无法唯一判定；已保留时长与时间线核验结果', false)
      } else if (frameProofVerdict === 'mismatch') {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_BOUNDARY_MISMATCH', '成片首尾帧与决策切割点不符', true)
      } else {
        frameProofRatio = 0
        frameProofFailure = reason('FRAME_PROOF_UNAVAILABLE', '无法生成首尾帧边界证明，不能确认剪辑点', true)
      }
    }
    const frameProofDetail = requiresFrameProof && frameProof
      ? `首帧差异 ${frameProof.first?.matchDiff ?? '未知'}、余量 ${frameProof.first?.margin ?? '未知'}；尾帧差异 ${frameProof.last?.matchDiff ?? '未知'}、余量 ${frameProof.last?.margin ?? '未知'}`
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
    profile: taskType === 'analysis.run' ? 'semantic-and-technical' : 'technical',
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
