const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileBurnSubtitlesDecisionList } = require('../electron/media-edit-decision')
const { SubtitlePreviewBurnParityService, parseSubtitleCueLedger } = require('../electron/subtitle-preview-burn-parity-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const SOURCE = 'D:/video/source.mp4'

test('D5 cue ledger covers every SRT, VTT and ASS event with stable text, timing and layout hashes', () => {
  const srt = '1\n00:00:00,500 --> 00:00:01,500\n第一行\n第二行\n\n2\n00:00:02,000 --> 00:00:03,250\n第二条\n\n'
  const vtt = 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500 align:middle\nFirst line\nSecond line\n\n00:02.000 --> 00:03.250\nSecond cue\n'
  const ass = '[Script Info]\nPlayResX: 1280\nPlayResY: 720\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Layout,Microsoft YaHei,37,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,2,0,2,20,20,65,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.50,0:00:01.50,Layout,,0,0,0,,First line\\NSecond line\nDialogue: 0,0:00:02.00,0:00:03.25,Layout,,0,0,0,,Second cue\n'
  for (const [extension, content] of [['.srt', srt], ['.vtt', vtt], ['.ass', ass]]) {
    const ledger = parseSubtitleCueLedger(content, extension)
    assert.equal(ledger.cues.length, 2, extension)
    assert.deepEqual(ledger.cues.map((item) => [item.startMs, item.endMs]), [[500, 1500], [2000, 3250]], extension)
    assert.equal(ledger.cues[0].lineCount, 2, extension)
    assert.ok(ledger.cues.every((item) => /^[a-f0-9]{64}$/.test(item.cueSha256)), extension)
    assert.match(ledger.cueLedgerSha256, /^[a-f0-9]{64}$/)
  }
})

test('D5 single-render proof makes preview and delivery the same bytes and rejects changed subtitle contract', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-d5-parity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const subtitlePath = path.join(directory, 'layout.ass')
  const outputPath = path.join(directory, 'final.mp4')
  fs.writeFileSync(subtitlePath, '[Script Info]\nPlayResX: 640\nPlayResY: 360\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,第一条\\N第二行\nDialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,第二条\n')
  fs.writeFileSync(outputPath, Buffer.from('000000206674797069736f6dagentplay-d5-final-artifact'.padEnd(2048, '0')))
  const service = new SubtitlePreviewBurnParityService()
  const frozen = await service.freeze({ subtitlePath, renderFilter: "subtitles='layout.ass'" })
  const proof = await service.finalize({ subtitlePath, outputPath, renderFilter: "subtitles='layout.ass'", frozen })
  assert.equal(proof.method, 'single-render-subtitle-preview-burn-v1')
  assert.equal(proof.verdict, 'matched')
  assert.equal(proof.sameArtifact, true)
  assert.equal(proof.preview.artifactSha256, proof.final.artifactSha256)
  assert.equal(proof.preview.path, proof.final.path)
  assert.equal(proof.cueCount, 2)
  assert.ok(proof.cues.every((item) => item.matched && item.previewCueSha256 === item.finalCueSha256))

  fs.appendFileSync(subtitlePath, '\nDialogue: 0,0:00:03.10,0:00:03.50,Default,,0,0,0,,篡改\n')
  await assert.rejects(() => service.finalize({ subtitlePath, outputPath, renderFilter: "subtitles='layout.ass'", frozen }), /字幕文件.*变化/)
})

test('D5 burn decision and quality gate require full cue parity plus same-artifact preview', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-d5-quality-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const outputPath = path.join(directory, 'final.mp4')
  const bytes = Buffer.alloc(2048)
  bytes.writeUInt32BE(32, 0); bytes.write('ftyp', 4, 'ascii')
  fs.writeFileSync(outputPath, bytes)
  const decision = compileBurnSubtitlesDecisionList({ instruction: '把字幕 D:/video/layout.ass 烧录到视频', sourcePath: SOURCE })
  assert.equal(decision.verification.requirePreviewBurnParity, true)
  const cue = { index: 1, startMs: 500, endMs: 1500, lineCount: 1, previewCueSha256: 'a'.repeat(64), finalCueSha256: 'a'.repeat(64), matched: true }
  const result = {
    success: true,
    outputPath,
    outputs: [outputPath],
    durationSeconds: 4,
    expectedDurationSeconds: 4,
    timelineReceipt: [{ operation: '烧录字幕', sourceRange: '00:00.000 → 00:04.000', outputRange: '00:00.000 → 00:04.000' }],
    projectCapsule: { schemaVersion: 1, projectId: 'edit-d5', versionId: 'version-2', versionCount: 2, cursor: 1, canUndo: true, currentPath: outputPath },
    subtitlePreviewBurnProof: {
      schemaVersion: 1, method: 'single-render-subtitle-preview-burn-v1', verdict: 'matched', sameArtifact: true,
      cueCount: 1, cueLedgerSha256: 'b'.repeat(64), preview: { path: outputPath, artifactSha256: 'c'.repeat(64) }, final: { path: outputPath, artifactSha256: 'c'.repeat(64) }, cues: [cue]
    }
  }
  const passed = evaluateTaskResult('media.edit-burn-subtitles', result, { decision })
  assert.equal(passed.passed, true)
  const missing = evaluateTaskResult('media.edit-burn-subtitles', { ...result, subtitlePreviewBurnProof: null }, { decision })
  assert.equal(missing.passed, false)
  assert.ok(missing.reasons.some((item) => item.code === 'SUBTITLE_PREVIEW_BURN_PARITY_FAILED'))
  const mismatched = evaluateTaskResult('media.edit-burn-subtitles', { ...result, subtitlePreviewBurnProof: { ...result.subtitlePreviewBurnProof, sameArtifact: false } }, { decision })
  assert.equal(mismatched.passed, false)
})

test('D5 wiring persists parity proof, restores it, and surfaces the final bytes as the preview', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'media-edit-service.js'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-subtitle-preview-burn-d5.mjs'), 'utf8')
  const packagedBurn = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-media-burn-subtitles.mjs'), 'utf8')
  assert.match(service, /SubtitlePreviewBurnParityService/)
  assert.match(service, /subtitlePreviewBurnProof/)
  assert.match(main, /preview and final use the same frozen artifact|预览与最终烧录使用同一冻结成果/)
  assert.match(runtime, /字幕预览与最终烧录逐条一致/)
  assert.match(smoke, /smoke-packaged-media-burn-subtitles/)
  for (const marker of ['expectedCueCount', 'sameArtifact', 'previewCueSha256', 'finalCueSha256', 'requirePreviewBurnParity']) assert.match(packagedBurn, new RegExp(marker))
})
