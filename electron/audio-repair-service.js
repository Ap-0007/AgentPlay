const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { parseSilenceEvents } = require('./semantic-edit-service')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])

function pcmStats(buffer) {
  const samples = Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (!samples) return { samples: 0, rms: 0, mean: 0, peak: 0 }
  let sum = 0; let power = 0; let peak = 0
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768
    sum += value; power += value * value; peak = Math.max(peak, Math.abs(value))
  }
  return { samples, rms: Math.sqrt(power / samples), mean: sum / samples, peak }
}

function parseLoudnorm(stderr) {
  const blocks = [...String(stderr || '').matchAll(/\{\s*"input_i"\s*:[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g)]
  if (!blocks.length) return null
  try {
    const raw = JSON.parse(blocks.at(-1)[0]); const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
    if (fields.some((field) => !Number.isFinite(Number(raw[field])))) return null
    return Object.fromEntries(fields.map((field) => [field, Number(raw[field])]))
  } catch { return null }
}

function fileHash(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }

class AudioRepairService {
  constructor({ frames, fsImpl = fs } = {}) {
    if (!frames) throw new Error('音频修复服务缺少 FFmpeg 执行器')
    this.frames = frames; this.fs = fsImpl
  }

  assertDecision(source, decision) {
    const repair = decision?.audioRepair
    if (decision?.schemaVersion !== 1 || decision?.kind !== 'media.repair-audio' || repair?.schemaVersion !== 1 || repair?.strategy !== 'ffmpeg-audio-repair-v1') throw new Error('音频修复决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('音频修复决策与源视频不一致')
    return repair
  }

  async shortGaps(source, duration, repair, signal) {
    if (!repair.silenceRepair?.enabled) return []
    const min = Number(repair.silenceRepair.minimumGapSeconds); const max = Number(repair.silenceRepair.maximumGapSeconds)
    const result = await this.frames.run(['-hide_banner', '-nostats', '-i', source, '-map', '0:a:0', '-af', `silencedetect=noise=-60dB:d=${min.toFixed(3)}`, '-f', 'null', '-'], { timeoutMs: Math.max(120000, duration * 1000), signal })
    return parseSilenceEvents(result.stderr)
      .filter((gap) => gap.startSeconds > 0.1 && gap.endSeconds < duration - 0.1 && gap.durationSeconds >= min - 0.005 && gap.durationSeconds <= max + 0.005)
      .slice(0, Number(repair.silenceRepair.maximumGapCount) || 12)
      .map((gap) => ({ startSeconds: Number(gap.startSeconds.toFixed(3)), endSeconds: Number(gap.endSeconds.toFixed(3)), durationSeconds: Number(gap.durationSeconds.toFixed(3)) }))
  }

  repairFilter(repair, gaps, duration) {
    const filters = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo']
    if (repair.denoise?.enabled) filters.push(`afftdn=nr=${Number(repair.denoise.noiseReductionDb) || 12}:nf=${Number(repair.denoise.noiseFloorDb) || -25}:tn=1`)
    if (repair.dcRemoval?.enabled) filters.push(`highpass=f=${Number(repair.dcRemoval.cutoffHz) || 20}`)
    if (!gaps.length) return `[0:a]${filters.join(',')}[repaired]`
    const parts = [`[0:a]${filters.join(',')}[processed]`]
    gaps.forEach((gap, index) => parts.push(`anoisesrc=color=pink:amplitude=1:r=48000:d=${duration.toFixed(3)},volume='${Number(repair.silenceRepair.fillAmplitude).toFixed(6)}*gte(t,${gap.startSeconds.toFixed(3)})*lte(t,${gap.endSeconds.toFixed(3)})':eval=frame[room-${index}]`))
    parts.push(`[processed]${gaps.map((_, index) => `[room-${index}]`).join('')}amix=inputs=${gaps.length + 1}:duration=first:normalize=0[repaired]`)
    return parts.join(';')
  }

  async renderRepairPcm({ source, decision, duration, signal, tempDir, token }) {
    const repair = this.assertDecision(source, decision)
    const gaps = await this.shortGaps(source, duration, repair, signal)
    const pcmPath = path.join(tempDir, `.agentplay-audio-repair-${token}.wav`)
    await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-filter_complex', this.repairFilter(repair, gaps, duration), '-map', '[repaired]', '-t', duration.toFixed(3), '-ar', '48000', '-c:a', 'pcm_s16le', '-y', pcmPath], { timeoutMs: 60 * 60 * 1000, signal })
    const pcmDuration = await this.frames.probeDuration(pcmPath, { signal })
    if (!(pcmDuration > 0) || Math.abs(pcmDuration - duration) > 0.05) throw new Error('修复PCM总线时长与源视频不一致')
    return { pcmPath, gaps }
  }

  async sampleRepairMetrics({ source, repairedPcm, gaps, duration, repair, signal }) {
    const candidates = [0.2, 0.5, 0.8, 0.15, 0.35, 0.65].map((fraction) => Math.min(Math.max(0.05, duration * fraction), Math.max(0.05, duration - 0.3)))
    const valid = candidates.filter((at) => !gaps.some((gap) => at < gap.endSeconds && at + 0.25 > gap.startSeconds))
    const windows = []
    for (const at of valid.slice(0, 6)) {
      const [before, after] = await Promise.all([
        this.frames.readPcmWindow(source, at, { durationSeconds: 0.25, sampleRateHz: 16000, signal }),
        this.frames.readPcmWindow(repairedPcm, at, { durationSeconds: 0.25, sampleRateHz: 16000, signal })
      ])
      if (before && after) windows.push({ at, before: pcmStats(before), after: pcmStats(after) })
    }
    if (!windows.length) throw new Error('无法取得音频修复前后PCM窗口')
    const quietest = [...windows].sort((a, b) => a.before.rms - b.before.rms)[0]
    const beforeDc = Math.max(...windows.map((item) => Math.abs(item.before.mean)))
    const afterDc = Math.max(...windows.map((item) => Math.abs(item.after.mean)))
    const denoise = repair.denoise?.enabled
      ? { requested: true, beforeNoiseRms: Number(quietest.before.rms.toFixed(6)), afterNoiseRms: Number(quietest.after.rms.toFixed(6)), improvementRatio: quietest.before.rms > 0 ? Number((1 - quietest.after.rms / quietest.before.rms).toFixed(4)) : 0 }
      : { requested: false, verdict: 'not-requested' }
    if (repair.denoise?.enabled) denoise.verdict = quietest.before.rms < 0.002 ? 'not-needed' : quietest.after.rms <= quietest.before.rms * 0.95 ? 'improved' : 'mismatch'
    const dcRemoval = repair.dcRemoval?.enabled
      ? { requested: true, beforeAbsoluteMean: Number(beforeDc.toFixed(6)), afterAbsoluteMean: Number(afterDc.toFixed(6)), verdict: beforeDc < 0.002 ? 'not-needed' : afterDc <= Math.max(0.002, beforeDc * 0.3) ? 'improved' : 'mismatch' }
      : { requested: false, verdict: 'not-requested' }
    const gapProofs = []
    for (const gap of gaps) {
      const windowSeconds = Math.max(0.05, Math.min(0.2, gap.durationSeconds - 0.02))
      const [sourcePcm, outputPcm] = await Promise.all([
        this.frames.readPcmWindow(source, gap.startSeconds + 0.01, { durationSeconds: windowSeconds, sampleRateHz: 16000, signal }),
        this.frames.readPcmWindow(repairedPcm, gap.startSeconds + 0.01, { durationSeconds: windowSeconds, sampleRateHz: 16000, signal })
      ])
      const sourceStats = pcmStats(sourcePcm); const outputStats = pcmStats(outputPcm)
      gapProofs.push({ ...gap, sourceRms: Number(sourceStats.rms.toFixed(6)), outputRms: Number(outputStats.rms.toFixed(6)), filled: outputStats.rms >= Math.max(0.00005, sourceStats.rms * 1.25) && outputStats.rms <= 0.05 })
    }
    const silenceRepair = repair.silenceRepair?.enabled
      ? { requested: true, method: repair.silenceRepair.method, restoresSpeech: false, detectedGapCount: gaps.length, filledGapCount: gapProofs.filter((item) => item.filled).length, gaps: gapProofs, verdict: gaps.every((_, index) => gapProofs[index]?.filled) ? (gaps.length ? 'filled' : 'not-needed') : 'mismatch' }
      : { requested: false, verdict: 'not-requested', restoresSpeech: false, gaps: [] }
    return { schemaVersion: 1, method: 'decoded-audio-repair-v1', denoise, dcRemoval, silenceRepair, windows: windows.map((item) => ({ atSeconds: Number(item.at.toFixed(3)), beforeRms: Number(item.before.rms.toFixed(6)), afterRms: Number(item.after.rms.toFixed(6)), beforeMean: Number(item.before.mean.toFixed(6)), afterMean: Number(item.after.mean.toFixed(6)) })) }
  }

  async measureLoudness(audioPath, policy, signal) {
    const first = await this.frames.run(['-hide_banner', '-nostdin', '-i', audioPath, '-af', `loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:print_format=json`, '-f', 'null', '-'], { timeoutMs: 30 * 60 * 1000, signal })
    const measured = parseLoudnorm(first.stderr)
    if (!measured) throw new Error('无法读取音频修复第一遍响度测量')
    return measured
  }

  loudnessFilter(policy, measured) {
    if (!policy.enabled) return 'alimiter=limit=0.850:level=0'
    return `loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary,alimiter=limit=0.850:level=0`
  }

  async loudnessProof(output, policy, signal) {
    if (!policy.enabled) return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: 'not-requested' }
    const result = await this.frames.probeLoudness(output, { signal })
    if (!result) return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: 'unavailable' }
    const delta = result.integratedLufs - policy.targetLufs
    const matched = Math.abs(delta) <= policy.toleranceLufs && result.truePeakDbtp <= policy.maxTruePeakDbtp
    return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: matched ? 'matched' : 'mismatch', integratedLufs: result.integratedLufs, truePeakDbtp: result.truePeakDbtp, loudnessDelta: Number(delta.toFixed(2)) }
  }

  async correctEncodedLoudness(output, policy, signal) {
    const initial = await this.loudnessProof(output, policy, signal)
    if (!policy.enabled || initial.verdict === 'matched') return initial
    if (!Number.isFinite(initial.integratedLufs) || !Number.isFinite(initial.truePeakDbtp)) return initial
    const gainDb = Number((policy.targetLufs - initial.integratedLufs).toFixed(2))
    const feasible = Math.abs(gainDb) <= 6 && initial.truePeakDbtp + Math.max(0, gainDb) <= policy.maxTruePeakDbtp
    if (!feasible) return { ...initial, correction: { attempted: false, reason: 'no-feasible-bounded-gain', gainDb } }
    const parsed = path.parse(output); const corrected = path.join(parsed.dir, `.${parsed.name}.agentplay-loudness-correct-${process.pid}-${Date.now()}${parsed.ext}`)
    try {
      await this.frames.run(['-hide_banner', '-nostdin', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-af', `volume=${gainDb.toFixed(2)}dB,alimiter=limit=0.850:level=0`, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', corrected], { timeoutMs: 30 * 60 * 1000, signal })
      const finalProof = await this.loudnessProof(corrected, policy, signal)
      if (finalProof.verdict !== 'matched') return { ...finalProof, correction: { attempted: true, applied: false, gainDb, initial } }
      this.fs.rmSync(output, { force: true }); this.fs.renameSync(corrected, output)
      return { ...finalProof, correction: { attempted: true, applied: true, gainDb, initial } }
    } finally { if (this.fs.existsSync(corrected)) this.fs.rmSync(corrected, { force: true }) }
  }

  async separate({ repairedPcm, repair, duration, stemPaths, signal }) {
    if (!repair.separation?.enabled) return { proof: { schemaVersion: 1, method: 'stereo-mid-side-v1', verdict: 'not-requested', artifactWarning: repair.separation?.artifactWarning || '' }, outputs: [] }
    const info = await this.frames.probeAudioStreamInfo(repairedPcm, { signal })
    if (!info || info.channels < 2) throw new Error('基础人声/伴奏分离只支持立体声音轨；当前音轨不是立体声')
    if (!Array.isArray(stemPaths) || stemPaths.length !== 2) throw new Error('基础分离缺少两条计划输出路径')
    const [voicePath, accompanimentPath] = stemPaths.map((item) => path.resolve(item))
    await this.frames.run(['-hide_banner', '-nostdin', '-i', repairedPcm, '-filter_complex', '[0:a]pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1[voice];[0:a]pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0[accompaniment]', '-map', '[voice]', '-ar', '48000', '-c:a', 'pcm_s16le', '-y', voicePath, '-map', '[accompaniment]', '-ar', '48000', '-c:a', 'pcm_s16le', '-y', accompanimentPath], { timeoutMs: 30 * 60 * 1000, signal })
    const proofs = []
    for (const [role, output] of [['voice', voicePath], ['accompaniment', accompanimentPath]]) {
      if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error(`基础${role === 'voice' ? '人声' : '伴奏'}轨为空`)
      const outputDuration = await this.frames.probeDuration(output, { signal }); const levels = await this.frames.probeAudioLevels(output, { signal })
      proofs.push({ role, path: output, durationSeconds: Number(outputDuration.toFixed(3)), nonSilent: Number(levels?.meanVolumeDbfs) > -70, samplePeakDbfs: Number(levels?.samplePeakDbfs) })
    }
    const distinct = fileHash(voicePath) !== fileHash(accompanimentPath)
    const matched = proofs.every((item) => item.nonSilent && Math.abs(item.durationSeconds - duration) <= 0.05) && distinct
    return { outputs: [voicePath, accompanimentPath], proof: { schemaVersion: 1, method: repair.separation.method, verdict: matched ? 'matched-with-artifact-warning' : 'mismatch', channels: info.channels, outputs: proofs, distinct, artifactWarning: repair.separation.artifactWarning, claims: { professionalAiSeparation: false, mayContainBleed: true } } }
  }

  assertProofs(repairProof, separationProof, loudnessProof, repair) {
    if (repair.denoise?.enabled && !['improved', 'not-needed'].includes(repairProof.denoise?.verdict)) throw new Error('降噪没有取得可测改善')
    if (repair.dcRemoval?.enabled && !['improved', 'not-needed'].includes(repairProof.dcRemoval?.verdict)) throw new Error('去直流没有取得可测改善')
    if (repair.silenceRepair?.enabled && !['filled', 'not-needed'].includes(repairProof.silenceRepair?.verdict)) throw new Error(`短静音修复证明不完整：${JSON.stringify(repairProof.silenceRepair)}`)
    if (repair.loudness?.enabled && loudnessProof?.verdict !== 'matched') throw new Error(`音频修复编码后响度未达标：目标 ${repair.loudness.targetLufs} LUFS / 最大 ${repair.loudness.maxTruePeakDbtp} dBTP，实测 ${loudnessProof?.integratedLufs ?? '未知'} LUFS / ${loudnessProof?.truePeakDbtp ?? '未知'} dBTP`)
    if (repair.separation?.enabled && separationProof?.verdict !== 'matched-with-artifact-warning') throw new Error('基础人声/伴奏分离成果不完整')
    if (repair.separation?.enabled && !String(separationProof.artifactWarning || '').includes('不是AI专业分轨')) throw new Error('基础分离缺少伪影与能力边界提示')
  }

  async run({ sourcePath, outputPath, stemPaths = [], decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || '')); const repair = this.assertDecision(source, decision)
    if (source === output || !VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()) || !this.fs.existsSync(source)) throw new Error('音频修复源视频无效或将覆盖原文件')
    if (this.fs.existsSync(output) || stemPaths.some((item) => this.fs.existsSync(item))) throw new Error('音频修复成果已存在，为避免覆盖已停止')
    if (!await this.frames.probeHasAudio(source, { signal })) throw new Error('当前视频没有可修复的音轨')
    const sourceDuration = await this.frames.probeDuration(source, { signal }); if (!(sourceDuration > 0)) throw new Error('无法读取音频修复源时长')
    if (repair.separation?.enabled) { const info = await this.frames.probeAudioStreamInfo(source, { signal }); if (!info || info.channels < 2) throw new Error('基础人声/伴奏分离需要立体声源；当前源不是立体声') }
    const before = this.fs.statSync(source); const parsed = path.parse(output); const token = `${process.pid}-${Date.now()}`; const tempOutput = path.join(parsed.dir, `.${parsed.name}.agentplay-audio-repair-${token}${parsed.ext || '.mp4'}`)
    let pcmPath = ''
    try {
      const rendered = await this.renderRepairPcm({ source, decision, duration: sourceDuration, signal, tempDir: parsed.dir, token }); pcmPath = rendered.pcmPath
      const repairProof = await this.sampleRepairMetrics({ source, repairedPcm: pcmPath, gaps: rendered.gaps, duration: sourceDuration, repair, signal })
      const measured = repair.loudness.enabled ? await this.measureLoudness(pcmPath, repair.loudness, signal) : null
      await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-i', pcmPath, '-filter_complex', `[1:a]${this.loudnessFilter(repair.loudness, measured)}[aout]`, '-map', '0:v:0', '-map', '[aout]', '-t', sourceDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', tempOutput], { timeoutMs: 60 * 60 * 1000, signal })
      const actualDuration = await this.frames.probeDuration(tempOutput, { signal }); if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > 0.2) throw new Error('音频修复成片时长不一致')
      const separation = await this.separate({ repairedPcm: pcmPath, repair, duration: sourceDuration, stemPaths, signal })
      const loudnessProof = await this.correctEncodedLoudness(tempOutput, repair.loudness, signal)
      this.assertProofs(repairProof, separation.proof, loudnessProof, repair)
      const current = this.fs.statSync(source); if (before.size !== current.size || Math.trunc(before.mtimeMs) !== Math.trunc(current.mtimeMs)) throw new Error('音频修复期间源视频发生变化')
      this.fs.renameSync(tempOutput, output)
      return this.receipt({ output, sourceDuration, actualDuration, decision, repairProof, separationProof: separation.proof, stemPaths: separation.outputs, loudnessProof })
    } catch (error) {
      if (this.fs.existsSync(tempOutput)) this.fs.rmSync(tempOutput, { force: true })
      for (const stem of stemPaths) if (this.fs.existsSync(stem)) this.fs.rmSync(stem, { force: true })
      throw error
    } finally { if (pcmPath && this.fs.existsSync(pcmPath)) this.fs.rmSync(pcmPath, { force: true }) }
  }

  async verify({ sourcePath, outputPath, stemPaths = [], decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || '')); const repair = this.assertDecision(source, decision)
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('音频修复成果不存在或不完整')
    const duration = await this.frames.probeDuration(source, { signal }); const actualDuration = await this.frames.probeDuration(output, { signal }); if (Math.abs(duration - actualDuration) > 0.2) throw new Error('音频修复成果时长复核失败')
    const token = `verify-${process.pid}-${Date.now()}`; const tempDir = path.dirname(output); let pcmPath = ''
    try {
      const rendered = await this.renderRepairPcm({ source, decision, duration, signal, tempDir, token }); pcmPath = rendered.pcmPath
      const repairProof = await this.sampleRepairMetrics({ source, repairedPcm: pcmPath, gaps: rendered.gaps, duration, repair, signal })
      const loudnessProof = await this.loudnessProof(output, repair.loudness, signal)
      const separationProof = repair.separation.enabled ? await this.verifySeparation(stemPaths, repair, duration, signal) : { schemaVersion: 1, method: repair.separation.method, verdict: 'not-requested', artifactWarning: repair.separation.artifactWarning }
      this.assertProofs(repairProof, separationProof, loudnessProof, repair)
      return this.receipt({ output, sourceDuration: duration, actualDuration, decision, repairProof, separationProof, stemPaths: repair.separation.enabled ? stemPaths : [], loudnessProof })
    } finally { if (pcmPath && this.fs.existsSync(pcmPath)) this.fs.rmSync(pcmPath, { force: true }) }
  }

  async verifySeparation(stemPaths, repair, duration, signal) {
    if (!Array.isArray(stemPaths) || stemPaths.length !== 2) throw new Error('基础分离恢复缺少两条成果')
    const outputs = []
    for (const [index, stem] of stemPaths.entries()) {
      if (!this.fs.existsSync(stem) || this.fs.statSync(stem).size <= 1024) throw new Error('基础分离成果不存在')
      const d = await this.frames.probeDuration(stem, { signal }); const levels = await this.frames.probeAudioLevels(stem, { signal })
      outputs.push({ role: index === 0 ? 'voice' : 'accompaniment', path: stem, durationSeconds: Number(d.toFixed(3)), nonSilent: Number(levels?.meanVolumeDbfs) > -70, samplePeakDbfs: Number(levels?.samplePeakDbfs) })
    }
    const distinct = fileHash(stemPaths[0]) !== fileHash(stemPaths[1]); const matched = outputs.every((item) => item.nonSilent && Math.abs(item.durationSeconds - duration) <= 0.05) && distinct
    return { schemaVersion: 1, method: repair.separation.method, verdict: matched ? 'matched-with-artifact-warning' : 'mismatch', outputs, distinct, artifactWarning: repair.separation.artifactWarning, claims: { professionalAiSeparation: false, mayContainBleed: true } }
  }

  receipt({ output, sourceDuration, actualDuration, decision, repairProof, separationProof, stemPaths, loudnessProof }) {
    const actions = [decision.audioRepair.denoise.enabled ? '降噪' : '', decision.audioRepair.dcRemoval.enabled ? '去直流' : '', decision.audioRepair.silenceRepair.enabled ? '短静音底噪修复' : '', decision.audioRepair.loudness.enabled ? '响度匹配' : '', decision.audioRepair.separation.enabled ? '基础人声/伴奏分离' : ''].filter(Boolean)
    return { success: true, outputPath: output, outputs: [output, ...stemPaths], outputBytes: this.fs.statSync(output).size, sourceDurationSeconds: sourceDuration, expectedDurationSeconds: sourceDuration, durationSeconds: Number(actualDuration.toFixed(3)), audioRepair: JSON.parse(JSON.stringify(decision.audioRepair)), audioRepairProof: repairProof, separationProof, loudnessProof, timelineReceipt: [{ operation: actions.join('、'), sourceRange: `00:00.000 → ${sourceDuration.toFixed(3)}秒`, outputRange: `00:00.000 → ${actualDuration.toFixed(3)}秒` }], summary: `已完成${actions.join('、')}，生成 ${Number(actualDuration).toFixed(3)} 秒音频修复版；原文件未改动。${repairProof.silenceRepair?.requested ? `短静音只补连续底噪，不恢复丢失语音（${repairProof.silenceRepair.filledGapCount}/${repairProof.silenceRepair.detectedGapCount}处）` : ''}${decision.audioRepair.separation.enabled ? `；另存基础人声轨与伴奏轨。${separationProof.artifactWarning}` : ''}${loudnessProof.verdict === 'matched' ? `；编码后响度 ${loudnessProof.integratedLufs} LUFS、true peak ${loudnessProof.truePeakDbtp} dBTP` : ''}` }
  }
}

module.exports = { AudioRepairService, pcmStats }
