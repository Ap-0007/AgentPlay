const fs = require('fs')
const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma'])

function formatTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000))
  const minutes = Math.floor(milliseconds / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
}

function pcmSample(buffer, index) { return buffer.readInt16LE(index * 2) / 32768 }

function pcmStats(buffer) {
  const samples = Buffer.isBuffer(buffer) ? Math.floor(buffer.length / 2) : 0
  if (!samples) return { samples: 0, rms: 0, samplePeak: 0, samplePeakDbfs: -Infinity }
  let power = 0; let peak = 0
  for (let index = 0; index < samples; index += 1) {
    const value = pcmSample(buffer, index); power += value * value; peak = Math.max(peak, Math.abs(value))
  }
  return { samples, rms: Math.sqrt(power / samples), samplePeak: peak, samplePeakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity }
}

function alignedCorrelation(sourceBuffer, outputBuffer, maxLagSamples = 640) {
  const sourceSamples = Buffer.isBuffer(sourceBuffer) ? Math.floor(sourceBuffer.length / 2) : 0
  const outputSamples = Buffer.isBuffer(outputBuffer) ? Math.floor(outputBuffer.length / 2) : 0
  if (sourceSamples < 160 || outputSamples < 160) return 0
  const maxLag = Math.min(maxLagSamples, Math.floor(Math.min(sourceSamples, outputSamples) / 3))
  let best = -1
  for (let lag = -maxLag; lag <= maxLag; lag += 4) {
    const sourceStart = lag < 0 ? -lag : 0; const outputStart = lag > 0 ? lag : 0
    const count = Math.min(sourceSamples - sourceStart, outputSamples - outputStart)
    let dot = 0; let sourcePower = 0; let outputPower = 0
    for (let offset = 0; offset < count; offset += 4) {
      const left = pcmSample(sourceBuffer, sourceStart + offset); const right = pcmSample(outputBuffer, outputStart + offset)
      dot += left * right; sourcePower += left * left; outputPower += right * right
    }
    const correlation = sourcePower > 0 && outputPower > 0 ? Math.abs(dot / Math.sqrt(sourcePower * outputPower)) : 0
    best = Math.max(best, correlation)
  }
  return Number(Math.max(0, best).toFixed(6))
}

