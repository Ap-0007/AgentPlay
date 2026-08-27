const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const { compileBurnSubtitlesDecisionList } = require('../electron/media-edit-decision')
const { ProfessionalSubtitleService, acousticEmbedding, buildAssDocument, clusterSpeakers } = require('../electron/professional-subtitle-service')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const SOURCE = 'D:/Videos/interview.mp4'
const SRT = 'D:/Videos/interview.srt'

function sinePcm(frequency, durationSeconds = 1, sampleRate = 8000) {
  const samples = Math.round(durationSeconds * sampleRate)
  const buffer = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * 14000), index * 2)
  return buffer
}

function grayFrame({ busyTop = false, busyBottom = false, subtitleTop = false } = {}) {
  const frame = Buffer.alloc(32 * 32, 80)
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) {
    if ((busyTop && y >= 2 && y < 10) || (busyBottom && y >= 22 && y < 30)) frame[y * 32 + x] = (x + y) % 2 ? 20 : 220
    if (subtitleTop && y >= 3 && y < 8 && x >= 6 && x < 26) frame[y * 32 + x] = (x + y) % 2 ? 245 : 25
  }
  return frame
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-professional-subtitle-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'interview.mp4'); const subtitle = path.join(dir, 'interview.srt'); const ass = path.join(dir, 'professional.ass'); const output = path.join(dir, 'output.mp4')
  fs.writeFileSync(source, 'video'); fs.writeFileSync(output, 'output')
  fs.writeFileSync(subtitle, [
    '1\n00:00:00,300 --> 00:00:01,500\n产品价格透明',
    '2\n00:00:01,550 --> 00:00:02,700\n服务现在开始',
    '3\n00:00:02,800 --> 00:00:04,000\n产品可以定制',
    '4\n00:00:04,000 --> 00:00:05,200\n价格稍后说明'
  ].join('\n\n') + '\n')
  return { dir, source, subtitle, ass, output }
}

function words() {
  return [
    ['产品', 0.5, 0.85], ['价格', 0.85, 1.15], ['透明', 1.15, 1.45],
    ['服务', 1.7, 2.0], ['现在', 2.0, 2.3], ['开始', 2.3, 2.65],
    ['产品', 3.0, 3.3], ['可以', 3.3, 3.6], ['定制', 3.6, 3.95],
    ['价格', 4.2, 4.5], ['稍后', 4.5, 4.8], ['说明', 4.8, 5.15]
  ].map(([text, startSeconds, endSeconds]) => ({ text, startSeconds, endSeconds, confidence: 0.92 }))
}

function professionalDecision(source, subtitle) {
  return compileBurnSubtitlesDecisionList({
    sourcePath: source,
    instruction: `把字幕 ${subtitle} 做成专业动态字幕：识别说话人、逐词高亮、卡拉OK，关键词：产品、价格；自动避开画面安全区`
  })
}

test('D1 freezes one professional subtitle contract while plain subtitle burn stays unchanged', () => {
  const decision = professionalDecision(SOURCE, SRT)
  assert.equal(decision.kind, 'media.burn-subtitles')
  assert.equal(decision.subtitle.professional.strategy, 'acoustic-speaker-karaoke-v1')
  assert.equal(decision.subtitle.professional.speakers.anonymousLabels, true)
  assert.equal(decision.subtitle.professional.speakers.distanceThreshold, 0.18)
  assert.equal(decision.subtitle.professional.wordHighlight.method, 'whisper.cpp-dtw-v1')
  assert.equal(decision.subtitle.professional.karaoke.assTag, 'kf')
  assert.deepEqual(decision.subtitle.professional.keywords.explicit, ['产品', '价格'])
  assert.equal(decision.subtitle.professional.safeArea.strategy, 'frame-band-complexity-v1')
  assert.match(decision.output.suffix, /专业动态字幕/)
  const plain = compileBurnSubtitlesDecisionList({ sourcePath: SOURCE, instruction: `把字幕 ${SRT} 烧进视频` })
  assert.equal(plain.subtitle.professional, undefined)
})

test('D1 acoustic embeddings and deterministic clustering separate two anonymous speakers without claiming names', () => {
  const embeddings = [sinePcm(150), sinePcm(270), sinePcm(152), sinePcm(268)].map((pcm) => acousticEmbedding(pcm, 8000))
  const clustered = clusterSpeakers(embeddings, { maximumSpeakers: 4 })
  assert.equal(clustered.speakerCount, 2)
  assert.deepEqual(clustered.assignments, [0, 1, 0, 1])
  assert.ok(clustered.confidence >= 0.7)
  assert.equal(clustered.anonymousLabels, true)
})

