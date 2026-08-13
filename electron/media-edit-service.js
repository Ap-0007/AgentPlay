const fs = require('fs')
const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])

function formatTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000))
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  const fraction = milliseconds % 1000
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

class MediaEditService {
  constructor({ frames, fsImpl = fs } = {}) {
    if (!frames) throw new Error('媒体剪辑服务缺少 FFmpeg 执行器')
    this.frames = frames
    this.fs = fsImpl
  }

  async trim({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.trim') throw new Error('剪辑决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('剪辑决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')

    const { startSeconds, endSeconds, durationSeconds } = decision.timeline || {}
    if (![startSeconds, endSeconds, durationSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('剪辑时间范围无效')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    if (endSeconds > sourceDuration + 0.05) throw new Error(`结束时间 ${formatTimestamp(endSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)

    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-ss', Number(startSeconds).toFixed(3), '-t', Number(durationSeconds).toFixed(3),
        '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_chapters', '0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('剪辑期间源视频发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('剪辑成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - durationSeconds) > tolerance) {
        throw new Error(`剪辑成果时长校验失败：期望 ${durationSeconds.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      this.fs.renameSync(tempPath, output)
      return this.resultReceipt({ source, output, decision, sourceDuration, actualDuration })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  async verify({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!this.fs.existsSync(output) || !this.fs.statSync(output).isFile() || this.fs.statSync(output).size <= 1024) throw new Error('剪辑成果不存在或不完整')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    const actualDuration = await this.frames.probeDuration(output, { signal })
    const expectedDuration = Number(decision?.timeline?.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(decision?.verification?.toleranceSeconds) || 0.2)
    if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) throw new Error('剪辑成果时长校验失败')
    return this.resultReceipt({ source, output, decision, sourceDuration, actualDuration })
  }

  resultReceipt({ source, output, decision, sourceDuration, actualDuration }) {
    const { startSeconds, endSeconds, durationSeconds } = decision.timeline
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: durationSeconds,
      durationSeconds: Number(actualDuration.toFixed(3)),
      timelineReceipt: [{
        operation: '保留片段',
        sourceRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(endSeconds)}`,
        outputRange: `${formatTimestamp(0)} → ${formatTimestamp(durationSeconds)}`
      }],
      summary: `已保留 ${formatTimestamp(startSeconds)} 到 ${formatTimestamp(endSeconds)}，生成 ${durationSeconds.toFixed(3)} 秒新视频；原文件未改动`
    }
  }
}

module.exports = { MediaEditService, formatTimestamp }
