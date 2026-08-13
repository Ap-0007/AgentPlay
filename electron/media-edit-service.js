const fs = require('fs')
const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const MAX_EDIT_SEGMENTS = 24

function formatTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000))
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const seconds = Math.floor((milliseconds % 60000) / 1000)
  const fraction = milliseconds % 1000
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : ''
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

function validateConcatTimeline(decision) {
  const segments = Array.isArray(decision?.timeline?.segments) ? decision.timeline.segments : []
  const expectedDuration = Number(decision?.timeline?.durationSeconds)
  if (segments.length < 2 || segments.length > MAX_EDIT_SEGMENTS || !Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error('拼接时间线无效')
  let targetCursor = 0
  for (const segment of segments) {
    const start = Number(segment?.sourceStartSeconds)
    const end = Number(segment?.sourceEndSeconds)
    const duration = Number(segment?.durationSeconds)
    const targetStart = Number(segment?.targetStartSeconds)
    const targetEnd = Number(segment?.targetEndSeconds)
    if (![start, end, duration, targetStart, targetEnd].every(Number.isFinite)
      || start < 0 || end <= start
      || Math.abs(duration - (end - start)) > 0.001
      || Math.abs(targetStart - targetCursor) > 0.001
      || Math.abs(targetEnd - (targetStart + duration)) > 0.001) throw new Error('拼接时间线无效')
    targetCursor = targetEnd
  }
  if (Math.abs(targetCursor - expectedDuration) > 0.001) throw new Error('拼接时间线总时长不一致')
  return { segments, expectedDuration }
}

function assertSegmentsWithinSource(segments, sourceDuration) {
  const outOfRange = segments.find((segment) => Number(segment.sourceEndSeconds) > sourceDuration + 0.05)
  if (outOfRange) throw new Error(`结束时间 ${formatTimestamp(outOfRange.sourceEndSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)
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

  async removeSegment({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.remove-segment') throw new Error('删除片段决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('删除片段决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const { startSeconds, endSeconds, removedDurationSeconds } = decision.timeline || {}
    if (![startSeconds, endSeconds, removedDurationSeconds].every(Number.isFinite) || startSeconds < 0 || endSeconds <= startSeconds) throw new Error('删除时间范围无效')
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    if (endSeconds > sourceDuration + 0.05) throw new Error(`结束时间 ${formatTimestamp(endSeconds)} 超出源视频时长 ${formatTimestamp(sourceDuration)}`)
    const expectedDuration = Number((sourceDuration - removedDurationSeconds).toFixed(3))
    if (!(expectedDuration > 0.05)) throw new Error('不能删除整段视频；请至少保留一段内容')
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    const retained = []
    if (startSeconds > 0.001) retained.push({ start: 0, end: startSeconds })
    if (endSeconds < sourceDuration - 0.001) retained.push({ start: endSeconds, end: null })
    if (!retained.length) throw new Error('不能删除整段视频；请至少保留一段内容')

    const videoParts = retained.map((segment, index) => `[0:v:0]trim=start=${segment.start.toFixed(3)}${segment.end == null ? '' : `:end=${segment.end.toFixed(3)}`},setpts=PTS-STARTPTS[v${index}]`)
    const audioParts = hasAudio
      ? retained.map((segment, index) => `[0:a:0]atrim=start=${segment.start.toFixed(3)}${segment.end == null ? '' : `:end=${segment.end.toFixed(3)}`},asetpts=PTS-STARTPTS[a${index}]`)
      : []
    const videoJoin = retained.length === 1
      ? `[v0]pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
      : `${retained.map((_, index) => `[v${index}]`).join('')}concat=n=${retained.length}:v=1:a=0,pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
    const audioJoin = hasAudio
      ? (retained.length === 1 ? '[a0]anull[aout]' : `${retained.map((_, index) => `[a${index}]`).join('')}concat=n=${retained.length}:v=0:a=1[aout]`)
      : ''
    const filter = [...videoParts, ...audioParts, videoJoin, audioJoin].filter(Boolean).join(';')
    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-filter_complex', filter,
        '-map', '[vout]', ...(hasAudio ? ['-map', '[aout]'] : ['-an']),
        '-map_metadata', '0', '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('剪辑期间源视频发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('删除片段后的成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`删除片段后的时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      this.fs.renameSync(tempPath, output)
      return this.removeReceipt({ source, output, decision, sourceDuration, expectedDuration, actualDuration })
    } catch (error) {
      if (this.fs.existsSync(tempPath)) this.fs.rmSync(tempPath, { force: true })
      throw error
    }
  }

  async concatSegments({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-segments') throw new Error('拼接片段决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('拼接片段决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const { segments, expectedDuration } = validateConcatTimeline(decision)
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    assertSegmentsWithinSource(segments, sourceDuration)
    const hasAudio = await this.frames.probeHasAudio(source, { signal })
    const videoParts = segments.map((segment, index) => `[0:v:0]trim=start=${Number(segment.sourceStartSeconds).toFixed(3)}:end=${Number(segment.sourceEndSeconds).toFixed(3)},setpts=PTS-STARTPTS[v${index}]`)
    const audioParts = hasAudio
      ? segments.map((segment, index) => `[0:a:0]atrim=start=${Number(segment.sourceStartSeconds).toFixed(3)}:end=${Number(segment.sourceEndSeconds).toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`)
      : []
    const videoJoin = `${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0,pad=ceil(iw/2)*2:ceil(ih/2)*2[vout]`
    const audioJoin = hasAudio ? `${segments.map((_, index) => `[a${index}]`).join('')}concat=n=${segments.length}:v=0:a=1[aout]` : ''
    const filter = [...videoParts, ...audioParts, videoJoin, audioJoin].filter(Boolean).join(';')
    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin', '-i', source,
        '-filter_complex', filter,
        '-map', '[vout]', ...(hasAudio ? ['-map', '[aout]'] : ['-an']),
        '-map_metadata', '0', '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('剪辑期间源视频发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('拼接片段后的成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`拼接片段后的时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      this.fs.renameSync(tempPath, output)
      return this.concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration })
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
    const isRemove = decision?.kind === 'media.remove-segment'
    const isConcat = decision?.kind === 'media.concat-segments'
    const concatTimeline = isConcat ? validateConcatTimeline(decision) : null
    if (concatTimeline) assertSegmentsWithinSource(concatTimeline.segments, sourceDuration)
    const expectedDuration = isRemove
      ? Number((sourceDuration - Number(decision?.timeline?.removedDurationSeconds || 0)).toFixed(3))
      : isConcat ? concatTimeline.expectedDuration : Number(decision?.timeline?.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(decision?.verification?.toleranceSeconds) || 0.2)
    if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) throw new Error('剪辑成果时长校验失败')
    return isRemove
      ? this.removeReceipt({ source, output, decision, sourceDuration, expectedDuration, actualDuration })
      : isConcat
        ? this.concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration })
      : this.resultReceipt({ source, output, decision, sourceDuration, actualDuration })
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

  removeReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration }) {
    const { startSeconds, endSeconds } = decision.timeline
    const receipt = [{
      operation: '删除片段',
      sourceRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(endSeconds)}`,
      outputRange: '未进入成片'
    }]
    if (startSeconds > 0.001) receipt.push({
      operation: '保留片段',
      sourceRange: `${formatTimestamp(0)} → ${formatTimestamp(startSeconds)}`,
      outputRange: `${formatTimestamp(0)} → ${formatTimestamp(startSeconds)}`
    })
    if (endSeconds < sourceDuration - 0.001) receipt.push({
      operation: '保留片段',
      sourceRange: `${formatTimestamp(endSeconds)} → ${formatTimestamp(sourceDuration)}`,
      outputRange: `${formatTimestamp(startSeconds)} → ${formatTimestamp(expectedDuration)}`
    })
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      timelineReceipt: receipt,
      summary: `已删除 ${formatTimestamp(startSeconds)} 到 ${formatTimestamp(endSeconds)}，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件未改动`
    }
  }

  concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration }) {
    const segments = decision.timeline.segments
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      sourceDurationSeconds: sourceDuration,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      timelineReceipt: segments.map((segment, index) => ({
        operation: `拼接片段 ${index + 1}`,
        sourceRange: `${formatTimestamp(segment.sourceStartSeconds)} → ${formatTimestamp(segment.sourceEndSeconds)}`,
        outputRange: `${formatTimestamp(segment.targetStartSeconds)} → ${formatTimestamp(segment.targetEndSeconds)}`
      })),
      summary: `已按指定顺序拼接 ${segments.length} 个片段，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件未改动`
    }
  }
}

module.exports = { MediaEditService, formatTimestamp }
