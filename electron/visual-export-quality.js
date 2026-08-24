const path = require('path')

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0 }
function meanAbsDiff(left, right) { if (!left || !right || left.length !== right.length || !left.length) return 255; let sum = 0; for (let index = 0; index < left.length; index += 1) sum += Math.abs(left[index] - right[index]); return sum / left.length }

function parseRate(value) {
  const [left, right] = String(value || '').split('/').map(Number)
  return right > 0 ? left / right : Number(left) || 0
}

function aspectValue(value) {
  const [left, right] = String(value || '').replace('：', ':').split(':').map(Number)
  return right > 0 ? left / right : 0
}

function bandAverage(frame, width, height, x0, y0, x1, y1) {
  let sum = 0; let count = 0
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += frame[y * width + x]; count += 1 }
  return count ? sum / count : 0
}

function sampleVisualMetrics(buffer, width, height, fps = 2) {
  const frameSize = width * height; const frames = []
  for (let offset = 0; offset + frameSize <= buffer.length; offset += frameSize) frames.push(buffer.subarray(offset, offset + frameSize))
  let blackFrames = 0; let barFrames = 0; let longestFreezeFrames = 0; let currentFreezeFrames = 0
  const bandX = Math.max(2, Math.round(width * 0.06)); const bandY = Math.max(2, Math.round(height * 0.06))
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]; const fullMean = average(frame)
    if (fullMean < 12) blackFrames += 1
    const center = bandAverage(frame, width, height, bandX, bandY, width - bandX, height - bandY)
    const top = bandAverage(frame, width, height, 0, 0, width, bandY); const bottom = bandAverage(frame, width, height, 0, height - bandY, width, height)
    const left = bandAverage(frame, width, height, 0, 0, bandX, height); const right = bandAverage(frame, width, height, width - bandX, 0, width, height)
    if (center > 35 && ((top < 18 && bottom < 18) || (left < 18 && right < 18))) barFrames += 1
    if (index > 0 && meanAbsDiff(frames[index - 1], frame) < 0.15) { currentFreezeFrames += 1; longestFreezeFrames = Math.max(longestFreezeFrames, currentFreezeFrames) } else currentFreezeFrames = 0
  }
  return { sampleCount: frames.length, blackFrames, blackRatio: frames.length ? Number((blackFrames / frames.length).toFixed(3)) : 0, barFrames, barRatio: frames.length ? Number((barFrames / frames.length).toFixed(3)) : 0, longestFreezeSeconds: Number((longestFreezeFrames / fps).toFixed(3)), nonBlackFrames: frames.length - blackFrames }
}

class VisualExportQualityGate {
  constructor({ frames } = {}) { this.frames = frames }

