const fs = require('fs')
const path = require('path')

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.avi'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma'])
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

  // 配乐：用户本地/合法音乐 + 音量 + 淡入淡出 + 对白闪避（sidechain）；音乐短于视频自动循环。
  // 红线：不下载任何音乐；原视频不动；成果时长必须等于源视频时长。
  async addMusic({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.add-music') throw new Error('配乐决策无效')
    if (path.resolve(String(decision.source?.path || '')) !== source) throw new Error('配乐决策与源文件不一致')
    if (source === output) throw new Error('禁止覆盖源视频')
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error('当前文件不是受支持的视频格式')
    const audio = path.resolve(String(decision.audio?.path || ''))
    if (!AUDIO_EXTENSIONS.has(path.extname(audio).toLowerCase())) throw new Error('音乐文件格式不受支持（mp3/wav/m4a/aac/flac/ogg/wma）')
    if (!this.fs.existsSync(source) || !this.fs.statSync(source).isFile()) throw new Error('源视频不存在')
    if (!this.fs.existsSync(audio) || !this.fs.statSync(audio).isFile()) throw new Error(`音乐文件不存在：${audio}；请提供你已有的合法音乐文件`)
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认源视频音轨')

    const volume = Math.max(0.01, Math.min(1, Number(decision.audio?.volume) || 0.15))
    const fadeIn = Math.max(0, Math.min(10, Number(decision.audio?.fadeInSeconds) ?? 1))
    const fadeOut = Math.max(0, Math.min(10, Number(decision.audio?.fadeOutSeconds) ?? 1.5))
    const duck = decision.audio?.duck !== false
    const sourceDuration = await this.frames.probeDuration(source, { signal })
    if (!(sourceDuration > 0)) throw new Error('无法读取源视频时长')
    const dur = sourceDuration.toFixed(3)
    const fadeOutStart = Math.max(0, sourceDuration - fadeOut).toFixed(3)
    const hasAudio = await this.frames.probeHasAudio(source, { signal })

    // 有原声：原声为 key 做 sidechain 闪避；无原声：纯视频+音乐
    const musicChain = `[1:a]volume=${volume.toFixed(3)},afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart}:d=${fadeOut.toFixed(3)}`
    const filter = hasAudio
      ? (duck
        ? `[0:a]volume=1.0,asplit=2[voice][key];${musicChain}[mu];[mu][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`
        : `[0:a]volume=1.0[voice];${musicChain}[mu];[voice][mu]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`)
      : `${musicChain}[aout]`

    const sourceBefore = this.fs.statSync(source)
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin',
        '-i', source,
        ...(decision.audio?.loop !== false ? ['-stream_loop', '-1'] : []), '-i', audio,
        '-filter_complex', filter,
        '-map', '0:v:0', '-map', '[aout]', '-t', dur,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      const sourceAfter = this.fs.statSync(source)
      if (sourceBefore.size !== sourceAfter.size || Math.trunc(sourceBefore.mtimeMs) !== Math.trunc(sourceAfter.mtimeMs)) throw new Error('配乐期间源视频发生变化，已拒绝交付')
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('配乐成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.2)
      if (!(actualDuration > 0) || Math.abs(actualDuration - sourceDuration) > tolerance) {
        throw new Error(`配乐成果时长校验失败：期望 ${sourceDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      if (typeof this.frames.probeHasAudio === 'function' && !(await this.frames.probeHasAudio(tempPath, { signal }))) {
        throw new Error('配乐成果没有音轨，已拒绝交付')
      }
      this.fs.renameSync(tempPath, output)
      return {
        success: true,
        outputPath: output,
        outputs: [output],
        outputBytes: this.fs.statSync(output).size,
        sourceDurationSeconds: sourceDuration,
        expectedDurationSeconds: sourceDuration,
        durationSeconds: Number(actualDuration.toFixed(3)),
        music: { path: audio, volume, duck, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut },
        summary: `已生成 ${Number(actualDuration.toFixed(3)).toFixed(3)} 秒配乐版新视频（音乐音量 ${Math.round(volume * 100)}%${duck ? '，对白闪避' : ''}）；原文件未改动`
      }
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

  // 跨素材拼接：当前视频 + 用户指定的其它本地视频，按给定顺序拼成一个新视频。
  // 红线：所有原文件都不动；统一等比缩放+黑边居中到第一个素材的分辨率；无音轨的素材补等长静音。
  async concatSources({ sourcePath, outputPath, decision, signal } = {}) {
    const source = path.resolve(String(sourcePath || ''))
    const output = path.resolve(String(outputPath || ''))
    if (!decision || decision.schemaVersion !== 1 || decision.kind !== 'media.concat-sources') throw new Error('跨素材拼接决策无效')
    const sources = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => path.resolve(String(item?.path || '')))
    if (sources.length < 2 || sources.length > 20) throw new Error('跨素材拼接需要 2 到 20 个素材')
    if (sources[0] !== source) throw new Error('跨素材拼接决策与源视频不一致')
    if (new Set(sources.map((item) => item.toLowerCase())).size !== sources.length) throw new Error('拼接素材列表里有重复文件')
    if (sources.some((item) => item === output)) throw new Error('禁止覆盖源视频')
    for (const item of sources) {
      if (!VIDEO_EXTENSIONS.has(path.extname(item).toLowerCase())) throw new Error(`不是受支持的视频格式：${path.basename(item)}`)
      if (!this.fs.existsSync(item) || !this.fs.statSync(item).isFile()) throw new Error(`拼接素材不存在：${path.basename(item)}`)
    }
    if (this.fs.existsSync(output)) throw new Error('成果文件已存在，为避免覆盖已停止')
    if (!this.frames.availability().available) throw new Error('缺少 ffmpeg 组件')
    if (typeof this.frames.probeHasAudio !== 'function') throw new Error('无法确认素材音轨')
    if (typeof this.frames.probeDimensions !== 'function') throw new Error('无法确认素材分辨率')

    const probes = []
    for (const item of sources) {
      const duration = await this.frames.probeDuration(item, { signal })
      if (!(duration > 0)) throw new Error(`无法读取素材时长：${path.basename(item)}`)
      const hasAudio = await this.frames.probeHasAudio(item, { signal })
      const dimensions = await this.frames.probeDimensions(item, { signal })
      if (!(Number(dimensions?.width) > 0) || !(Number(dimensions?.height) > 0)) throw new Error(`无法读取素材分辨率：${path.basename(item)}`)
      probes.push({ duration, hasAudio, width: Number(dimensions.width), height: Number(dimensions.height) })
    }
    const expectedDuration = Number(probes.reduce((sum, item) => sum + item.duration, 0).toFixed(3))
    const targetWidth = Math.ceil(probes[0].width / 2) * 2
    const targetHeight = Math.ceil(probes[0].height / 2) * 2

    const videoParts = sources.map((_, index) => `[${index}:v:0]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`)
    const audioParts = sources.map((_, index) => probes[index].hasAudio
      ? `[${index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a${index}]`
      : `anullsrc=r=48000:cl=stereo:d=${probes[index].duration.toFixed(3)}[a${index}]`)
    const join = `${sources.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${sources.length}:v=1:a=1[vout][aout]`
    const filter = [...videoParts, ...audioParts, join].join(';')
    const sourcesBefore = sources.map((item) => this.fs.statSync(item))
    const parsed = path.parse(output)
    const tempPath = path.join(parsed.dir, `.${parsed.name}.agentplay-edit-${process.pid}-${Date.now()}${parsed.ext || '.mp4'}`)
    try {
      await this.frames.run([
        '-hide_banner', '-nostdin',
        ...sources.flatMap((item) => ['-i', item]),
        '-filter_complex', filter,
        '-map', '[vout]', '-map', '[aout]',
        '-map_chapters', '-1',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', tempPath
      ], { timeoutMs: 60 * 60 * 1000, signal })
      if (signal?.aborted) throw new Error('已取消')
      sources.forEach((item, index) => {
        const after = this.fs.statSync(item)
        if (sourcesBefore[index].size !== after.size || Math.trunc(sourcesBefore[index].mtimeMs) !== Math.trunc(after.mtimeMs)) throw new Error(`拼接期间素材发生变化，已拒绝交付：${path.basename(item)}`)
      })
      if (!this.fs.existsSync(tempPath) || this.fs.statSync(tempPath).size <= 1024) throw new Error('跨素材拼接成果为空或不完整')
      const actualDuration = await this.frames.probeDuration(tempPath, { signal })
      const tolerance = Math.max(0.05, Number(decision.verification?.toleranceSeconds) || 0.25)
      if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) {
        throw new Error(`跨素材拼接时长校验失败：期望 ${expectedDuration.toFixed(3)} 秒，实际 ${Number(actualDuration || 0).toFixed(3)} 秒`)
      }
      this.fs.renameSync(tempPath, output)
      return this.concatSourcesReceipt({ output, decision, probes, expectedDuration, actualDuration })
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
    const isConcatSources = decision?.kind === 'media.concat-sources'
    const concatTimeline = isConcat ? validateConcatTimeline(decision) : null
    if (concatTimeline) assertSegmentsWithinSource(concatTimeline.segments, sourceDuration)
    let concatSourcesProbes = null
    if (isConcatSources) {
      const others = (Array.isArray(decision.sources) ? decision.sources : []).slice(1)
      concatSourcesProbes = [{ duration: sourceDuration }]
      for (const item of others) {
        const duration = await this.frames.probeDuration(path.resolve(String(item?.path || '')), { signal })
        if (!(duration > 0)) throw new Error(`无法读取拼接素材时长：${path.basename(String(item?.path || ''))}`)
        concatSourcesProbes.push({ duration })
      }
    }
    const expectedDuration = isRemove
      ? Number((sourceDuration - Number(decision?.timeline?.removedDurationSeconds || 0)).toFixed(3))
      : isConcat ? concatTimeline.expectedDuration
        : isConcatSources ? Number(concatSourcesProbes.reduce((sum, item) => sum + item.duration, 0).toFixed(3))
          : Number(decision?.timeline?.durationSeconds || 0)
    const tolerance = Math.max(0.05, Number(decision?.verification?.toleranceSeconds) || 0.2)
    if (!(actualDuration > 0) || Math.abs(actualDuration - expectedDuration) > tolerance) throw new Error('剪辑成果时长校验失败')
    return isRemove
      ? this.removeReceipt({ source, output, decision, sourceDuration, expectedDuration, actualDuration })
      : isConcat
        ? this.concatReceipt({ output, decision, sourceDuration, expectedDuration, actualDuration })
        : isConcatSources
          ? this.concatSourcesReceipt({ output, decision, probes: concatSourcesProbes, expectedDuration, actualDuration })
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

  concatSourcesReceipt({ output, decision, probes, expectedDuration, actualDuration }) {
    const names = (Array.isArray(decision.sources) ? decision.sources : []).map((item) => String(item?.name || path.basename(String(item?.path || ''))))
    let cursor = 0
    const timelineReceipt = probes.map((probe, index) => {
      const start = cursor
      cursor = Number((cursor + probe.duration).toFixed(3))
      return {
        operation: `拼接素材 ${index + 1}（${names[index] || `素材${index + 1}`}）`,
        sourceRange: `${formatTimestamp(0)} → ${formatTimestamp(probe.duration)}`,
        outputRange: `${formatTimestamp(start)} → ${formatTimestamp(cursor)}`
      }
    })
    return {
      success: true,
      outputPath: output,
      outputs: [output],
      outputBytes: this.fs.statSync(output).size,
      expectedDurationSeconds: expectedDuration,
      durationSeconds: Number(actualDuration.toFixed(3)),
      timelineReceipt,
      summary: `已按顺序拼接 ${probes.length} 个素材，生成 ${expectedDuration.toFixed(3)} 秒新视频；原文件均未改动`
    }
  }
}

module.exports = { MediaEditService, formatTimestamp }
