const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { compileAudioRepairDecisionList } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function run(args, options = {}) {
  const result = spawnSync(FFMPEG, args, { timeout: 60000, encoding: options.encoding, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr || result.stdout).slice(0, 1000))
  return result
}

function toneMagnitude(buffer, frequency, sampleRate = 16000) {
  const samples = Math.floor(buffer.length / 2); let sin = 0; let cos = 0
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2) / 32768; const angle = 2 * Math.PI * frequency * index / sampleRate
    sin += value * Math.sin(angle); cos += value * Math.cos(angle)
  }
  return Math.sqrt(sin * sin + cos * cos) / Math.max(1, samples)
}

function leftChannel(file, at = 2) {
  const result = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-t', '0.5', '-af', 'pan=mono|c0=c0', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', '-'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr).slice(0, 500))
  return result.stdout
}

test('C2 real repair reduces noise/DC, fills only short digital gaps, matches loudness and emits honest mid-side stems', { timeout: 240000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-audio-repair-'))
  try {
    const source = path.join(dir, 'source.mp4'); const output = path.join(dir, 'repaired.mp4'); const voice = path.join(dir, 'voice.wav'); const accompaniment = path.join(dir, 'accompaniment.wav')
    run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.06:d=6', '-f', 'lavfi', '-i', 'aevalsrc=0.08:s=48000:d=6', '-filter_complex', "[1:a]volume='gte(t,1)*lte(t,5)':eval=frame,pan=stereo|c0=c0|c1=c0[v];[2:a]volume='gte(t,1)*lte(t,5)':eval=frame,pan=stereo|c0=c0|c1=-1*c0[a];[3:a]aformat=sample_fmts=fltp:channel_layouts=stereo[n];[4:a]aformat=sample_fmts=fltp:channel_layouts=stereo[d];[v][a][n][d]amix=inputs=4:duration=first:normalize=0,volume=0:enable='between(t,2.5,2.65)'[mix]", '-map', '0:v:0', '-map', '[mix]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'])
    const sourceHash = hash(source)
    const decision = attachEditDecisionList(compileAudioRepairDecisionList({ sourcePath: source, instruction: '给音频降噪、去直流、静音修复，响度匹配到-16 LUFS，再分离人声和伴奏' }))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const result = await service.repairAudio({ sourcePath: source, outputPath: output, stemPaths: [voice, accompaniment], decision })
    assert.equal(result.audioRepairProof.denoise.verdict, 'improved')
    assert.ok(result.audioRepairProof.denoise.improvementRatio >= 0.05)
    assert.equal(result.audioRepairProof.dcRemoval.verdict, 'improved')
    assert.ok(result.audioRepairProof.dcRemoval.afterAbsoluteMean <= 0.002)
    assert.equal(result.audioRepairProof.silenceRepair.verdict, 'filled')
    assert.equal(result.audioRepairProof.silenceRepair.detectedGapCount, 1)
    assert.equal(result.audioRepairProof.silenceRepair.filledGapCount, 1)
    assert.equal(result.audioRepairProof.silenceRepair.restoresSpeech, false)
    assert.equal(result.loudnessProof.verdict, 'matched')
    assert.ok(Math.abs(result.loudnessProof.integratedLufs + 16) <= 0.7)
    assert.ok(result.loudnessProof.truePeakDbtp <= -1)
    assert.equal(result.separationProof.verdict, 'matched-with-artifact-warning')
    assert.match(result.separationProof.artifactWarning, /不是AI专业分轨/)
    assert.equal(result.separationProof.claims.professionalAiSeparation, false)
    assert.ok(fs.existsSync(output) && fs.existsSync(voice) && fs.existsSync(accompaniment))
    const voicePcm = leftChannel(voice); const accompanimentPcm = leftChannel(accompaniment)
    const voice440 = toneMagnitude(voicePcm, 440); const voice220 = toneMagnitude(voicePcm, 220)
    const accompaniment220 = toneMagnitude(accompanimentPcm, 220); const accompaniment440 = toneMagnitude(accompanimentPcm, 440)
    assert.ok(voice440 > voice220 * 5, `基础人声轨应以中置440Hz为主：${voice440}/${voice220}`)
    assert.ok(accompaniment220 > accompaniment440 * 5, `基础伴奏轨应以侧声道220Hz为主：${accompaniment220}/${accompaniment440}`)
    assert.equal(hash(source), sourceHash)
    const recovered = await service.verifyAudioRepair({ sourcePath: source, outputPath: output, stemPaths: [voice, accompaniment], decision })
    assert.equal(recovered.audioRepairProof.silenceRepair.verdict, 'filled')
    assert.equal(recovered.separationProof.verdict, 'matched-with-artifact-warning')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('C2 separation fails closed on mono instead of inventing stems', { timeout: 120000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-audio-repair-mono-'))
  try {
    const source = path.join(dir, 'mono.mp4')
    run(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-ac', '1', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'])
    const decision = attachEditDecisionList(compileAudioRepairDecisionList({ sourcePath: source, instruction: '分离人声和伴奏' }))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    await assert.rejects(() => new MediaEditService({ frames }).repairAudio({ sourcePath: source, outputPath: path.join(dir, 'out.mp4'), stemPaths: [path.join(dir, 'v.wav'), path.join(dir, 'a.wav')], decision }), /需要立体声源/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
