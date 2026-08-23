const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createWordTimingLoader, parseWhisperWordJson } = require('../electron/word-timing-service')

test('whisper DTW tokens become real bounded word intervals without duration-proportional guessing', () => {
  const words = parseWhisperWordJson({
    transcription: [{ tokens: [
      { text: '就', t_dtw: 100, p: 0.9 },
      { text: '是', t_dtw: 100, p: 0.7 },
      { text: '今天', t_dtw: 140, p: 0.8 },
      { text: '开始', t_dtw: 180, p: 0.9 },
      { text: '[_EOT_]', t_dtw: -1, p: 0.9 }
    ] }]
  })
  assert.deepEqual(words, [
    { text: '就是', startSeconds: 1, endSeconds: 1.4, confidence: 0.7, dtwStart: 100 },
    { text: '今天', startSeconds: 1.4, endSeconds: 1.8, confidence: 0.8, dtwStart: 140 }
  ])
})

test('word timing loader extracts only candidate cue audio and resolves exact embedded filler evidence', async () => {
  const calls = []
  const frames = {
    run: async (args) => {
      calls.push(args)
      const output = args.at(-1)
      fs.writeFileSync(output, 'wav')
    }
  }
  const transcription = {
    availability: () => ({ available: true, smallAvailable: true }),
    transcribeWords: async ({ sourcePath, model }) => {
      assert.ok(fs.existsSync(sourcePath))
      assert.equal(model, 'ggml-tiny.bin')
      return { model, timingMethod: 'whisper.cpp-dtw-v1', words: [
        { text: '就是', startSeconds: 1.05, endSeconds: 1.37, confidence: 0.91, dtwStart: 105 },
        { text: '今天', startSeconds: 1.37, endSeconds: 1.75, confidence: 0.96, dtwStart: 137 }
      ] }
    }
  }
  const load = createWordTimingLoader({ frames, transcription })
  const result = await load('D:\\video\\talk.mp4', [{
    cueIndex: 2, startSeconds: 1.5, endSeconds: 3.2, text: '就是，今天开始介绍', reason: '句中疑似口头禅', matches: ['就是']
  }])
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('-ss'))
  assert.ok(calls[0].includes('-t'))
  assert.deepEqual(result.resolved.map((item) => [item.cueIndex, item.match, item.preciseStartSeconds, item.preciseEndSeconds, item.timingConfidence]), [
    [2, '就是', 1.55, 1.87, 0.91]
  ])
  assert.equal(result.unresolved.length, 0)
})

test('transcription service pins full JSON DTW output and disables flash attention', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'transcription-service.js'), 'utf8')
  for (const marker of ["'-ojf'", "'-dtw'", "'-nfa'", 'parseWhisperWordJson']) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
