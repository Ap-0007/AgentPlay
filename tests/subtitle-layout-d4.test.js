const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const { compileSubtitleLayoutDecision } = require('../electron/subtitle-layout-decision')
const { SubtitleLayoutService, reflowCueText } = require('../electron/subtitle-layout-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const VIDEO = 'D:\\Videos\\demo.mp4'; const SRT = 'D:\\Videos\\demo.srt'
const INSTRUCTION = `为字幕 ${SRT} 生成横屏360p/720p、竖屏360p/720p、方形360p/720p布局，自动避让，风格强调`

function decision(video = VIDEO, subtitle = SRT, instruction = INSTRUCTION) {
  const result = compileSubtitleLayoutDecision({ instruction: instruction.replace(VIDEO, video).replace(SRT, subtitle), sourcePath: video })
  assert.equal(result.matched, true); assert.ok(result.decision)
  return attachEditDecisionList(result.decision)
}

function srtFixture() {
  return [
    '1\n00:00:00,500 --> 00:00:03,000\nAgentPlay让视频字幕在不同画幅里保持清楚自然',
    '2\n00:00:03,200 --> 00:00:06,000\nKeep every subtitle readable across horizontal and vertical exports',
    '3\n00:00:06,200 --> 00:00:09,000\n短句也要保持稳定位置'
  ].join('\n\n') + '\n'
}

test('D4 freezes six horizontal vertical and square resolution profiles', () => {
  const frozen = decision()
  assert.equal(frozen.kind, 'media.subtitle-layout-variants')
  assert.equal(frozen.subtitleLayout.strategy, 'responsive-ass-layout-v1')
  assert.equal(frozen.subtitleLayout.position, 'auto')
  assert.equal(frozen.subtitleLayout.stylePreset, 'impact')
  assert.deepEqual(frozen.subtitleLayout.profiles.map((item) => [item.aspect, item.width, item.height]), [
    ['16:9', 640, 360], ['16:9', 1280, 720], ['9:16', 360, 640], ['9:16', 720, 1280], ['1:1', 360, 360], ['1:1', 720, 720]
  ])
  assert.equal(frozen.subtitleLayout.profiles.every((item) => item.maximumLines === 2), true)
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
})

test('D4 reflow keeps semantic breaks within two lines and refuses oversized cues', () => {
  const zh = reflowCueText('AgentPlay让视频字幕在不同画幅里保持清楚自然', { maximumUnitsPerLine: 15, maximumLines: 2 })
  assert.equal(zh.lines.length, 2)
  assert.equal(zh.lines.join(''), 'AgentPlay让视频字幕在不同画幅里保持清楚自然')
  const en = reflowCueText('Keep every subtitle readable across horizontal and vertical exports', { maximumUnitsPerLine: 28, maximumLines: 2 })
  assert.equal(en.lines.length, 2)
  assert.equal(en.lines.join(' '), 'Keep every subtitle readable across horizontal and vertical exports')
  assert.throws(() => reflowCueText('这是一个'.repeat(30), { maximumUnitsPerLine: 12, maximumLines: 2 }), /超过两行.*先拆分/)
})

test('D4 real layout export proves font, line count, wrapping, occlusion and position for every profile', { timeout: 180000 }, async (t) => {
  const ffmpeg = process.env.AIPLAYER_FFMPEG || path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe'); const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return t.skip('本机无ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-subtitle-layout-d4-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const video = path.join(dir, 'video.mp4'); const subtitle = path.join(dir, 'demo.srt'); fs.writeFileSync(subtitle, srtFixture(), 'utf8')
  const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=20:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video, '-loglevel', 'error'], { timeout: 60000 })
  assert.equal(built.status, 0, String(built.stderr).slice(-500))
  const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe }); const service = new SubtitleLayoutService({ frames })
  const frozen = decision(video, subtitle, INSTRUCTION.replace(SRT, subtitle))
  const outputs = frozen.subtitleLayout.profiles.map((item) => path.join(dir, `${item.id}.ass`))
  const result = await service.exportLayouts({ sourcePath: video, subtitlePath: subtitle, outputPaths: outputs, decision: frozen })
  assert.equal(result.outputs.length, 6)
  assert.equal(result.layoutProof.verdict, 'matched')
  assert.equal(result.layoutProof.profiles.length, 6)
  for (const profile of result.layoutProof.profiles) {
    assert.ok(profile.fontRatio >= 0.045 && profile.fontRatio <= 0.06)
    assert.ok(profile.maximumObservedLines <= 2)
    assert.equal(profile.wrappingMatched, true)
    assert.equal(profile.occlusionSafe, true)
    assert.equal(profile.positionMatched, true)
    assert.ok(profile.pixelDifference >= 0.004)
  }
})

test('D4 quality reaches 100 only when every resolution profile passes five layout dimensions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-subtitle-layout-quality-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const frozen = decision(); const outputs = frozen.subtitleLayout.profiles.map((profile) => { const output = path.join(dir, `${profile.id}.ass`); fs.writeFileSync(output, '[Script Info]\n[V4+ Styles]\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,Layout,,0,0,0,,字幕\n'); return output })
  const profiles = frozen.subtitleLayout.profiles.map((item) => ({ id: item.id, aspect: item.aspect, width: item.width, height: item.height, fontRatio: 0.052, maximumObservedLines: 2, wrappingMatched: true, occlusionSafe: true, positionMatched: true, pixelDifference: 0.02 }))
  const result = { success: true, outputs, layoutProof: { schemaVersion: 1, method: 'subtitle-layout-pixel-proof-v1', verdict: 'matched', profiles }, projectCapsule: { schemaVersion: 1, projectId: 'edit-d4', currentPath: outputs[0], canUndo: true } }
  const passed = evaluateTaskResult('media.subtitle-layout-variants', result, { decision: frozen })
  assert.equal(passed.score, 100); assert.equal(passed.passed, true)
  for (const id of ['layout-font', 'layout-lines', 'layout-wrapping', 'layout-occlusion', 'layout-position']) assert.ok(passed.checks.some((item) => item.id === id && item.passed), id)
  const failedProfiles = profiles.map((item, index) => index === 2 ? { ...item, maximumObservedLines: 3 } : item)
  const failed = evaluateTaskResult('media.subtitle-layout-variants', { ...result, layoutProof: { ...result.layoutProof, profiles: failedProfiles } }, { decision: frozen })
  assert.equal(failed.passed, false)
  assert.ok(failed.reasons.some((item) => item.code === 'SUBTITLE_LAYOUT_LINES_FAILED'))
})

test('D4 uses one persistent layout task, conversation flow and packaged six-profile acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8'); const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8'); const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8'); const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-subtitle-layout-d4.mjs'), 'utf8')
  assert.match(main, /register\('media\.subtitle-layout-variants'/)
  for (const code of ['SUBTITLE_LAYOUT_FONT_FAILED', 'SUBTITLE_LAYOUT_LINES_FAILED', 'SUBTITLE_LAYOUT_WRAPPING_FAILED', 'SUBTITLE_LAYOUT_OCCLUSION_FAILED', 'SUBTITLE_LAYOUT_POSITION_FAILED']) assert.match(quality, new RegExp(code))
  assert.match(renderer, /多比例字幕布局/)
  for (const marker of ['quality100', 'profileCount', 'fontPassed', 'linesPassed', 'wrappingPassed', 'occlusionPassed', 'positionPassed', 'sourceHashesUnchanged']) assert.match(smoke, new RegExp(marker))
})
