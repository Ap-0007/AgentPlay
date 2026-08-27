const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { compileVisualEffectDecision } = require('../electron/visual-effect-decision')

const bin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const ffmpeg = path.join(bin, 'ffmpeg.exe'); const ffprobe = path.join(bin, 'ffprobe.exe')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('real combined crop, scale, motion, mask, blur and color effects produce verified changed pixels', { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(ffmpeg)) return t.skip('ffmpeg unavailable')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-visual-effects-'))
  try {
    const source = path.join(dir, 'source.mp4'); const output = path.join(dir, 'effects.mp4')
    const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(built.status, 0)
    const before = hash(source)
    const decision = attachEditDecisionList(compileVisualEffectDecision({ instruction: '裁成9:16，放大1.15倍，做缓慢推近关键帧运动，第1秒到第3秒右上角加遮罩并强模糊，亮度提高10%，对比度提高20%，饱和度降低15%', sourcePath: source }).decision)
    const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    const result = await new MediaEditService({ frames }).visualEffects({ sourcePath: source, outputPath: output, decision })
    assert.equal(result.effectReceipt.dimensionMatch, true)
    assert.deepEqual(result.effectReceipt.outputDimensions, { width: 100, height: 180 })
    assert.equal(result.effectReceipt.changed, true)
    assert.deepEqual(result.effectReceipt.effectKinds, ['crop', 'scale', 'motion', 'mask', 'blur', 'color'])
    const sar = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=sample_aspect_ratio', '-of', 'default=nw=1:nk=1', output], { encoding: 'utf8' })
    assert.equal(String(sar.stdout || '').trim(), '1:1', '组合裁切/推近后必须显式归一SAR，不能让统一视觉门误杀')
    assert.equal(hash(source), before)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('real picture-in-picture and synchronized transition keep audio and reduce duration once', { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(ffmpeg)) return t.skip('ffmpeg unavailable')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-pip-transition-'))
  try {
    const source = path.join(dir, 'source.mp4'); const pip = path.join(dir, 'pip.mp4'); const output = path.join(dir, 'out.mp4')
    assert.equal(spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'], { timeout: 60000 }).status, 0)
    assert.equal(spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=160x90:rate=15,hue=h=90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', pip, '-loglevel', 'error'], { timeout: 60000 }).status, 0)
    const decision = attachEditDecisionList(compileVisualEffectDecision({ instruction: `把 ${pip} 作为右上角画中画，占画面25%，第1秒到第4秒显示；在第3秒加0.5秒叠化转场`, sourcePath: source }).decision)
    const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    const result = await new MediaEditService({ frames }).visualEffects({ sourcePath: source, outputPath: output, decision })
    assert.ok(Math.abs(result.durationSeconds - 4.5) <= 0.35, result.durationSeconds)
    assert.equal(await frames.probeHasAudio(output), true)
    assert.deepEqual(result.effectReceipt.effectKinds, ['pip', 'transition'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('recovery derives frozen crop dimensions from the source instead of trusting an existing artifact', { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(ffmpeg)) return t.skip('ffmpeg unavailable')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-effects-recovery-'))
  try {
    const source = path.join(dir, 'source.mp4'); const wrongOutput = path.join(dir, 'wrong.mp4')
    assert.equal(spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x180:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', source, '-loglevel', 'error'], { timeout: 60000 }).status, 0)
    fs.copyFileSync(source, wrongOutput)
    const decision = attachEditDecisionList(compileVisualEffectDecision({ instruction: '裁成9:16', sourcePath: source }).decision)
    const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    await assert.rejects(new MediaEditService({ frames }).verify({ sourcePath: source, outputPath: wrongOutput, decision }), /分辨率与冻结决策不一致/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
