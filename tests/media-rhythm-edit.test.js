const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { compileRhythmEditRequest } = require('../electron/rhythm-edit-decision')
const { RhythmEditPlanner } = require('../electron/rhythm-edit-service')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function run(args) {
  const result = spawnSync(FFMPEG, args, { timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr || result.stdout).slice(0, 1200))
}

test('C3 real service detects beats, cuts faster at the highlight and fades both picture and sound on a beat', { timeout: 240000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-rhythm-edit-'))
  try {
    const source = path.join(dir, 'source.mp4')
    const music = path.join(dir, 'beat.wav')
    const output = path.join(dir, 'rhythm.mp4')
    run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=16:size=320x180:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'])
    const expression = '0.012*sin(2*PI*220*t)+if(lt(mod(t\\,0.5)\\,0.025)\\,0.85*exp(-mod(t\\,0.5)*90)\\,0)+if(between(t\\,6\\,10)\\,0.12*sin(2*PI*440*t)\\,0)'
    run(['-y', '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=11025:d=16`, '-ar', '11025', '-c:a', 'pcm_s16le', music, '-loglevel', 'error'])
    const before = [hash(source), hash(music)]
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const request = compileRhythmEditRequest({ instruction: `用 ${music} 按音乐节拍切镜，音乐高潮对齐，片尾自然收束，节奏更快`, sourcePath: source })
    const planned = await new RhythmEditPlanner({ frames, authorizePath: (value) => value }).plan(request)
    const decision = attachEditDecisionList(planned.decision)
    assert.ok(Math.abs(decision.rhythm.bpm - 120) <= 3)
    assert.ok(decision.rhythm.highlight.densityRatio <= 0.8)
    assert.equal(decision.rhythm.confirmationRequired, true)
    const service = new MediaEditService({ frames })
    const result = await service.rhythmEdit({ sourcePath: source, musicPath: music, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    assert.ok(Math.abs(result.durationSeconds - decision.rhythm.outputDurationSeconds) <= 0.2)
    assert.ok(result.beatProof.visibleCutRatio >= 0.5, JSON.stringify(result.beatProof.visibleCuts))
    assert.ok(result.beatProof.musicCorrelation >= 0.02)
    assert.equal(result.beatProof.highlight.denserThanOutside, true)
    assert.equal(result.beatProof.tail.audioFaded, true)
    assert.equal(result.beatProof.tail.videoFaded, true)
    assert.deepEqual([hash(source), hash(music)], before)
    const recovered = await service.verifyRhythmEdit({ sourcePath: source, musicPath: music, outputPath: output, decision })
    assert.equal(recovered.beatProof.highlight.denserThanOutside, true)
    assert.equal(recovered.beatProof.tail.audioFaded, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
