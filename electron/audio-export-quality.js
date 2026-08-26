const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function finite(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function rounded(value, digits = 3) { return Number(Number(value).toFixed(digits)) }

function parseSilenceLog(stderr, durationSeconds) {
  const duration = Math.max(0, finite(durationSeconds, 0))
  const events = String(stderr || '').split(/\r?\n/)
  const intervals = []
  let openStart = null
  for (const line of events) {
    const start = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/i)
    if (start) openStart = Math.max(0, finite(start[1], 0))
    const end = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/i)
    if (!end || openStart == null) continue
    const endSeconds = Math.max(openStart, Math.min(duration || Infinity, finite(end[1], openStart)))
    const position = openStart <= 0.05 ? 'leading' : duration > 0 && endSeconds >= duration - 0.05 ? 'trailing' : 'internal'
    intervals.push({ startSeconds: rounded(openStart), endSeconds: rounded(endSeconds), durationSeconds: rounded(endSeconds - openStart), position })
    openStart = null
  }
  if (openStart != null && duration > openStart) {
    const position = openStart <= 0.05 ? 'leading' : 'trailing'
    intervals.push({ startSeconds: rounded(openStart), endSeconds: rounded(duration), durationSeconds: rounded(duration - openStart), position })
  }
  const total = intervals.reduce((sum, item) => sum + item.durationSeconds, 0)
  return {
    intervals,
    totalSilenceSeconds: rounded(total),
    silenceRatio: duration > 0 ? rounded(total / duration, 4) : 0,
    maximumSilenceSeconds: rounded(intervals.reduce((maximum, item) => Math.max(maximum, item.durationSeconds), 0))
  }
}

function hashFile(filePath, { signal, fsImpl = fs } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('已取消'))
    const digest = crypto.createHash('sha256')
    let stream
    let ended = false
    let value = ''
    let settled = false
    const finish = (fn, result) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      fn(result)
    }
    const onAbort = () => {
      const error = new Error('已取消')
      if (stream && !stream.destroyed) stream.destroy(error)
      else finish(reject, error)
    }
    try { stream = fsImpl.createReadStream(filePath, { highWaterMark: 1024 * 1024 }) } catch (error) { finish(reject, error); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.once('error', (error) => finish(reject, signal?.aborted ? new Error('已取消') : error))
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('end', () => {
      ended = true
      value = digest.digest('hex')
      if (stream.closed) finish(resolve, value)
    })
    stream.once('close', () => ended ? finish(resolve, value) : finish(reject, new Error('版权来源哈希读取提前关闭')))
  })
}

class AudioExportQualityGate {
  constructor({ frames, fsImpl = fs, hashFileImpl = hashFile } = {}) {
    if (!frames) throw new Error('统一声音导出质量门缺少FFmpeg执行器')
    this.frames = frames
    this.fs = fsImpl
    this.hashFile = (filePath, options) => hashFileImpl(filePath, { ...options, fsImpl })
  }

  loudnessPolicy(decision = {}) {
    const raw = decision.audio?.loudness || decision.audioMix?.master?.loudness || decision.audioRepair?.loudness || null
    if (raw?.enabled === true) {
      const targetLufs = finite(raw.targetLufs, -16)
      const toleranceLufs = Math.max(0.2, finite(raw.toleranceLufs, 0.8))
      return {
        mode: 'frozen-target', targetLufs, toleranceLufs,
        minimumLufs: targetLufs - toleranceLufs,
        maximumLufs: targetLufs + toleranceLufs,
        maximumTruePeakDbtp: Math.min(-0.5, finite(raw.maxTruePeakDbtp, finite(raw.targetTruePeakDbtp, -1)))
      }
    }
    if (raw?.enabled === false) return { mode: 'explicit-no-normalization', minimumLufs: -70, maximumLufs: 0, maximumTruePeakDbtp: -0.5 }
    return { mode: 'professional-envelope', minimumLufs: -24, maximumLufs: -8, maximumTruePeakDbtp: -0.5 }
  }