test('D1 builds ASS from real DTW words with speaker labels, karaoke tags, keyword emphasis and top safe zone', async (t) => {
  const { source, subtitle, ass, output } = fixture(t)
  let requestedModel = ''
  const transcription = { availability: () => ({ available: true, smallAvailable: true }), transcribeWords: async ({ model }) => { requestedModel = model; return { words: words(), model, timingMethod: 'whisper.cpp-dtw-v1' } } }
  const pcmStarts = []
  const frames = {
    probeDimensions: async () => ({ width: 640, height: 360 }),
    readPcmWindow: async (_file, at) => { pcmStarts.push(at); return sinePcm(at < 1.6 || (at >= 3 && at < 4.1) ? 150 : 270) },
    readGrayFrame: async (file) => file === output ? grayFrame({ busyBottom: true, subtitleTop: true }) : grayFrame({ busyBottom: true })
  }
  const service = new ProfessionalSubtitleService({ frames, transcription })
  const plan = await service.prepare({ sourcePath: source, subtitlePath: subtitle, outputAssPath: ass, decision: professionalDecision(source, subtitle) })
  assert.equal(plan.schemaVersion, 1)
  assert.equal(plan.strategy, 'acoustic-speaker-karaoke-v1')
  assert.equal(requestedModel, 'ggml-tiny.bin')
  assert.equal(plan.speakers.speakerCount, 2)
  assert.deepEqual(plan.cues.map((cue) => cue.speakerLabel), ['说话人1', '说话人2', '说话人1', '说话人2'])
  assert.deepEqual(pcmStarts, [0.5, 1.7, 3, 4.2])
  assert.equal(plan.wordTiming.wordCount, 12)
  assert.equal(plan.karaoke.tagCount, 12)
  assert.ok(plan.keywords.emphasisCount >= 4)
  assert.equal(plan.safeArea.chosenZone, 'top')
  const content = fs.readFileSync(ass, 'utf8')
  assert.match(content, /\{\\kf\d+\}/)
  assert.match(content, /说话人1/)
  assert.match(content, /说话人2/)
  assert.match(content, /产品/)
  assert.match(content, /,8,51,51,43,1/)
  const proof = await service.verifyRender({ sourcePath: source, outputPath: output, plan })
  assert.equal(proof.verdict, 'matched')
  assert.equal(proof.safeArea.subtitleInChosenZone, true)
})

test('D1 fails closed when Whisper words cannot be aligned exactly to the subtitle instead of guessing character time', async (t) => {
  const { source, subtitle, ass } = fixture(t)
  const transcription = { availability: () => ({ available: true }), transcribeWords: async () => ({ words: [{ text: '完全不同', startSeconds: 0.5, endSeconds: 1, confidence: 0.9 }], model: 'ggml-tiny.bin', timingMethod: 'whisper.cpp-dtw-v1' }) }
  const frames = { probeDimensions: async () => ({ width: 640, height: 360 }), readPcmWindow: async () => sinePcm(180), readGrayFrame: async () => grayFrame() }
  const service = new ProfessionalSubtitleService({ frames, transcription })
  await assert.rejects(() => service.prepare({ sourcePath: source, subtitlePath: subtitle, outputAssPath: ass, decision: professionalDecision(source, subtitle) }), /逐词时间.*无法与字幕逐字对齐/)
})

test('D1 generated ASS contains bounded timing and no raw ASS injection', () => {
  const document = buildAssDocument({
    dimensions: { width: 640, height: 360 }, safeArea: { chosenZone: 'bottom', marginV: 52 },
    cues: [{ startSeconds: 0, endSeconds: 1, speakerIndex: 0, speakerLabel: '说话人1', words: [{ text: '{\\pos(0,0)}危险', startSeconds: 0, endSeconds: 1, keyword: true }] }]
  })
  assert.doesNotMatch(document, /\{\\pos\(0,0\)\}/)
  assert.match(document, /\\kf100/)
  assert.match(document, /MarginV=52|,52,/)
})

test('D1 real render burns clustered speaker karaoke subtitles into the chosen safe band', { timeout: 180000 }, async (t) => {
  const ffmpeg = process.env.AIPLAYER_FFMPEG || path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe')
  const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return t.skip('本机无ffmpeg')
  const { dir, source, subtitle, output } = fixture(t)
  const audio = "if(lt(t\\,1.6)\\,0.35*sin(2*PI*150*t)\\,if(lt(t\\,2.9)\\,0.35*sin(2*PI*270*t)\\,if(lt(t\\,4.1)\\,0.35*sin(2*PI*150*t)\\,0.35*sin(2*PI*270*t))))"
  const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x303030:s=640x360:r=20:d=5.5', '-f', 'lavfi', '-i', `aevalsrc=${audio}:s=8000:d=5.5`, '-vf', 'drawgrid=w=24:h=24:t=2:c=0x808080@0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'], { timeout: 60000 })
  assert.equal(built.status, 0, String(built.stderr).slice(-600))
  const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
  const transcription = { availability: () => ({ available: true }), transcribeWords: async () => ({ words: words(), model: 'ggml-tiny.bin', timingMethod: 'whisper.cpp-dtw-v1' }) }
  const service = new MediaEditService({ frames, transcription })
  const decision = professionalDecision(source, subtitle)
  fs.rmSync(output, { force: true })
  const result = await service.burnSubtitles({ sourcePath: source, outputPath: output, decision })
  assert.ok(fs.existsSync(output))
  assert.equal(result.professionalSubtitleProof.verdict, 'matched')
  assert.equal(result.professionalSubtitleProof.speakerEvidence.speakerCount, 2)
  assert.equal(result.professionalSubtitleProof.karaokeEvidence.tagCount, 12)
  assert.equal(result.professionalSubtitleProof.safeArea.subtitleInChosenZone, true)
  assert.match(result.summary, /专业动态字幕/)
  assert.ok(Math.abs((await frames.probeDuration(output)) - 5.5) < 0.2)
})

