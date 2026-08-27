const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createWordTimingLoader, findPhraseWordTiming, parseWhisperWordJson, repairDtwGroupTexts } = require('../electron/word-timing-service')

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

test('phrase timing starts only on a real DTW word boundary and refuses ambiguous or intra-token guesses', () => {
  const words = [
    { text: '就是', startSeconds: 1, endSeconds: 1.4, confidence: 0.9 },
    { text: '今天', startSeconds: 1.4, endSeconds: 1.8, confidence: 0.86 },
    { text: '我们', startSeconds: 1.8, endSeconds: 2.1, confidence: 0.88 },
    { text: '介绍', startSeconds: 2.1, endSeconds: 2.4, confidence: 0.84 },
    { text: '产品', startSeconds: 2.4, endSeconds: 2.8, confidence: 0.91 }
  ]
  assert.deepEqual(findPhraseWordTiming(words, '今天我们介绍产品'), { startSeconds: 1.4, endSeconds: 2.8, confidence: 0.84, wordCount: 4 })
  assert.equal(findPhraseWordTiming([{ text: '就是今天', startSeconds: 1, endSeconds: 1.8, confidence: 0.9 }], '今天'), null)
  assert.equal(findPhraseWordTiming([...words, { text: '今天', startSeconds: 3, endSeconds: 3.4, confidence: 0.9 }, { text: '我们介绍产品', startSeconds: 3.4, endSeconds: 4, confidence: 0.9 }], '今天我们介绍产品'), null)
})

test('whisper byte-token replacement characters are repaired only from the segment text and matching DTW groups', () => {
  assert.deepEqual(repairDtwGroupTexts([
    { text: '介', dtwStart: 100, confidence: 0.9 },
    { text: '��', dtwStart: 120, confidence: 0.8 },
    { text: '��', dtwStart: 140, confidence: 0.7 },
    { text: '品', dtwStart: 160, confidence: 0.9 }
  ], '介绍产品').map((item) => item.text), ['介', '绍', '产', '品'])
  const words = parseWhisperWordJson({ transcription: [{ text: '今天我们介绍产品结束', tokens: [
    { text: '今天', t_dtw: 100, p: 0.9 }, { text: '我们', t_dtw: 130, p: 0.9 }, { text: '介', t_dtw: 160, p: 0.9 },
    { text: '�', t_dtw: 180, p: 0.8 }, { text: '�', t_dtw: 180, p: 0.8 }, { text: '�', t_dtw: 210, p: 0.8 }, { text: '�', t_dtw: 210, p: 0.8 },
    { text: '品', t_dtw: 240, p: 0.9 }, { text: '结束', t_dtw: 270, p: 0.9 }
  ] }] })
  assert.deepEqual(words.map((item) => item.text), ['今天', '我们', '介', '绍', '产', '品'])
  assert.deepEqual(findPhraseWordTiming(words, '今天我们介绍产品'), { startSeconds: 1, endSeconds: 2.7, confidence: 0.8, wordCount: 6 })
})

test('word timing loader resolves a quoted phrase without reusing filler deletion fields', async () => {
  const frames = { run: async (args) => fs.writeFileSync(args.at(-1), 'wav') }
  const transcription = { availability: () => ({ available: true }), transcribeWords: async () => ({ words: [
    { text: '就是', startSeconds: 1, endSeconds: 1.4, confidence: 0.9 },
    { text: '今天', startSeconds: 1.4, endSeconds: 1.8, confidence: 0.86 },
    { text: '我们介绍产品', startSeconds: 1.8, endSeconds: 2.7, confidence: 0.88 }
  ] }) }
  const load = createWordTimingLoader({ frames, transcription })
  const result = await load('D:\\video\\talk.mp4', [{ cueIndex: 2, startSeconds: 1.5, endSeconds: 3.5, text: '就是，今天我们介绍产品', phrase: '今天我们介绍产品' }])
  assert.equal(result.unresolved.length, 0)
  assert.deepEqual(result.resolved.map((item) => [item.phrase, item.phraseStartSeconds, item.phraseEndSeconds, item.timingConfidence]), [['今天我们介绍产品', 1.9, 3.2, 0.86]])
  assert.equal(result.resolved[0].preciseStartSeconds, undefined)
})

test('transcription service pins full JSON DTW output and disables flash attention', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'transcription-service.js'), 'utf8')
  for (const marker of ["'-ojf'", "'-dtw'", "'-nfa'", 'parseWhisperWordJson']) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
