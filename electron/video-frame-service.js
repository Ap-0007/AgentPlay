// 视频关键帧服务：镜头切换感知抽帧 + 16x16 灰度去重 + 时长帧预算。
// 参照 claude-video 的配方：scene-change 优先、产出不足退回均匀采样；去重与上一张"保留"帧比亮度均值差。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const SCENE_THRESHOLD = 0.3
const FRAME_WIDTH = 512
const THUMB = 16
const DEDUP_THRESHOLD = 2.0
const MAX_FRAMES = 20

// 帧预算：短视密、长视稀，硬顶 MAX_FRAMES。
// 注意图片是视觉请求的主要耗时来源：实测火山 Coding Plan 端点 30+ 张会拖到超时，20 以内稳妥。
function frameBudget(durationSec) {
  const d = Number(durationSec) || 0
  if (d <= 30) return 12
  if (d <= 60) return 16
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

  // 抽取关键帧：scene-change 优先，产出不足或去重塌缩都退均匀采样；返回 [{ path, tSec, label }]
  async extract({ sourcePath, durationSec = 0, outDir, budget } = {}) {
    if (!this.availability().available) return []
    if (!sourcePath || !fs.existsSync(sourcePath)) return []
    const duration = Number(durationSec) > 0 ? Number(durationSec) : await this.probeDuration(sourcePath)
    const cap = Math.min(Number(budget) > 0 ? Number(budget) : frameBudget(duration), MAX_FRAMES)

    const readFiles = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((name) => name.endsWith('.jpg')).sort() : [])
    const loadThumbs = async (vf, count) => {
      const rawPath = path.join(outDir, 'thumbs.raw')
      await this.run(['-hide_banner', '-nostdin', '-i', sourcePath, '-vf', vf, '-frames:v', String(count), '-f', 'rawvideo', rawPath])
      const raw = fs.readFileSync(rawPath)
      const size = THUMB * THUMB
      const thumbs = []
      for (let offset = 0; offset + size <= raw.length && thumbs.length < count; offset += size) {
        thumbs.push(raw.subarray(offset, offset + size))
      }
      return thumbs
    }

    // 第一遍：镜头切换帧（showinfo 在 select 之后，pts_time 与落盘文件一一对应）。
    // format=yuvj420p 必带：抖音等 HEVC 窄色域(tv range)片源会让 mjpeg 编码器初始化直接失败
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    let stderr = ''
    try {
      const result = await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo,scale=${FRAME_WIDTH}:-2,format=yuvj420p`,
        '-fps_mode', 'vfr', '-frames:v', String(cap * 3), '-q:v', '4',
        path.join(outDir, 'f%04d.jpg')
      ])
      stderr = result.stderr
    } catch { /* 场景抽帧硬失败也交给均匀采样兜底 */ }
    let times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number.parseFloat(m[1]))
    let files = readFiles()
    let thumbs = []
    if (files.length) {
      try { thumbs = await loadThumbs(`select='gt(scene,${SCENE_THRESHOLD})',scale=${THUMB}:${THUMB},format=gray`, files.length) } catch { thumbs = [] }
    }
    let keep = thumbs.length === files.length && files.length > 0 ? dedupeThumbs(thumbs) : files.map((_, i) => i)

    // scene 帧太少（谈话头/渐变/硬失败），或看似很多却被去重塌成个位数（噪点/闪动误触发场景切换）
    // → 均匀采样兜底，时间戳按 fps 推导；短视频两张有效帧即可，别为小片反复重抽
    const minUseful = duration <= 60 ? 2 : Math.min(8, Math.max(3, Math.ceil(duration / 20)))
    if (keep.length < minUseful && duration > 0) {
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.mkdirSync(outDir, { recursive: true })
      const fps = cap / duration
      await this.run([
        '-hide_banner', '-nostdin', '-i', sourcePath,
        '-vf', `fps=${fps.toFixed(4)},scale=${FRAME_WIDTH}:-2,format=yuvj420p`, '-frames:v', String(cap), '-q:v', '4',
        path.join(outDir, 'f%04d.jpg')
      ])
      files = readFiles()
      times = files.map((_, i) => i / fps)
      thumbs = []
      if (files.length) {
        try { thumbs = await loadThumbs(`fps=${fps.toFixed(4)},scale=${THUMB}:${THUMB},format=gray`, files.length) } catch { thumbs = [] }
      }
      keep = thumbs.length === files.length && files.length > 0 ? dedupeThumbs(thumbs) : files.map((_, i) => i)
    }
    if (!files.length) return []

    keep = thinToBudget(keep, cap)
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
