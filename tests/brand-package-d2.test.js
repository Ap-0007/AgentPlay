const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')

const { compileVisualEffectDecision } = require('../electron/visual-effect-decision')
const { BrandPackageService, buildBrandAssDocument, compileBrandPackageTimeline } = require('../electron/brand-package-service')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { attachEditDecisionList, assertEditDecisionList } = require('../electron/edit-decision-list')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const SOURCE = 'D:\\Videos\\demo.mp4'
const INSTRUCTION = '按清爽科技品牌模板包装视频；标题《AgentPlay 新功能》；章节：第3秒《导入素材》、第7秒《自动成片》；人物《吴光｜产品负责人》；角标《AgentPlay》；片尾《一句话完成视频》'

function decision(source = SOURCE) {
  const result = compileVisualEffectDecision({ instruction: INSTRUCTION, sourcePath: source })
  assert.equal(result.matched, true)
  assert.ok(result.decision)
  return attachEditDecisionList(result.decision)
}

test('D2 freezes one brand-package effect with five explicit human-facing elements', () => {
  const frozen = decision()
  assert.equal(frozen.kind, 'media.visual-effects')
  assert.deepEqual(frozen.effects.map((item) => item.type), ['brand-package'])
  assert.equal(frozen.brandPackage.schemaVersion, 1)
  assert.equal(frozen.brandPackage.strategy, 'ass-brand-package-v1')
  assert.equal(frozen.brandPackage.template.id, 'clean-tech')
  assert.equal(frozen.brandPackage.title.text, 'AgentPlay 新功能')
  assert.deepEqual(frozen.brandPackage.chapters.map((item) => [item.atSeconds, item.text]), [[3, '导入素材'], [7, '自动成片']])
  assert.deepEqual(frozen.brandPackage.person, { name: '吴光', role: '产品负责人' })
  assert.equal(frozen.brandPackage.corner.text, 'AgentPlay')
  assert.equal(frozen.brandPackage.outro.text, '一句话完成视频')
  assert.deepEqual(frozen.verification.expectedBrandElements, ['title', 'chapters', 'person', 'corner', 'outro'])
  assert.doesNotThrow(() => assertEditDecisionList(frozen))
})

test('D2 does not execute consultation or an underspecified engineering-style template request', () => {
  assert.equal(compileVisualEffectDecision({ instruction: '能不能做品牌模板？', sourcePath: SOURCE }).matched, false)
  const missing = compileVisualEffectDecision({ instruction: '按品牌模板包装一下', sourcePath: SOURCE })
  assert.equal(missing.matched, true)
  assert.equal(missing.decision, undefined)
  assert.match(missing.review.summary, /标题.*章节.*人物.*角标.*片尾/)
})

test('D2 accepts one requested brand element without forcing the other four', () => {
  const result = compileVisualEffectDecision({ instruction: '按清爽科技品牌模板加角标《AgentPlay》', sourcePath: SOURCE })
  assert.equal(result.matched, true)
  assert.ok(result.decision)
  assert.equal(result.decision.brandPackage.corner.text, 'AgentPlay')
  assert.equal(result.decision.brandPackage.title, undefined)
  assert.deepEqual(result.decision.verification.expectedBrandElements, ['corner'])
  const outroOnly = compileVisualEffectDecision({ instruction: '给视频加片尾《谢谢观看》', sourcePath: SOURCE })
  assert.equal(outroOnly.decision.brandPackage.outro.text, '谢谢观看')
  assert.deepEqual(outroOnly.decision.verification.expectedBrandElements, ['outro'])
})

test('D2 compiles bounded title, chapter, person, corner and outro timing from source duration', () => {
  const timeline = compileBrandPackageTimeline(decision().brandPackage, 12)
  assert.equal(timeline.title.startSeconds, 0.2)
  assert.ok(timeline.title.endSeconds <= 2.8)
  assert.deepEqual(timeline.chapters.map((item) => item.startSeconds), [3, 7])
  assert.ok(timeline.person.endSeconds <= 5)
  assert.ok(timeline.corner.endSeconds <= timeline.outro.startSeconds)
  assert.equal(timeline.outro.endSeconds, 12)
  assert.ok(timeline.outro.startSeconds >= 9)
})