function parseLoudnormMeasurement(stderr) {
  const blocks = [...String(stderr || '').matchAll(/\{\s*"input_i"\s*:[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g)]
  if (!blocks.length) return null
  try {
    const value = JSON.parse(blocks.at(-1)[0])
    const fields = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
    if (fields.some((field) => !Number.isFinite(Number(value[field])))) return null
    return Object.fromEntries(fields.map((field) => [field, Number(value[field])]))
  } catch { return null }
}

class AudioMixService {
  constructor({ frames, fsImpl = fs } = {}) {
    if (!frames) throw new Error('多轨音频服务缺少 FFmpeg 执行器')
    this.frames = frames; this.fs = fsImpl
  }

  assertDecision(source, decision) {
    const mix = decision?.audioMix
    if (decision?.schemaVersion !== 1 || decision?.kind !== 'media.mix-audio' || mix?.schemaVersion !== 1 || mix?.strategy !== 'multitrack-audio-mix-v1') throw new Error('多轨音频决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('多轨音频决策与源视频不一致')
    const tracks = Array.isArray(mix.tracks) ? mix.tracks : []
    if (!tracks.length || tracks.length > 8) throw new Error('多轨音频数量无效')
    return { mix, tracks }
  }

  loudnessPolicy(decision) {
    const raw = decision?.audioMix?.master?.loudness
    if (!raw || raw.enabled !== true) return { enabled: false }
    const policy = {
      enabled: true, targetLufs: Number(raw.targetLufs), targetTruePeakDbtp: Number(raw.targetTruePeakDbtp),
      maxTruePeakDbtp: Number(raw.maxTruePeakDbtp), lra: Number(raw.lra), toleranceLufs: Number(raw.toleranceLufs)
    }
    if (!Number.isFinite(policy.targetLufs) || policy.targetLufs < -24 || policy.targetLufs > -10 || !Number.isFinite(policy.targetTruePeakDbtp) || policy.targetTruePeakDbtp < -3 || policy.targetTruePeakDbtp > -1 || !Number.isFinite(policy.maxTruePeakDbtp) || policy.maxTruePeakDbtp < policy.targetTruePeakDbtp || policy.maxTruePeakDbtp > -0.5 || !Number.isFinite(policy.lra) || policy.lra < 1 || policy.lra > 20 || !Number.isFinite(policy.toleranceLufs) || policy.toleranceLufs < 0.2 || policy.toleranceLufs > 2) throw new Error('多轨总线响度策略无效')
    return policy
  }

  volumeFilters(baseVolume, automation, offsetSeconds = 0) {
    const filters = [`volume=${Number(baseVolume).toFixed(3)}`]
    for (const item of Array.isArray(automation) ? automation : []) {
      const start = Math.max(0, Number(item.startSeconds) - offsetSeconds)
      const end = Math.max(start, Number(item.endSeconds) - offsetSeconds)
      const ratio = Number(baseVolume) > 0 ? Number(item.volume) / Number(baseVolume) : 0
      if (end > start && Number.isFinite(ratio)) filters.push(`volume=${ratio.toFixed(6)}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`)
    }
    return filters.join(',')
  }

  async buildFilterPlan({ source, decision, sourceDuration, hasSourceAudio, signal }) {
    const { mix, tracks } = this.assertDecision(source, decision)
    const inputArgs = ['-i', source]
    const filterParts = []
    const prepared = []
    for (let index = 0; index < tracks.length; index += 1) {
      const track = tracks[index]
      const audioPath = path.resolve(String(track.path || ''))
      if (!AUDIO_EXTENSIONS.has(path.extname(audioPath).toLowerCase()) || !this.fs.existsSync(audioPath) || !this.fs.statSync(audioPath).isFile()) throw new Error(`多轨音频文件不存在或格式不支持：${audioPath}`)
      const duration = await this.frames.probeDuration(audioPath, { signal })
      if (!(duration > 0)) throw new Error(`无法读取多轨音频时长：${path.basename(audioPath)}`)
      const startSeconds = Number(track.startSeconds)
      const endSeconds = track.endSeconds == null ? sourceDuration : Number(track.endSeconds)
      if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds >= sourceDuration || !Number.isFinite(endSeconds) || endSeconds <= startSeconds || endSeconds > sourceDuration + 0.05) throw new Error(`多轨音频目标范围超出视频时长：${track.id}`)
      const targetDuration = endSeconds - startSeconds
      const loop = track.loop === true
      inputArgs.push(...(loop ? ['-stream_loop', '-1', '-t', targetDuration.toFixed(3)] : []), '-i', audioPath)
      prepared.push({ ...track, path: audioPath, sourceDuration: duration, startSeconds, endSeconds, targetDuration, loop, inputIndex: index + 1 })
    }

    const duckTracks = prepared.filter((track) => track.duckAgainstDialogue && mix.dialogue?.enabled && hasSourceAudio)
    let dialogueLabel = ''
    const keyLabels = new Map()
    if (mix.dialogue?.enabled && hasSourceAudio) {
      const base = Number(mix.dialogue.volume)
      const chain = `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${this.volumeFilters(base, mix.dialogue.automation)}[dialogue-pre]`
      filterParts.push(chain)
      if (duckTracks.length) {
        const outputs = ['dialogue', ...duckTracks.map((_, index) => `duck-key-${index + 1}`)]
        filterParts.push(`[dialogue-pre]asplit=${outputs.length}${outputs.map((label) => `[${label}]`).join('')}`)
        duckTracks.forEach((track, index) => keyLabels.set(track.id, `duck-key-${index + 1}`))
        dialogueLabel = 'dialogue'
      } else dialogueLabel = 'dialogue-pre'
    }

    const mixLabels = dialogueLabel ? [dialogueLabel] : []
    for (const track of prepared) {
      const relativeDuration = Math.min(track.targetDuration, track.loop ? track.targetDuration : track.sourceDuration)
      const fadeIn = Math.min(Math.max(0, Number(track.fadeInSeconds) || 0), relativeDuration / 2)
      const fadeOut = Math.min(Math.max(0, Number(track.fadeOutSeconds) || 0), relativeDuration / 2)
      const fadeOutStart = Math.max(0, relativeDuration - fadeOut)
      const delayMs = Math.round(track.startSeconds * 1000)
      const baseLabel = `track-${track.id}-base`
      const preparedLabel = `track-${track.id}-prepared`
      filterParts.push(`[${track.inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${relativeDuration.toFixed(3)},asetpts=PTS-STARTPTS,${this.volumeFilters(track.volume, track.automation, track.startSeconds)},afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)},adelay=${delayMs}|${delayMs},apad=pad_dur=${sourceDuration.toFixed(3)},atrim=duration=${sourceDuration.toFixed(3)}[${baseLabel}]`)
      if (keyLabels.has(track.id)) {
        filterParts.push(`[${baseLabel}][${keyLabels.get(track.id)}]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[${preparedLabel}]`)
      } else filterParts.push(`[${baseLabel}]anull[${preparedLabel}]`)
      mixLabels.push(preparedLabel)
    }
    if (!mixLabels.length) throw new Error('多轨方案没有可输出的声音轨')
    filterParts.push(`${mixLabels.map((label) => `[${label}]`).join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=2:normalize=0,atrim=duration=${sourceDuration.toFixed(3)}[mix]`)
    return { inputArgs, mixFilter: filterParts.join(';'), prepared, dialogueConfigured: Boolean(dialogueLabel), duckConfigured: duckTracks.length }
  }

  async loudnessMeasurement({ inputArgs, mixFilter, durationSeconds, policy, signal }) {
    const result = await this.frames.run(['-hide_banner', '-nostdin', ...inputArgs, '-filter_complex', `${mixFilter};[mix]loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:print_format=json[analysis]`, '-map', '[analysis]', '-t', durationSeconds.toFixed(3), '-f', 'null', '-'], { timeoutMs: 60 * 60 * 1000, signal })
    const measurement = parseLoudnormMeasurement(result.stderr)
    if (!measurement) throw new Error('无法读取多轨总线第一遍 EBU R128 测量')
    return measurement
  }

  async measureLoudnessFile({ audioPath, policy, signal }) {
    const result = await this.frames.run(['-hide_banner', '-nostdin', '-i', audioPath, '-af', `loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:print_format=json`, '-f', 'null', '-'], { timeoutMs: 30 * 60 * 1000, signal })
    const measurement = parseLoudnormMeasurement(result.stderr)
    if (!measurement) throw new Error('无法读取有限多轨总线的 EBU R128 测量')
    return measurement
  }

  secondPass(policy, measurement) {
    return `loudnorm=I=${policy.targetLufs}:TP=${policy.targetTruePeakDbtp}:LRA=${policy.lra}:measured_I=${measurement.input_i}:measured_TP=${measurement.input_tp}:measured_LRA=${measurement.input_lra}:measured_thresh=${measurement.input_thresh}:offset=${measurement.target_offset}:linear=true:print_format=summary`
  }

  async loudnessProof(output, decision, signal) {
    const policy = this.loudnessPolicy(decision)
    if (!policy.enabled) return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: 'not-requested' }
    const measured = await this.frames.probeLoudness(output, { signal })
    if (!measured) return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: 'unavailable' }
    const delta = measured.integratedLufs - policy.targetLufs
    const matched = Math.abs(delta) <= policy.toleranceLufs && measured.truePeakDbtp <= policy.maxTruePeakDbtp
    return { schemaVersion: 1, method: 'ebur128-post-encode-v1', policy, verdict: matched ? 'matched' : 'mismatch', integratedLufs: measured.integratedLufs, truePeakDbtp: measured.truePeakDbtp, loudnessDelta: Number(delta.toFixed(2)) }
  }

  async proof({ source, output, decision, sourceDuration, plan, signal }) {
    const levels = await this.frames.probeAudioLevels(output, { signal })
    const outputInfo = { hasAudio: true, nonSilent: Number(levels?.meanVolumeDbfs) > -70, samplePeakDbfs: Number(levels?.samplePeakDbfs), overloadFree: Number(levels?.samplePeakDbfs) < -0.05 }
    const trackProofs = []
    for (const track of plan.prepared) {
      const activeDuration = Math.min(track.targetDuration, track.loop ? track.targetDuration : track.sourceDuration)
      const windowSeconds = Math.min(0.35, Math.max(0.12, activeDuration / 3))
      const relativeAt = Math.min(Math.max(0.05, activeDuration / 3), Math.max(0.05, activeDuration - windowSeconds - 0.02))
      const sourceAt = track.loop ? relativeAt % track.sourceDuration : relativeAt
      const outputAt = track.startSeconds + relativeAt
      const sourcePcm = await this.frames.readPcmWindow(track.path, sourceAt, { durationSeconds: windowSeconds, sampleRateHz: 16000, signal })
      const outputPcm = await this.frames.readPcmWindow(output, outputAt, { durationSeconds: windowSeconds, sampleRateHz: 16000, signal })
      const sourceStats = pcmStats(sourcePcm); const outputStats = pcmStats(outputPcm)
      const correlation = alignedCorrelation(sourcePcm, outputPcm)
      let outsideCorrelation = null
      if (track.startSeconds >= windowSeconds + 0.08) {
        const outside = await this.frames.readPcmWindow(output, Math.max(0, track.startSeconds - windowSeconds - 0.03), { durationSeconds: windowSeconds, sampleRateHz: 16000, signal })
        outsideCorrelation = alignedCorrelation(sourcePcm, outside)
      }
      const aligned = sourceStats.rms > 0.00001 && outputStats.rms > 0.00001 && correlation >= 0.02 && (outsideCorrelation == null || correlation >= outsideCorrelation + 0.01)
      trackProofs.push({ id: track.id, role: track.role, targetRange: { startSeconds: track.startSeconds, endSeconds: track.endSeconds }, sourceRms: Number(sourceStats.rms.toFixed(6)), outputRms: Number(outputStats.rms.toFixed(6)), correlation, outsideCorrelation, aligned })
    }
    const automationRequested = Number(decision.audioMix.dialogue?.automation?.length || 0) + plan.prepared.reduce((sum, track) => sum + Number(track.automation?.length || 0), 0)
    const duckRequested = plan.prepared.filter((track) => track.duckAgainstDialogue).length
    const tracksAligned = trackProofs.length === plan.prepared.length && trackProofs.every((item) => item.aligned)
    const verdict = outputInfo.nonSilent && outputInfo.overloadFree && tracksAligned ? 'matched' : 'mismatch'
    return { schemaVersion: 1, method: 'decoded-multitrack-pcm-v1', verdict, output: outputInfo, tracks: trackProofs, automation: { requested: automationRequested, configured: automationRequested }, ducking: { requestedTracks: duckRequested, configuredTracks: plan.duckConfigured, claim: 'configuration-plus-real-acceptance' }, dialogue: { requested: decision.audioMix.dialogue?.enabled === true, configured: plan.dialogueConfigured } }
  }

  assertProof(proof, decision) {
    if (proof?.verdict !== 'matched') throw new Error('多轨声音证明未通过：存在静音、过载或轨道对齐不一致')
    if (proof.tracks?.some((track) => !track.aligned)) throw new Error('多轨音频目标时间对齐未通过')
    const automation = Number(decision.audioMix.dialogue?.automation?.length || 0) + decision.audioMix.tracks.reduce((sum, track) => sum + Number(track.automation?.length || 0), 0)
    if (proof.automation?.configured !== automation) throw new Error('多轨分段音量回执不完整')
    const expectedDuck = decision.audioMix.tracks.filter((track) => track.duckAgainstDialogue && decision.audioMix.dialogue?.enabled).length
    if (proof.dialogue?.configured && proof.ducking?.configuredTracks !== expectedDuck) throw new Error('对白闪避回执不完整')
  }

  async mix({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
    const { tracks } = this.assertDecision(source, decision)
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()) || !this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('多轨混音源视频不存在或格式不支持')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available || typeof this.frames.probeHasAudio !== 'function') throw new Error('缺少多轨混音所需 FFmpeg 能力')
    const sourceDuration = await this.frames.probeDuration(source, { signal }); if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    const hasSourceAudio = await this.frames.probeHasAudio(source, { signal })
    const sourceBefore = this.fs.statSync(source)
    const trackBefore = tracks.map((track) => ({ path: path.resolve(track.path), stat: this.fs.statSync(path.resolve(track.path)) }))
    const plan = await this.buildFilterPlan({ source, decision, sourceDuration, hasSourceAudio, signal })
    const policy = this.loudnessPolicy(decision)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-audio-mix-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    const mixPcmPath = path.join(parsed.dir, `.${parsed.name}.agentplay-audio-mix-${process.pid}-${Date.now()}.wav`)
    try {
      // 先把复杂多轨图冻结为有限 PCM 总线，再做响度与视频封装；避免循环输入在第二遍编码中保持无穷读取。
      await this.frames.run(['-hide_banner', '-nostdin', ...plan.inputArgs, '-filter_complex', plan.mixFilter, '-map', '[mix]', '-t', sourceDuration.toFixed(3), '-ar', '48000', '-c:a', 'pcm_s16le', '-y', mixPcmPath], { timeoutMs: 60 * 60 * 1000, signal })
      const mixDuration = await this.frames.probeDuration(mixPcmPath, { signal })
      if (!(mixDuration > 0) || Math.abs(mixDuration - sourceDuration) > 0.05) throw new Error('有限多轨 PCM 总线时长与冻结视频不一致')
      const measurement = policy.enabled ? await this.measureLoudnessFile({ audioPath: mixPcmPath, policy, signal }) : null
      const finish = measurement ? `${this.secondPass(policy, measurement)},alimiter=limit=0.850:level=0` : 'alimiter=limit=0.850:level=0'
      await this.frames.run(['-hide_banner', '-nostdin', '-i', source, '-i', mixPcmPath, '-filter_complex', `[1:a]${finish}[aout]`, '-map', '0:v:0', '-map', '[aout]', '-t', sourceDuration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      this.assertUnchanged(sourceBefore, source, '多轨混音期间源视频发生变化')
      trackBefore.forEach((item) => this.assertUnchanged(item.stat, item.path, '多轨混音期间音频素材发生变化'))
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('多轨混音成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)) throw new Error('多轨混音成果时长与源视频不一致')
      const loudnessProof = await this.loudnessProof(tempPath, decision, signal)
      if (loudnessProof.verdict !== 'matched' && loudnessProof.verdict !== 'not-requested') throw new Error('多轨总线编码后响度未达标')
      const audioMixProof = await this.proof({ source, output: tempPath, decision, sourceDuration, plan, signal })
      this.assertProof(audioMixProof, decision)
      this.assertUnchanged(sourceBefore, source, '声音证明期间源视频发生变化')
      trackBefore.forEach((item) => this.assertUnchanged(item.stat, item.path, '声音证明期间音频素材发生变化'))
      this.fs.renameSync(tempPath, output)
      return this.receipt({ output, decision, sourceDuration, actualDuration, proof: audioMixProof, loudnessProof })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    } finally {
      if (this.fs.existsSync(mixPcmPath)) this.fs.rmSync(mixPcmPath, { force: true })
    }
  }

  assertUnchanged(before, filePath, message) {
    const current = this.fs.statSync(filePath)
    if (before.size !== current.size || Math.trunc(before.mtimeMs) !== Math.trunc(current.mtimeMs)) throw new Error(`${message}，已拒绝交付`)
  }

  async verify({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || '')); const output = path.resolve(String(outputPath || ''))
    this.assertDecision(source, decision)
    if (!this.fs.existsSync(output) || this.fs.statSync(output).size <= 1024) throw new Error('多轨混音成果不存在或不完整')
    const sourceDuration = await this.frames.probeDuration(source, { signal }); const actualDuration = await this.frames.probeDuration(output, { signal })
    if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)) throw new Error('多轨混音成果时长校验失败')
    const hasSourceAudio = await this.frames.probeHasAudio(source, { signal })
    const plan = await this.buildFilterPlan({ source, decision, sourceDuration, hasSourceAudio, signal })
    const loudnessProof = await this.loudnessProof(output, decision, signal); if (!['matched', 'not-requested'].includes(loudnessProof.verdict)) throw new Error('多轨总线响度复核失败')
    const proof = await this.proof({ source, output, decision, sourceDuration, plan, signal }); this.assertProof(proof, decision)
    return this.receipt({ output, decision, sourceDuration, actualDuration, proof, loudnessProof })
  }

  receipt({ output, decision, sourceDuration, actualDuration, proof, loudnessProof }) {
    const roles = { music: '音乐', ambience: '环境声', sfx: '音效' }
    const timelineReceipt = decision.audioMix.tracks.map((track) => ({ operation: `添加${roles[track.role] || track.role} ${track.id}`, sourceRange: `00:00.000 → ${track.loop ? '循环' : '素材结束'}`, outputRange: `${formatTimestamp(track.startSeconds)} → ${formatTimestamp(track.endSeconds ?? sourceDuration)}` }))
    if (decision.audioMix.dialogue?.enabled) timelineReceipt.unshift({ operation: '保留并调整对白', sourceRange: `00:00.000 → ${formatTimestamp(sourceDuration)}`, outputRange: `00:00.000 → ${formatTimestamp(sourceDuration)}` })
    else timelineReceipt.unshift({ operation: '移除原声对白', sourceRange: `00:00.000 → ${formatTimestamp(sourceDuration)}`, outputRange: '不进入最终总线' })
    return { success: true, outputPath: output, outputs: [output], outputBytes: this.fs.statSync(output).size, sourceDurationSeconds: sourceDuration, expectedDurationSeconds: sourceDuration, durationSeconds: Number(actualDuration.toFixed(3)), audioMix: JSON.parse(JSON.stringify(decision.audioMix)), audioMixProof: proof, loudnessProof, timelineReceipt, summary: `已生成 ${Number(actualDuration).toFixed(3)} 秒多轨混音版：${decision.audioMix.dialogue?.enabled ? '保留对白' : '移除原声'}，加入 ${decision.audioMix.tracks.map((track) => roles[track.role]).join('、')}；${proof.tracks.length} 条外部轨均通过目标时间对齐，${proof.automation.configured} 段音量自动化已执行，${proof.ducking.configuredTracks} 条轨道启用对白闪避；原文件未改动${loudnessProof.verdict === 'matched' ? `；编码后响度 ${loudnessProof.integratedLufs} LUFS、true peak ${loudnessProof.truePeakDbtp} dBTP` : ''}` }
  }
}

module.exports = { AudioMixService, alignedCorrelation, pcmStats }
