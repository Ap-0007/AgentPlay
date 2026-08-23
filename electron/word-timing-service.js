const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_WORD_TIMING_CANDIDATES = 4

function safeWordText(value) {
  const text = String(value || '').trim()
  if (!text || /^\[?_.*_\]?$/.test(text)) return ''
  return text
}

function normalizeWord(value) {
  return String(value || '').toLowerCase().replace(/[\s，。！？!?、；;：:“”"'‘’…—-]+/g, '')
}

function parseWhisperWordJson(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  const groups = []
  for (const segment of Array.isArray(parsed?.transcription) ? parsed.transcription : []) {
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      const dtwStart = Number(token?.t_dtw)
      const text = safeWordText(token?.text)
      if (!text || !Number.isFinite(dtwStart) || dtwStart < 0) continue
      const confidence = Math.max(0, Math.min(1, Number(token?.p) || 0))
      const previous = groups.at(-1)
      if (previous?.dtwStart === dtwStart) {
        previous.text += text
        previous.confidence = Math.min(previous.confidence, confidence)
      } else groups.push({ text, dtwStart, confidence })
    }
  }
  const words = []
  for (let index = 0; index < groups.length - 1; index += 1) {
    const current = groups[index]
    const next = groups.slice(index + 1).find((item) => item.dtwStart > current.dtwStart)
    if (!next) continue
    const startSeconds = Number((current.dtwStart / 100).toFixed(3))
    const endSeconds = Number((next.dtwStart / 100).toFixed(3))
    if (!(endSeconds > startSeconds) || endSeconds - startSeconds > 2) continue
    words.push({ text: current.text, startSeconds, endSeconds, confidence: Number(current.confidence.toFixed(4)), dtwStart: current.dtwStart })
  }
  return words
}

function createWordTimingLoader({ frames, transcription, tempRoot = os.tmpdir() } = {}) {
  return async function loadWordTimings(sourcePath, candidates, { signal } = {}) {
    const allCandidates = Array.isArray(candidates) ? candidates : []
    const pending = allCandidates.slice(0, MAX_WORD_TIMING_CANDIDATES)
    const overflow = allCandidates.slice(MAX_WORD_TIMING_CANDIDATES).map((item) => ({ ...item, unresolvedReason: '超过单次逐词精确定位上限，请分段处理' }))
    const status = transcription?.availability?.() || { available: false, reason: '逐词转写组件不可用' }
    if (!status.available || !frames?.run) return { resolved: [], unresolved: pending, available: false, reason: status.reason || '逐词转写组件不可用' }
    const model = 'ggml-tiny.bin'
    const timingMethod = 'whisper.cpp-dtw-v1'
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'agentplay-word-timing-'))
    const resolved = []
    const unresolved = [...overflow]
    try {
      for (const candidate of pending) {
        if (signal?.aborted) throw new Error('已取消')
        // Whisper 在短片开头容易吞掉首词；保留1秒前文让候选词不是解码首词，后侧只留0.5秒用于形成下一词DTW边界。
        const clipStart = Math.max(0, Number(candidate.startSeconds) - 1)
        const clipEnd = Number(candidate.endSeconds) + 0.5
        const wavPath = path.join(tempDir, `cue-${Number(candidate.cueIndex) || resolved.length + unresolved.length + 1}.wav`)
        try {
          await frames.run([
            '-hide_banner', '-loglevel', 'error', '-ss', clipStart.toFixed(3), '-t', Math.max(0.5, clipEnd - clipStart).toFixed(3),
            '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-y', wavPath
          ], { timeoutMs: 120000, signal })
          const result = await transcription.transcribeWords({ sourcePath: wavPath, lang: 'auto', model, signal, timeoutMs: 180000 })
          let match = null
          for (const target of candidate.matches || []) {
            const targetWord = normalizeWord(target)
            match = result.words.find((word) => {
              const absoluteStart = clipStart + Number(word.startSeconds)
              const absoluteEnd = clipStart + Number(word.endSeconds)
              return normalizeWord(word.text) === targetWord && absoluteStart >= Number(candidate.startSeconds) - 0.35 && absoluteEnd <= Number(candidate.endSeconds) + 0.35 && word.confidence >= 0.15
            })
            if (match) {
              const preciseStartSeconds = Number((clipStart + match.startSeconds).toFixed(3))
              const preciseEndSeconds = Number((clipStart + match.endSeconds).toFixed(3))
              if (preciseEndSeconds - preciseStartSeconds >= 0.08 && preciseEndSeconds - preciseStartSeconds <= 1.5) {
                resolved.push({
                  ...candidate, match: target, preciseStartSeconds, preciseEndSeconds,
                  timingConfidence: Number(match.confidence), timingMethod, model
                })
                break
              }
              match = null
            }
          }
          if (!match) unresolved.push({ ...candidate, unresolvedReason: '逐词转写没有形成可信且有界的同词时间段' })
        } catch (error) {
          if (signal?.aborted || error?.message === '已取消') throw error
          unresolved.push({ ...candidate, unresolvedReason: error instanceof Error ? error.message : String(error) })
        }
      }
      return { resolved, unresolved, available: true, model, timingMethod }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

module.exports = { MAX_WORD_TIMING_CANDIDATES, createWordTimingLoader, normalizeWord, parseWhisperWordJson }
