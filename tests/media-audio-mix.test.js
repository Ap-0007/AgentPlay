const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { compileAudioMixDecisionList } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function build(args) {
  const result = spawnSync(FFMPEG, args, { timeout: 60000, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`.slice(0, 600))
}

function toneMagnitude(buffer, frequency, sampleRate = 16000) {
  const samples = Math.floor(buffer.length / 2)
  let sin = 0; let cos = 0
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768
    const angle = 2 * Math.PI * frequency * index / sampleRate
    sin += value * Math.sin(angle); cos += value * Math.cos(angle)
  }
  return Math.sqrt(sin * sin + cos * cos) / Math.max(1, samples)
}

test('C1 real mix aligns music, ambience and sfx, applies dialogue automation and ducking, and preserves every source', { timeout: 240000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-audio-mix-'))
  try {
    const video = path.join(dir, 'source.mp4')
    const music = path.join(dir, 'music.wav')
    const ambience = path.join(dir, 'rain.wav')
    const sfx = path.join(dir, 'ding.wav')
    const output = path.join(dir, 'multitrack.mp4')
    build(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=15', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1', '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[dialogue]', '-map', '0:v:0', '-map', '[dialogue]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'])
    build(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'pcm_s16le', music, '-loglevel', 'error'])
    build(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'pcm_s16le', ambience, '-loglevel', 'error'])
    build(['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-c:a', 'pcm_s16le', sfx, '-loglevel', 'error'])
    const before = new Map([video, music, ambience, sfx].map((file) => [file, hash(file)]))
    const decision = attachEditDecisionList(compileAudioMixDecisionList({
      sourcePath: video,
      instruction: `做多轨混音：背景音乐 ${music} 从0秒到6秒 音量20%；环境声 ${ambience} 从1秒到5秒 音量10%；音效 ${sfx} 放在2秒开始 音量30%；对白在3秒到4秒音量70%；音乐在4秒到5秒音量5%；自动闪避；响度归一到-16 LUFS`
    }))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const result = await service.mixAudio({ sourcePath: video, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    assert.ok(Math.abs(result.durationSeconds - 6) <= 0.2)
    assert.equal(result.audioMixProof.verdict, 'matched')
    assert.equal(result.audioMixProof.tracks.length, 3)
    assert.ok(result.audioMixProof.tracks.every((item) => item.aligned), JSON.stringify(result.audioMixProof.tracks))
    assert.deepEqual(result.audioMixProof.automation, { requested: 2, configured: 2 })
    assert.deepEqual(result.audioMixProof.ducking, { requestedTracks: 2, configuredTracks: 2, claim: 'configuration-plus-real-acceptance' })
    assert.equal(result.loudnessProof.verdict, 'matched')
    assert.ok(Math.abs(result.loudnessProof.integratedLufs + 16) <= 0.7)
    assert.ok(result.loudnessProof.truePeakDbtp <= -1)

    const unDucked = await frames.readPcmWindow(output, 0.35, { durationSeconds: 0.3, sampleRateHz: 16000 })
    const ducked = await frames.readPcmWindow(output, 2.8, { durationSeconds: 0.3, sampleRateHz: 16000 })
    assert.ok(toneMagnitude(unDucked, 220) > toneMagnitude(ducked, 220) * 1.1, '对白出现时音乐220Hz分量应实际降低')
    const sfxWindow = await frames.readPcmWindow(output, 2.08, { durationSeconds: 0.25, sampleRateHz: 16000 })
    const afterSfx = await frames.readPcmWindow(output, 2.75, { durationSeconds: 0.25, sampleRateHz: 16000 })
    assert.ok(toneMagnitude(sfxWindow, 880) > toneMagnitude(afterSfx, 880) * 4, '880Hz音效应只出现在2秒对齐窗口')
    const dialogueFull = await frames.readPcmWindow(output, 2.7, { durationSeconds: 0.25, sampleRateHz: 16000 })
    const dialogueReduced = await frames.readPcmWindow(output, 3.4, { durationSeconds: 0.25, sampleRateHz: 16000 })
    assert.ok(toneMagnitude(dialogueReduced, 440) < toneMagnitude(dialogueFull, 440) * 0.86, '3到4秒对白分段音量应实际降低')
    const musicNormal = await frames.readPcmWindow(output, 2.8, { durationSeconds: 0.25, sampleRateHz: 16000 })
    const musicReduced = await frames.readPcmWindow(output, 4.4, { durationSeconds: 0.25, sampleRateHz: 16000 })
    assert.ok(toneMagnitude(musicReduced, 220) < toneMagnitude(musicNormal, 220) * 0.55, '4到5秒音乐分段音量应实际降低')

    for (const [file, digest] of before) assert.equal(hash(file), digest, `${path.basename(file)} 不得被修改`)
    const recovered = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.equal(recovered.audioMixProof.verdict, 'matched')
    assert.equal(recovered.timelineReceipt.length, 4)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('C1 real mix can remove the source dialogue while keeping the new music track', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-audio-remove-dialogue-'))
  try {
    const video = path.join(dir, 'source.mp4'); const music = path.join(dir, 'music.wav'); const output = path.join(dir, 'music-only.mp4')
    build(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video, '-loglevel', 'error'])
    build(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'pcm_s16le', music, '-loglevel', 'error'])
    const before = [hash(video), hash(music)]
    const decision = attachEditDecisionList(compileAudioMixDecisionList({ sourcePath: video, instruction: `做多轨混音，去掉原声；背景音乐 ${music} 从0秒到4秒 音量20%；不要响度归一` }))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const result = await new MediaEditService({ frames }).mixAudio({ sourcePath: video, outputPath: output, decision })
    assert.equal(result.audioMix.dialogue.enabled, false)
    assert.equal(result.audioMixProof.dialogue.configured, false)
    const pcm = await frames.readPcmWindow(output, 1.5, { durationSeconds: 0.5, sampleRateHz: 16000 })
    assert.ok(toneMagnitude(pcm, 220) > toneMagnitude(pcm, 440) * 8, '移除原声后应保留220Hz音乐且基本没有440Hz对白')
    assert.deepEqual([hash(video), hash(music)], before)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