  probeJson(filePath, signal) {
    return new Promise((resolve, reject) => {
      const child = this.frames.spawnImpl(this.frames.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,pix_fmt,width,height,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate', '-of', 'json', filePath], { windowsHide: true, shell: false })
      let stdout = ''; let stderr = ''; let settled = false
      const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener('abort', onAbort); fn(value) }
      const onAbort = () => { try { child.kill() } catch {}; finish(reject, new Error('已取消')) }
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }) }
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') }); child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => finish(reject, error)); child.once('exit', (code) => { if (code !== 0) return finish(reject, new Error(stderr || 'ffprobe失败')); try { finish(resolve, JSON.parse(stdout)) } catch { finish(reject, new Error('ffprobe结果无效')) } })
    })
  }

  async inspectFile(filePath, { signal, decode = true } = {}) {
    const resolved = path.resolve(String(filePath || ''))
    const probe = await this.probeJson(resolved, signal)
    const video = (probe.streams || []).find((item) => item.codec_type === 'video')
    if (!video) throw new Error('成果没有视频流')
    const width = Number(video.width); const height = Number(video.height); const durationSeconds = Number(probe.format?.duration) || 0; const sampleFps = 2
    const scaledWidth = 160; const scaledHeight = Math.max(2, Math.round(height * scaledWidth / width / 2) * 2)
    const raw = await this.frames.readRawFrameBuffer(['-v', 'error', '-i', resolved, '-vf', `fps=${sampleFps},scale=${scaledWidth}:${scaledHeight},format=gray`, '-frames:v', '60', '-f', 'rawvideo', '-'], { signal })
    const visual = sampleVisualMetrics(raw || Buffer.alloc(0), scaledWidth, scaledHeight, sampleFps)
    let decodePassed = true; let decodeError = ''
    if (decode) {
      try { await this.frames.run(['-v', 'error', '-i', resolved, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: Math.max(120000, Math.min(20 * 60 * 1000, durationSeconds * 1200)), signal }) } catch (error) { decodePassed = false; decodeError = error instanceof Error ? error.message : String(error) }
    }
    return { path: resolved, bytes: 0, width, height, aspect: height > 0 ? Number((width / height).toFixed(6)) : 0, durationSeconds, codec: String(video.codec_name || ''), pixelFormat: String(video.pix_fmt || ''), sampleAspectRatio: String(video.sample_aspect_ratio || ''), displayAspectRatio: String(video.display_aspect_ratio || ''), frameRate: Number(parseRate(video.avg_frame_rate).toFixed(3)), decodePassed, decodeError, ...visual }
  }

  async inspect({ sourcePath = '', artifacts = [], profile = 'visual-export', signal } = {}) {
    const baseline = sourcePath ? await this.inspectFile(sourcePath, { signal, decode: false }) : { blackFrames: 0, blackRatio: 0, barRatio: 0, longestFreezeSeconds: 0 }
    const results = []; const failures = []
    for (const artifact of artifacts) {
      let metrics
      try { metrics = await this.inspectFile(artifact.path, { signal }) } catch (error) {
        failures.push({ code: 'DECODE_FAILED', role: artifact.role, message: error instanceof Error ? error.message : String(error) }); continue
      }
      const expected = artifact.expectedDimensions || null; const expectedAspect = aspectValue(artifact.expectedAspect) || (expected ? Number(expected.width) / Number(expected.height) : 0)
      if (expected && (metrics.width !== Number(expected.width) || metrics.height !== Number(expected.height))) failures.push({ code: 'DIMENSION_MISMATCH', role: artifact.role, message: `期望${expected.width}×${expected.height}，实际${metrics.width}×${metrics.height}` })
      if (expectedAspect && Math.abs(metrics.aspect - expectedAspect) > 0.01) failures.push({ code: 'ASPECT_MISMATCH', role: artifact.role, message: `目标比例${artifact.expectedAspect || expectedAspect.toFixed(3)}，实际${metrics.aspect.toFixed(3)}` })
      if (metrics.codec !== 'h264') failures.push({ code: 'UNSUPPORTED_VIDEO_CODEC', role: artifact.role, message: `视频编码为${metrics.codec || '未知'}，要求H.264` })
      if (metrics.pixelFormat !== 'yuv420p') failures.push({ code: 'UNSUPPORTED_PIXEL_FORMAT', role: artifact.role, message: `像素格式为${metrics.pixelFormat || '未知'}，要求yuv420p` })
      if (!['1:1', '1/1'].includes(metrics.sampleAspectRatio)) failures.push({ code: 'INVALID_SAMPLE_ASPECT_RATIO', role: artifact.role, message: `SAR为${metrics.sampleAspectRatio || '未知'}，要求1:1` })
      if (!metrics.decodePassed || metrics.sampleCount < 2 || metrics.nonBlackFrames < 1) failures.push({ code: 'DECODE_FAILED', role: artifact.role, message: metrics.decodeError || '完整解码或画面采样失败' })
      if (metrics.blackFrames > Number(baseline.blackFrames || 0) + 1 && metrics.blackRatio > Number(baseline.blackRatio || 0) + 0.15) failures.push({ code: 'NEW_BLACK_FRAMES', role: artifact.role, message: `新增黑帧采样${metrics.blackFrames}个，源片${baseline.blackFrames || 0}个` })
      if (!artifact.allowBlackBars && metrics.barRatio >= 0.7 && metrics.barRatio > Number(baseline.barRatio || 0) + 0.2) failures.push({ code: 'UNEXPECTED_BLACK_BARS', role: artifact.role, message: `新增黑边覆盖${Math.round(metrics.barRatio * 100)}%采样帧` })
      if (!artifact.allowFreeze && metrics.longestFreezeSeconds > Math.max(2, Number(baseline.longestFreezeSeconds || 0) + 0.75)) failures.push({ code: 'NEW_LONG_FREEZE', role: artifact.role, message: `新增长冻结${metrics.longestFreezeSeconds.toFixed(2)}秒` })
      results.push({ role: artifact.role, allowBlackBars: Boolean(artifact.allowBlackBars), expectedDimensions: expected, expectedAspect: artifact.expectedAspect || '', ...metrics })
    }
    return { schemaVersion: 1, strategy: 'unified-visual-export-qc-v1', profile, sourceBaseline: { blackFrames: baseline.blackFrames, blackRatio: baseline.blackRatio, barRatio: baseline.barRatio, longestFreezeSeconds: baseline.longestFreezeSeconds }, artifacts: results, failures, passed: failures.length === 0 }
  }
}

module.exports = { VisualExportQualityGate, aspectValue, sampleVisualMetrics }