  async silenceProof(filePath, durationSeconds, signal) {
    const result = await this.frames.run([
      '-hide_banner', '-nostdin', '-i', filePath, '-map', '0:a:0', '-vn',
      '-af', 'silencedetect=noise=-60dB:d=0.5', '-f', 'null', '-'
    ], { timeoutMs: Math.max(60000, Math.min(30 * 60 * 1000, Number(durationSeconds || 0) * 1500)), signal })
    return parseSilenceLog(result.stderr, durationSeconds)
  }

  async copyrightProof(externalAudioPaths, signal) {
    const sources = []
    for (const input of Array.isArray(externalAudioPaths) ? externalAudioPaths : []) {
      const audioPath = path.resolve(String(input?.path || input || ''))
      const role = String(input?.role || 'audio')
      if (!audioPath || !this.fs.existsSync(audioPath) || !this.fs.statSync(audioPath).isFile()) throw new Error(`版权来源音频不存在：${path.basename(audioPath) || '未知文件'}`)
      const receiptPath = `${audioPath}.license.json`
      if (!this.fs.existsSync(receiptPath)) {
        if (audioPath.toLowerCase().includes(`${path.sep}agentplay 授权音乐${path.sep}`.toLowerCase())) throw new Error(`授权音乐缺少许可凭证：${path.basename(audioPath)}`)
        sources.push({ fileName: path.basename(audioPath), role, status: 'user-supplied-unverified', requiresUserResponsibility: true })
        continue
      }
      let receipt
      try { receipt = JSON.parse(this.fs.readFileSync(receiptPath, 'utf8')) } catch { throw new Error(`许可凭证无法解析：${path.basename(receiptPath)}`) }
      if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'agentplay.licensed-music-receipt') throw new Error(`许可凭证格式无效：${path.basename(receiptPath)}`)
      if (receipt.usageScope?.commercialUse !== true || receipt.usageScope?.adaptationAllowed !== true || receipt.usageScope?.videoSyncAllowed !== true || receipt.usageScope?.shareAlike === true) throw new Error(`许可凭证不允许商业视频改编：${path.basename(audioPath)}`)
      if ('outputPath' in (receipt.file || {}) || /[A-Za-z]:\\/.test(JSON.stringify(receipt.file || {}))) throw new Error(`许可凭证包含不应外泄的绝对路径：${path.basename(receiptPath)}`)
      const actualHash = await this.hashFile(audioPath, { signal })
      if (!/^[a-f0-9]{64}$/i.test(String(receipt.file?.sha256 || '')) || actualHash.toLowerCase() !== String(receipt.file.sha256).toLowerCase()) throw new Error(`版权来源音频哈希与许可凭证不一致：${path.basename(audioPath)}`)
      if (Number(receipt.file?.bytes) > 0 && Number(receipt.file.bytes) !== this.fs.statSync(audioPath).size) throw new Error(`版权来源音频字节数与许可凭证不一致：${path.basename(audioPath)}`)
      sources.push({
        fileName: path.basename(audioPath), role, status: 'verified-open-license', requiresUserResponsibility: false,
        licenseId: String(receipt.license?.id || ''), licenseUrl: String(receipt.license?.url || ''),
        track: String(receipt.track?.title || path.basename(audioPath)), performer: String(receipt.recording?.performer || ''),
        sourcePageUrl: String(receipt.provider?.sourcePageUrl || ''), sha256: actualHash, receiptAbsolutePathOmitted: true
      })
    }
    return { verdict: 'documented', sources: sources.length ? sources : [{ status: 'source-contained', requiresUserResponsibility: false }] }
  }

  async audit({ sourcePath, outputPath, decision = {}, externalAudioPaths = [], signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || !this.fs.statSync(output).isFile()) throw new Error('统一声音导出质量门找不到成片')
    if (!(await this.frames.probeHasAudio(output, { signal }))) throw new Error('统一声音导出质量门：成片没有音轨')
    const [levels, loudness, timing] = await Promise.all([
      this.frames.probeAudioLevels(output, { signal }),
      this.frames.probeLoudness(output, { signal }),
      this.frames.probeStreamTiming(output, { signal })
    ])
    if (!levels || !loudness || !timing?.audio || !timing?.video) throw new Error('统一声音导出质量门：削波、响度或声画时序证据不可用')
    const policy = this.loudnessPolicy(decision)
    const samplePeakDbfs = finite(levels.samplePeakDbfs, 0)
    const truePeakDbtp = finite(loudness.truePeakDbtp, 0)
    const clippingMatched = samplePeakDbfs < -0.01 && truePeakDbtp <= policy.maximumTruePeakDbtp
    const clipping = { verdict: clippingMatched ? 'matched' : 'mismatch', samplePeakDbfs, truePeakDbtp, maximumTruePeakDbtp: policy.maximumTruePeakDbtp }
    if (!clippingMatched) throw new Error(`统一声音导出质量门：检测到削波或true peak超限（${truePeakDbtp} dBTP）`)
    const integratedLufs = finite(loudness.integratedLufs, -Infinity)
    const loudnessMatched = integratedLufs >= policy.minimumLufs && integratedLufs <= policy.maximumLufs
    const loudnessVerdict = loudnessMatched ? policy.mode === 'explicit-no-normalization' ? 'matched-user-policy' : 'matched' : 'mismatch'
    const loudnessProof = { verdict: loudnessVerdict, integratedLufs, truePeakDbtp, policy, withinProfessionalEnvelope: integratedLufs >= -24 && integratedLufs <= -8 }
    if (!loudnessMatched) throw new Error(`统一声音导出质量门：编码后响度 ${integratedLufs} LUFS 超出 ${policy.minimumLufs}–${policy.maximumLufs} LUFS`)
    const startDeltaSeconds = Math.abs(Number(timing.audio.startSeconds) - Number(timing.video.startSeconds))
    const endDeltaSeconds = Math.abs(Number(timing.audio.endSeconds) - Number(timing.video.endSeconds))
    const syncMatched = startDeltaSeconds <= 0.1 && endDeltaSeconds <= 0.25
    const avSync = { verdict: syncMatched ? 'matched' : 'mismatch', startDeltaSeconds: rounded(startDeltaSeconds), endDeltaSeconds: rounded(endDeltaSeconds), maximumStartDeltaSeconds: 0.1, maximumEndDeltaSeconds: 0.25 }
    if (!syncMatched) throw new Error(`统一声音导出质量门：声画同步偏差超限（起点${rounded(startDeltaSeconds)}秒、终点${rounded(endDeltaSeconds)}秒）`)
    const outputSilence = await this.silenceProof(output, timing.durationSeconds, signal)
    let sourceSilence = null
    if (source && this.fs.existsSync(source) && await this.frames.probeHasAudio(source, { signal })) {
      const sourceDuration = await this.frames.probeDuration(source, { signal })
      sourceSilence = await this.silenceProof(source, sourceDuration, signal)
    }
    const withinEnvelope = outputSilence.maximumSilenceSeconds <= 2 && outputSilence.silenceRatio <= 0.35
    const matchesSource = sourceSilence && outputSilence.maximumSilenceSeconds <= sourceSilence.maximumSilenceSeconds + 0.6 && outputSilence.silenceRatio <= sourceSilence.silenceRatio + 0.1
    const plannedTrailing = decision?.kind === 'media.add-music' && decision.audio?.loop === false && outputSilence.intervals.every((item) => item.position === 'trailing')
    const silenceMatched = withinEnvelope || matchesSource || plannedTrailing
    const silence = {
      verdict: withinEnvelope ? 'matched' : matchesSource ? 'matched-source-baseline' : plannedTrailing ? 'matched-planned-tail' : 'mismatch',
      ...outputSilence,
      ...(sourceSilence ? { sourceBaseline: sourceSilence } : {}),
      thresholds: { maximumUnexpectedSilenceSeconds: 2, maximumUnexpectedSilenceRatio: 0.35 }
    }
    if (!silenceMatched) throw new Error(`统一声音导出质量门：发现新增异常静音（最长${outputSilence.maximumSilenceSeconds}秒，占比${outputSilence.silenceRatio}）`)
    const copyright = await this.copyrightProof(externalAudioPaths, signal)
    return {
      schemaVersion: 1,
      method: 'unified-audio-export-qc-v1',
      verdict: 'matched',
      clipping,
      loudness: loudnessProof,
      avSync,
      silence,
      copyright
    }
  }
}

module.exports = { AudioExportQualityGate, hashFile, parseSilenceLog }