test('D2 ASS document uses template styles and neutralizes raw ASS injection', () => {
  const frozen = decision()
  const timeline = compileBrandPackageTimeline({ ...frozen.brandPackage, title: { text: '{\\pos(0,0)}危险标题' } }, 12)
  const ass = buildBrandAssDocument({ brandPackage: frozen.brandPackage, timeline, dimensions: { width: 640, height: 360 } })
  assert.match(ass, /Style: BrandTitle/)
  assert.match(ass, /Style: BrandChapter/)
  assert.match(ass, /Style: BrandPerson/)
  assert.match(ass, /Style: BrandCorner/)
  assert.match(ass, /Style: BrandOutro/)
  assert.doesNotMatch(ass, /\{\\pos\(0,0\)\}危险标题/)
  assert.match(ass, /｛＼pos\(0,0\)｝危险标题/)
})

test('D2 real render proves all five overlay families in their frozen screen regions', { timeout: 180000 }, async (t) => {
  const ffmpeg = process.env.AIPLAYER_FFMPEG || path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe')
  const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return t.skip('本机无ffmpeg')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-brand-package-d2-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.mp4'); const output = path.join(dir, 'brand.mp4')
  const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=20:d=12', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'], { timeout: 60000 })
  assert.equal(built.status, 0, String(built.stderr).slice(-500))
  const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
  const service = new MediaEditService({ frames })
  const frozen = decision(source)
  const result = await service.visualEffects({ sourcePath: source, outputPath: output, decision: frozen })
  assert.equal(result.success, true)
  assert.equal(result.brandPackageProof.verdict, 'matched')
  assert.equal(result.brandPackageProof.elements.title.visible, true)
  assert.equal(result.brandPackageProof.elements.chapters.visibleCount, 2)
  assert.equal(result.brandPackageProof.elements.person.visible, true)
  assert.equal(result.brandPackageProof.elements.corner.visible, true)
  assert.equal(result.brandPackageProof.elements.outro.visible, true)
  assert.equal(result.effectReceipt.effectKinds[0], 'brand-package')
  assert.ok(Math.abs(result.durationSeconds - 12) < 0.2)
  assert.equal(await frames.probeHasAudio(output), true)
})

test('D2 quality reaches 100 only with all five brand pixel proofs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-brand-package-quality-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const output = path.join(dir, 'brand.mp4'); fs.writeFileSync(output, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048)]))
  const frozen = decision('D:/source.mp4')
  const proof = { schemaVersion: 1, method: 'brand-package-pixel-proof-v1', verdict: 'matched', templateId: 'clean-tech', elements: { title: { visible: true }, chapters: { count: 2, visibleCount: 2 }, person: { visible: true }, corner: { visible: true }, outro: { visible: true } } }
  const result = {
    success: true, outputs: [output], durationSeconds: 12, expectedDurationSeconds: 12,
    effectReceipt: { effectKinds: ['brand-package'], outputDimensions: { width: 640, height: 360 }, dimensionMatch: true, representativeSample: { meanAbsDiff: 2 }, changed: true },
    brandPackageProof: proof,
    projectCapsule: { schemaVersion: 1, projectId: 'edit-d2', currentPath: output, canUndo: true },
    visualQc: { strategy: 'unified-visual-export-qc-v1', passed: true, artifacts: [{ path: output }] }
  }
  const passed = evaluateTaskResult('media.edit-visual-effects', result, { decision: frozen })
  assert.equal(passed.score, 100); assert.equal(passed.passed, true)
  for (const id of ['brand-title', 'brand-chapters', 'brand-person', 'brand-corner', 'brand-outro']) assert.ok(passed.checks.some((item) => item.id === id && item.passed), id)
  const failed = evaluateTaskResult('media.edit-visual-effects', { ...result, brandPackageProof: { ...proof, elements: { ...proof.elements, outro: { visible: false } } } }, { decision: frozen })
  assert.equal(failed.passed, false)
  assert.ok(failed.reasons.some((item) => item.code === 'BRAND_OUTRO_MISSING'))
})

test('D2 reuses the visual persistent task, unified QC, conversation and installed acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const media = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
  const quality = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-result-quality.js'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-brand-package-d2.mjs'), 'utf8')
  assert.match(main, /media\.edit-visual-effects/)
  assert.match(media, /brandPackageService\.(?:render|verify)/)
  for (const code of ['BRAND_TITLE_MISSING', 'BRAND_CHAPTERS_MISSING', 'BRAND_PERSON_MISSING', 'BRAND_CORNER_MISSING', 'BRAND_OUTRO_MISSING']) assert.match(quality, new RegExp(code))
  assert.match(renderer, /品牌包装/)
  for (const marker of ['titleVisible', 'chapterVisibleCount', 'personVisible', 'cornerVisible', 'outroVisible', 'quality100', 'sourceHashUnchanged']) assert.match(smoke, new RegExp(marker))
})
