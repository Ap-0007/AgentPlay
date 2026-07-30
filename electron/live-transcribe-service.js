// 实时识别字幕：无字幕视频边播边转写——分段抽音 → whisper 带时间戳 → 绝对时间 cue 增量推送
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseSubtitleCues } = require('./analysis-studio-service')
const { formatSrtTimestamp } = require('./subtitle-bilingual-service')

// 单段转写：抽 segmentSec 秒音频给 whisper，失败/无语音返回空数组（不中断整片）
async function transcribeSegment({ ffmpegPath, ffprobeDuration, mediaPath, position, segmentSec, transcription, tempDir, signal }) {
  const wavPath = path.join(tempDir, `seg-${Math.round(position * 10)}.wav`)
  const args = [
    '-ss', String(position), '-t', String(segmentSec), '-i', mediaPath,
    '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-y', wavPath
  ]
  try {
    await execFile(ffmpegPath, args, 120000, signal)
  } catch {
    return [] // 无音轨/段损坏：跳过，不中断整片
  }
  if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 4000) return []
  const result = await transcription.transcribe({ sourcePath: wavPath, lang: 'auto', timestamps: true, signal }).catch(() => null)
  if (!result?.text) return []
  const cues = parseSubtitleCues(result.text, '.srt')
  const segEnd = position + segmentSec + 1
  return cues.map((cue) => ({
    index: 0, // 由调用方统一编号
    start: Math.min(cue.start + position, segEnd - 1),
    end: Math.min(cue.end + position, segEnd),
    text: cue.text
  })).map((cue, order) => ({ ...cue, index: order + 1 }))
}

function execFile(file, args, timeoutMs, signal) {
  const { spawn } = require('child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false })
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg 执行超时')) }, timeoutMs)
    const onAbort = () => { child.kill('SIGKILL'); reject(new Error('已取消')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split(/\r?\n/).filter(Boolean).pop() || `ffmpeg 退出码 ${code}`))
    })
  })
}

// 主循环：从当前播放位置向前分段转写；seek 跳走时追到新位置
async function runLiveTranscribe({
  mediaPath, durationSec, startPosition, segmentSec = 15,
  ffmpegPath, transcription, getPosition, onCues, signal
}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-live-tr-'))
  const allCues = []
  let nextIndex = 1
  let position = Math.max(0, startPosition)
  try {
    while (position < durationSec) {
      if (signal?.aborted) break
      // 播放位置领先转写位置太多（用户 seek），直接追过去
      const playingAt = getPosition()
      if (playingAt > position + segmentSec) position = playingAt
      const cues = await transcribeSegment({
        ffmpegPath, mediaPath, position, segmentSec, transcription, tempDir, signal
      })
      for (const cue of cues) {
        allCues.push({ index: nextIndex, start: cue.start, end: cue.end, text: cue.text })
        nextIndex += 1
      }
      if (cues.length) onCues?.(cues.map((cue, order) => ({ ...cue, index: nextIndex - cues.length + order })))
      position += segmentSec
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  return { cues: allCues, cancelled: Boolean(signal?.aborted) }
}

function cuesToSrt(cues) {
  return cues.map((cue) => `${cue.index}\n${formatSrtTimestamp(cue.start)} --> ${formatSrtTimestamp(cue.end)}\n${cue.text}\n`).join('\n')
}

module.exports = { runLiveTranscribe, cuesToSrt, transcribeSegment }
