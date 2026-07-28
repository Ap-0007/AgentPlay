// 视频关键帧服务：镜头切换感知抽帧 + 16x16 灰度去重 + 时长帧预算。
// 参照 claude-video 的配方：scene-change 优先、产出不足退回均匀采样；去重与上一张"保留"帧比亮度均值差。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const SCENE_THRESHOLD = 0.3
const FRAME_WIDTH = 512
const THUMB = 16
const DEDUP_THRESHOLD = 2.0
const MAX_FRAMES = 40

// 帧预算：短视密、长视稀，硬顶 MAX_FRAMES（一次视觉请求的图片上限）
function frameBudget(durationSec) {
  const d = Number(durationSec) || 0
  if (d <= 30) return 24
  if (d <= 60) return 32
  return MAX_FRAMES
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

// 两个等长 Buffer 的逐字节平均绝对差（0-255），用于灰度缩略图相似度
function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 255
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

// 去重：与上一张"保留"帧比较（能抓住渐变），小于等于阈值视为重复丢弃；始终保留第一张
function dedupeThumbs(thumbs, threshold = DEDUP_THRESHOLD) {
  const keep = []
  let lastKept = -1
  for (let i = 0; i < thumbs.length; i++) {
    if (lastKept < 0 || meanAbsDiff(thumbs[i], thumbs[lastKept]) > threshold) {
      keep.push(i)
      lastKept = i
    }
  }
  return keep
}

// 超预算均匀稀疏化：保头保尾、覆盖全片
function thinToBudget(indices, budget) {
  if (indices.length <= budget) return indices
  const out = []
  const step = (indices.length - 1) / (budget - 1)
  for (let i = 0; i < budget; i++) out.push(indices[Math.round(i * step)])
  return [...new Set(out)]
}

class VideoFrameService {
  constructor({ ffmpegPath, ffprobePath, spawnImpl } = {}) {
    this.ffmpegPath = ffmpegPath ? path.resolve(ffmpegPath) : ''
    this.ffprobePath = ffprobePath ? path.resolve(ffprobePath) : ''
    this.spawnImpl = spawnImpl || spawn
  }

  availability() {
    return { available: Boolean(this.ffmpegPath && fs.existsSync(this.ffmpegPath)) }
  }

  run(args, { timeoutMs = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.ffmpegPath, args, { windowsHide: true, shell: false })
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('ffmpeg 执行超时'))
      }, timeoutMs)
      const finish = (fn, value) => {
        if (finish.done) return
        finish.done = true
        clearTimeout(timer)
        fn(value)
      }
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.once('error', (error) => finish(reject, error))
      child.once('exit', (code) => {
        if (code === 0) finish(resolve, { stderr })
        else finish(reject, new Error(stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg 退出码 ${code}`))
      })
    })
  }

  async probeDuration(sourcePath) {
    if (!this.ffprobePath || !fs.existsSync(this.ffprobePath)) return 0
    try {
      const child = this.spawnImpl(this.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', sourcePath], { windowsHide: true, shell: false })
      let out = ''
      await new Promise((resolve) => {
        child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
        child.once('error', resolve)
        child.once('exit', resolve)
      })
      return Number.parseFloat(out.trim()) || 0
    } catch {
      return 0
    }
  }

  // 抽取关键帧：scene-change 优先，产出不足退回均匀采样；返回 [{ path, tSec, label }]
  async extract({ sourcePath, durationSec = 0, outDir, budget } = {}) {
    if (!this.availability().available) return []
    if (!sourcePath || !fs.existsSync(sourcePath)) return []
    const duration = Number(durationSec) > 0 ? Number(durationSec) : await this.probeDuration(sourcePath)
    const cap = Math.min(Number(budget) > 0 ? Number(budget) : frameBudget(duration), MAX_FRAMES)
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })

    // 第一遍：镜头切换帧（showinfo 在 select 之后，pts_time 与落盘文件一一对应）
    const sceneFilter = `select='gt(scene,${SCENE_THRESHOLD})',showinfo,scale=${FRAME_WIDTH}:-2`
    const { stderr } = await this.run([
      '-hide_banner', '-nostdin', '-i', sourcePath,
      '-vf', sceneFilter, '-fps_mode', 'vfr', '-frames:v', String(cap * 3), '-q:v', '4',
      path.join(outDir, 'f%04d.jpg')
    ])
    const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number.parseFloat(m[1]))
    let files = fs.readdirSync(outDir).filter((name) => name.endsWith('.jpg')).sort()

    // 镜头切换帧太少（谈话头/幻灯片）→ 均匀采样兜底，时间戳按 fps 推导
    const minUseful = Math.min(8, Math.max(3, Math.ceil((duration || 60) / 20)))
    let usedUniform = false
    if (files.length < minUseful && duration > 0) {
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.mkdirSync(outDir, { recursive: true })
      const fps = cap / duration
      await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-vf', `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH}:-2`, '-frames:v', String(cap), '-q:v', '4',
        path.join(outDir, 'f%04d.jpg')
      ])
      times.length = 0
      files = fs.readdirSync(outDir).filter((name) => name.endsWith('.jpg')).sort()
      for (let i = 0; i < files.length; i++) times.push(i / fps)
      usedUniform = true
    }
    if (!files.length) return []

    // 第二遍：同滤镜 16x16 灰度缩略图做去重（同一输入同一 select，帧序确定一致）
    let thumbs = []
    try {
      const thumbFilter = usedUniform
        ? `fps=${(cap / duration).toFixed(4)},scale=${THUMB}:${THUMB},format=gray`
        : `select='gt(scene,${SCENE_THRESHOLD})',scale=${THUMB}:${THUMB},format=gray`
      const rawPath = path.join(outDir, 'thumbs.raw')
      await this.run(['-hide_banner', '-nostdin', '-i', sourcePath, '-vf', thumbFilter, '-frames:v', String(files.length), '-f', 'rawvideo', rawPath])
      const raw = fs.readFileSync(rawPath)
      const size = THUMB * THUMB
      for (let offset = 0; offset + size <= raw.length && thumbs.length < files.length; offset += size) {
        thumbs.push(raw.subarray(offset, offset + size))
      }
    } catch { /* 缩略图失败则跳过去重 */ }

    let keep = files.map((_, i) => i)
    if (thumbs.length === files.length) keep = thinToBudget(dedupeThumbs(thumbs), cap)
    else keep = thinToBudget(keep, cap)
    const keepSet = new Set(keep)
    for (let i = 0; i < files.length; i++) {
      if (!keepSet.has(i)) {
        try { fs.unlinkSync(path.join(outDir, files[i])) } catch { /* 忽略 */ }
      }
    }
    return keep.map((i) => {
      const tSec = Number.isFinite(times[i]) ? times[i] : Math.round(((duration || files.length) * i) / files.length)
      return { path: path.join(outDir, files[i]), tSec, label: `t=${formatTimestamp(tSec)}` }
    })
  }
}

module.exports = {
  VideoFrameService,
  frameBudget,
  formatTimestamp,
  meanAbsDiff,
  dedupeThumbs,
  thinToBudget,
  MAX_FRAMES
}