test('D1 quality is 100 only when all five professional subtitle proofs are present', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-professional-subtitle-quality-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const output = path.join(dir, 'professional.mp4'); fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
  const decision = professionalDecision('D:/video.mp4', 'D:/sub.srt')
  const professionalSubtitle = { safeArea: { chosenZone: 'top' } }
  const proof = {
    schemaVersion: 1, method: 'professional-subtitle-render-proof-v1', verdict: 'matched',
    speakerEvidence: { method: 'decoded-pcm-acoustic-cluster-v1', speakerCount: 2, confidence: 0.86, anonymousLabels: true },
    wordTimingEvidence: { method: 'whisper.cpp-dtw-v1', model: 'ggml-tiny.bin', wordCount: 12, minimumConfidence: 0.8, exactCueAlignment: true },
    karaokeEvidence: { mode: 'ass-kf', tagCount: 12, matchedWordCount: 12 },
    keywordEvidence: { terms: ['产品', '价格'], emphasisCount: 4 },
    safeArea: { strategy: 'frame-band-complexity-v1', chosenZone: 'top', sampledFrames: 4, subtitleInChosenZone: true }
  }
  const result = {
    success: true, outputs: [output], expectedDurationSeconds: 5.5, durationSeconds: 5.52,
    timelineReceipt: [{ sourceRange: '00:00.000 → 00:05.500', outputRange: '00:00.000 → 00:05.500' }],
    professionalSubtitle, professionalSubtitleProof: proof,
    subtitlePreviewBurnProof: {
      schemaVersion: 1, method: 'single-render-subtitle-preview-burn-v1', verdict: 'matched', sameArtifact: true,
      cueCount: 1, cueLedgerSha256: 'b'.repeat(64),
      preview: { path: output, artifactSha256: 'c'.repeat(64) }, final: { path: output, artifactSha256: 'c'.repeat(64) },
      cues: [{ index: 1, startMs: 500, endMs: 1500, previewCueSha256: 'a'.repeat(64), finalCueSha256: 'a'.repeat(64), matched: true }]
    },
    projectCapsule: { schemaVersion: 1, projectId: 'edit-d1', versionId: 'version-d1', currentPath: output, versionCount: 2, cursor: 1, canUndo: true }
  }
  const passed = evaluateTaskResult('media.edit-burn-subtitles', result, { decision })
  assert.equal(passed.passed, true); assert.equal(passed.score, 100)
  for (const id of ['speaker-evidence', 'word-timing', 'karaoke', 'keyword-emphasis', 'subtitle-safe-area']) assert.ok(passed.checks.some((item) => item.id === id && item.passed), id)
  const failed = evaluateTaskResult('media.edit-burn-subtitles', { ...result, professionalSubtitleProof: { ...proof, karaokeEvidence: { mode: 'ass-kf', tagCount: 11, matchedWordCount: 12 } } }, { decision })
  assert.equal(failed.passed, false); assert.ok(failed.reasons.some((item) => item.code === 'KARAOKE_PROOF_MISSING'))
})

test('D1 wiring uses the same persistent subtitle task, quality authority and packaged acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const media = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
  const frames = fs.readFileSync(path.join(__dirname, '..', 'electron', 'video-frame-service.js'), 'utf8')
  const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
  const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'types', 'global.d.ts'), 'utf8')
  assert.match(main, /new MediaEditService\(\{ frames: videoFrames, transcription: transcriptionService \}\)/)
  assert.match(media, /professionalSubtitleService\.prepare/)
  assert.match(media, /professionalSubtitleService\.verifyRender/)
  assert.match(frames, /Math\.min\(4, Number\(durationSeconds\)/)
  for (const code of ['SPEAKER_EVIDENCE_MISSING', 'WORD_TIMING_MISSING', 'KARAOKE_PROOF_MISSING', 'KEYWORD_EMPHASIS_MISSING', 'SUBTITLE_SAFE_AREA_FAILED']) assert.match(quality, new RegExp(code))
  assert.match(types, /acoustic-speaker-karaoke-v1/)
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-professional-subtitle-d1.mjs'), 'utf8')
  for (const marker of ['speakerCount', 'wordCount', 'karaoke', 'emphasisCount', 'chosenZone', 'quality100', 'sourceHashesUnchanged']) assert.match(smoke, new RegExp(marker))
})
