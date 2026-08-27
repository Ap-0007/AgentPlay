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

function repairDtwGroupTexts(groups, segmentText) {
  const repaired = (Array.isArray(groups) ? groups : []).map((group) => ({ ...group }))
  const source = normalizeWord(segmentText)
  if (!source || !repaired.some((group) => /�/.test(group.text))) return repaired
  let cursor = 0
  for (let index = 0; index < repaired.length;) {
    const group = repaired[index]
    if (!/�/.test(group.text)) {
      const value = normalizeWord(group.text)
      const position = source.indexOf(value, cursor)
      if (value && position >= cursor) cursor = position + value.length
      index += 1
      continue
    }
    let end = index
    while (end < repaired.length && /�/.test(repaired[end].text)) end += 1
    const nextValue = end < repaired.length ? normalizeWord(repaired[end].text) : ''
    const nextPosition = nextValue ? source.indexOf(nextValue, cursor) : source.length
    if (nextPosition >= cursor) {
      const missing = [...source.slice(cursor, nextPosition)]
      if (missing.length === end - index) {
        missing.forEach((value, offset) => { repaired[index + offset].text = value })
        cursor = nextPosition
      }
    }
    index = end
  }
  return repaired
}

function parseWhisperWordJson(payload) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
  const groups = []
  for (const segment of Array.isArray(parsed?.transcription) ? parsed.transcription : []) {
    const segmentGroups = []
    for (const token of Array.isArray(segment?.tokens) ? segment.tokens : []) {
      const dtwStart = Number(token?.t_dtw)
      const text = safeWordText(token?.text)
      if (!text || !Number.isFinite(dtwStart) || dtwStart < 0) continue
      const confidence = Math.max(0, Math.min(1, Number(token?.p) || 0))
      const previous = segmentGroups.at(-1)
      if (previous?.dtwStart === dtwStart) {
        previous.text += text
        previous.confidence = Math.min(previous.confidence, confidence)
      } else segmentGroups.push({ text, dtwStart, confidence })
    }
    groups.push(...repairDtwGroupTexts(segmentGroups, segment?.text))
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

function findPhraseWordTiming(words, phrase) {
  const target = normalizeWord(phrase)
  if (!target) return null
  const entries = (Array.isArray(words) ? words : []).map((word) => ({
    word,
    normalized: normalizeWord(word?.text),
    startSeconds: Number(word?.startSeconds),
    endSeconds: Number(word?.endSeconds),
    confidence: Number(word?.confidence)
  })).filter((entry) => entry.normalized && Number.isFinite(entry.startSeconds) && Number.isFinite(entry.endSeconds) && entry.endSeconds > entry.startSeconds && Number.isFinite(entry.confidence) && entry.confidence >= 0.15)
  let text = ''
  const boundaries = [0]
  for (const entry of entries) { text += entry.normalized; boundaries.push(text.length) }
  const matches = []
  let offset = text.indexOf(target)
  while (offset >= 0) {
    const endOffset = offset + target.length
    const startIndex = boundaries.indexOf(offset)
    const endBoundaryIndex = boundaries.indexOf(endOffset)
    if (startIndex >= 0 && endBoundaryIndex > startIndex) {
      const selected = entries.slice(startIndex, endBoundaryIndex)
      const continuous = selected.every((entry, index) => index === 0 || entry.startSeconds - selected[index - 1].endSeconds <= 0.65)
      if (continuous) matches.push({
        startSeconds: Number(selected[0].startSeconds.toFixed(3)),
        endSeconds: Number(selected.at(-1).endSeconds.toFixed(3)),
        confidence: Number(Math.min(...selected.map((entry) => entry.confidence)).toFixed(4)),
        wordCount: selected.length
      })
    }
    offset = text.indexOf(target, offset + 1)
  }
  return matches.length === 1 ? matches[0] : null
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
          if (candidate.phrase) {
            const boundedWords = (result.words || []).filter((word) => {
              const absoluteStart = clipStart + Number(word.startSeconds)
              const absoluteEnd = clipStart + Number(word.endSeconds)
              return absoluteStart >= Number(candidate.startSeconds) - 0.35 && absoluteEnd <= Number(candidate.endSeconds) + 0.35
            })
            const phraseTiming = findPhraseWordTiming(boundedWords, candidate.phrase)
            if (phraseTiming) {
              resolved.push({
                ...candidate, phrase: String(candidate.phrase),
                phraseStartSeconds: Number((clipStart + phraseTiming.startSeconds).toFixed(3)),
                phraseEndSeconds: Number((clipStart + phraseTiming.endSeconds).toFixed(3)),
                timingConfidence: phraseTiming.confidence, wordCount: phraseTiming.wordCount, timingMethod, model
              })
            } else unresolved.push({ ...candidate, unresolvedReason: '逐词转写没有形成唯一、完整且起于真实词界的短语时间段' })
            continue
          }
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

module.exports = { MAX_WORD_TIMING_CANDIDATES, createWordTimingLoader, findPhraseWordTiming, normalizeWord, parseWhisperWordJson, repairDtwGroupTexts }
