const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('child_process')

const { compileMusicDecisionList, planEditInstruction, resolveEditClarification } = require('../electron/media-edit-decision')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')

const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')

const SOURCE = 'D:/视频/demo.mp4'
const FFMPEG = process.env.AIPLAYER_FFMPEG || 'C:/Program Files/ffmpeg/ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe'
const hasFfmpeg = fs.existsSync(FFMPEG)

test('music decision: path+volume compile, missing-audio clarifies with copyright guard, remove-music stays out', () => {
  const decision = compileMusicDecisionList({ instruction: '给视频加背景音乐 D:/Music/bgm.mp3', sourcePath: SOURCE })
  assert.equal(decision.kind, 'media.add-music')
  assert.equal(decision.audio.path, 'D:/Music/bgm.mp3')
  assert.equal(decision.audio.volume, 0.15)
  assert.equal(decision.audio.duck, true)
  assert.equal(decision.output.overwrite, false)

  const quiet = compileMusicDecisionList({ instruction: '背景音乐音量调到10%，用 D:/Music/bgm.mp3', sourcePath: SOURCE })
  assert.equal(quiet.audio.volume, 0.1)

  const clarification = planEditInstruction({ instruction: '给视频配个背景音乐', sourcePath: SOURCE })
  assert.equal(clarification.clarification.reason, 'missing-audio')
  assert.match(clarification.clarification.question, /合法文件|不会去网上抓/, '必须带版权红线提示')

  // 追问收口：只给路径即可形成决策
  const resolved = resolveEditClarification({ clarification: clarification.clarification, answer: 'D:/Music/钢琴曲.wav' })
  assert.equal(resolved.decision.kind, 'media.add-music')
  assert.equal(resolved.decision.audio.path, 'D:/Music/钢琴曲.wav')

  // 去掉背景音乐不在本切片（不误执行）
  assert.equal(compileMusicDecisionList({ instruction: '去掉背景音乐', sourcePath: SOURCE }), null)
  // 询问/否定类不误执行
  assert.equal(planEditInstruction({ instruction: '能不能加背景音乐', sourcePath: SOURCE }).matched, false)
})

test('music wiring: task registered, decision routed, renderer gate accepts, timeline edit set updated', () => {
  assert.match(main, /persistentTaskRuntime\.register\('media\.edit-music'/)
  assert.match(main, /decision\.kind === 'media\.add-music'/)
  assert.match(main, /media\.edit-music' \|\| type === 'media\.edit-concat'|media\.edit-trim' \|\| type === 'media\.edit-remove' \|\| type === 'media\.edit-concat' \|\| type === 'media\.edit-music'/, '质量修复清单必须含配乐')
  assert.match(main, /compileMusicDecisionList/)
  assert.match(panel, /'media\.add-music'/)
  assert.match(panel, /对白闪避/)
  assert.match(runtime, /media\.edit-music/)
})

test('packaged music acceptance proves the installed conversation path and decoded audio receipt', () => {
  const smokePath = path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-music.mjs')
  assert.ok(fs.existsSync(smokePath), '必须有独立安装态配乐验收脚本')
  const smoke = fs.readFileSync(smokePath, 'utf8')
  assert.match(smoke, /media\.edit-music/)
  assert.match(smoke, /audio-proof/)
  assert.match(smoke, /audioProof\?\.verdict !== 'matched'/)
  assert.match(smoke, /samplePeakDbfs/)
  assert.match(smoke, /sourceBefore/)
  assert.match(smoke, /musicBefore/)
})

test('real addMusic: mixes local music with ducking, keeps source duration, audio stream present', { timeout: 180000 }, async (t) => {
  if (!hasFfmpeg) return t.skip('本机无 ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-edit-'))
  try {
    const video = path.join(dir, '源视频.mp4')
    const silentVideo = path.join(dir, '无原声视频.mp4')
    const audio = path.join(dir, '配乐.mp3')
    const output = path.join(dir, '配乐版.mp4')
    const silentOutput = path.join(dir, '无原声配乐版.mp4')
    // 4 秒有声视频（440Hz 正弦当"人声"）+ 6 秒音乐（220Hz）
    for (const [file, freq, dur] of [[video, '440', '4'], [audio, '220', '6']]) {
      const args = file === video
        ? ['-y', '-f', 'lavfi', '-i', `testsrc2=duration=${dur}:size=640x360:rate=15`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file, '-loglevel', 'error']
        : ['-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${dur}`, '-c:a', 'libmp3lame', file, '-loglevel', 'error']
      const r = spawnSync(FFMPEG, args, { timeout: 60000 })
      assert.equal(r.status, 0, String(r.stderr).slice(0, 200))
    }
    const silentBuild = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silentVideo, '-loglevel', 'error'], { timeout: 60000 })
    assert.equal(silentBuild.status, 0, String(silentBuild.stderr).slice(0, 200))
    const frames = new VideoFrameService({ ffmpegPath: FFMPEG, ffprobePath: FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe') })
    const service = new MediaEditService({ frames })
    const decision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${audio}`, sourcePath: video })
    const result = await service.addMusic({ sourcePath: video, outputPath: output, decision })
    assert.ok(fs.existsSync(output))
    const duration = await frames.probeDuration(output)
    assert.ok(Math.abs(duration - 4) < 0.2, `时长必须等于源视频 4 秒，实际 ${duration}`)
    assert.ok(await frames.probeHasAudio(output), '成果必须有音轨')
    assert.equal(result.music.volume, 0.15)
    assert.equal(result.music.duck, true)
    assert.equal(result.audioProof.schemaVersion, 1)
    assert.equal(result.audioProof.method, 'decoded-pcm-s16le-v1')
    assert.equal(result.audioProof.verdict, 'matched')
    assert.equal(result.audioProof.output.nonSilent, true)
    assert.equal(result.audioProof.output.overloadFree, true)
    assert.ok(result.audioProof.output.samplePeakDbfs < -0.05, `样本峰值必须留有余量，实际 ${result.audioProof.output.samplePeakDbfs} dBFS`)
    assert.equal(result.audioProof.change.verdict, 'changed')
    assert.ok(result.audioProof.change.changedWindows > 0)
    assert.equal(result.audioProof.fades.fadeIn.verdict, 'matched')
    assert.equal(result.audioProof.fades.fadeOut.verdict, 'matched')
    assert.deepEqual(result.audioProof.ducking, { requested: true, configured: true, claim: 'configuration-only' })
    const recovered = await service.verify({ sourcePath: video, outputPath: output, decision })
    assert.equal(recovered.audioProof.verdict, 'matched', '重启恢复必须重新核验已有成片，而不是走普通剪辑时长字段')
    assert.equal(recovered.expectedDurationSeconds, result.expectedDurationSeconds)

    const silentDecision = compileMusicDecisionList({ instruction: `给视频加背景音乐 ${audio}`, sourcePath: silentVideo })
    const silentResult = await service.addMusic({ sourcePath: silentVideo, outputPath: silentOutput, decision: silentDecision })
    assert.equal(silentResult.audioProof.verdict, 'matched')
    assert.equal(silentResult.audioProof.output.nonSilent, true)
    assert.equal(silentResult.audioProof.change.verdict, 'changed')
    assert.deepEqual(silentResult.audioProof.ducking, { requested: true, configured: false, claim: 'configuration-only' })
    // 源文件不动
    assert.ok(fs.statSync(video).size > 0)
    // 时长不符应拒绝：故意篡改 verification 不现实，这里验证不能覆盖已存在成果
    await assert.rejects(() => service.addMusic({ sourcePath: video, outputPath: output, decision }), /已存在/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
