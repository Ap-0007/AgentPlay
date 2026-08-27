const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { compileAiAssetBundleDecision } = require('../electron/ai-asset-bundle-decision')
const { AiAssetBundleService } = require('../electron/ai-asset-bundle-service')
const { evaluateTaskResult } = require('../electron/task-result-quality')

const SOURCE = 'D:/video/source.mp4'
const INSTRUCTION = '给当前视频补一个3秒镜头，生成一段旁白和配音，再生成1秒清脆提示音'

function mediaFile(filePath, kind) {
  const bytes = Buffer.alloc(4096)
  if (kind === 'mp4') { bytes.writeUInt32BE(32, 0); bytes.write('ftyp', 4, 'ascii') }
  else { bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(4088, 4); bytes.write('WAVE', 8, 'ascii') }
  fs.writeFileSync(filePath, bytes)
}

test('E1 explicit request freezes shot, narration, voice and sound-effect kinds while consultation stays non-executing', () => {
  const result = compileAiAssetBundleDecision({ instruction: INSTRUCTION, sourcePath: SOURCE })
  assert.equal(result.matched, true)
  assert.equal(result.decision.kind, 'creative.asset-bundle')
  assert.equal(result.decision.strategy, 'ai-generated-asset-bundle-v1')
  assert.deepEqual(result.decision.requestedKinds, ['shot', 'narration', 'voice', 'sound-effect'])
  assert.equal(result.decision.shot.durationSeconds, 3)
  assert.equal(result.decision.soundEffect.durationSeconds, 1)
  assert.equal(result.decision.safety.approvalAction, 'paid')
  assert.equal(result.decision.safety.uploadSourceMedia, false)
  assert.equal(compileAiAssetBundleDecision({ instruction: '能不能帮我生成旁白和音效？', sourcePath: SOURCE }).matched, false)
  assert.equal(compileAiAssetBundleDecision({ instruction: '不要生成补镜头和配音', sourcePath: SOURCE }).matched, false)
  assert.equal(compileAiAssetBundleDecision({ instruction: '给视频添加本地音效 D:/audio/ding.wav', sourcePath: SOURCE }).matched, false)
})

test('E1 service creates four real artifacts plus a hash-bound AI provenance manifest', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-e1-assets-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.mp4'); mediaFile(source, 'mp4'); const sourceBefore = fs.readFileSync(source)
  const decision = compileAiAssetBundleDecision({ instruction: INSTRUCTION, sourcePath: source }).decision
  const calls = { plan: 0, image: 0, voice: 0, ffmpeg: 0 }
  const checkpoints = []
  const service = new AiAssetBundleService({
    completePlan: async () => { calls.plan += 1; return { narration: '效率不是加速，而是少走弯路。', shotPrompt: '清晨办公室，柔和阳光扫过整洁桌面，缓慢推镜', soundEffect: { kind: 'chime', label: '清脆确认音', durationSeconds: 1, frequencyHz: 880 } } },
    generateImage: async (_config, input) => { calls.image += 1; const outputPath = path.join(input.outputDir, `${input.id}.png`); fs.writeFileSync(outputPath, Buffer.from('89504e470d0a1a0a', 'hex')); return { success: true, outputPath, bytes: 8 } },
    synthesizeVoice: async (input) => { calls.voice += 1; const outputPath = path.join(input.outputDir, 'voice.wav'); mediaFile(outputPath, 'wav'); return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'windows-sapi' } },
    frames: {
      availability: () => ({ available: true }),
      run: async (args) => { calls.ffmpeg += 1; const outputPath = args.at(-1); mediaFile(outputPath, path.extname(outputPath) === '.mp4' ? 'mp4' : 'wav') },
      probeDuration: async (filePath) => path.extname(filePath) === '.mp4' ? 3 : 1,
      probeDimensions: async () => ({ width: 1280, height: 720 }),
      probeHasAudio: async (filePath) => path.extname(filePath) !== '.mp4',
      probeAudioLevels: async () => ({ meanVolumeDbfs: -20, samplePeakDbfs: -3 })
    }
  })
  const result = await service.run({
    taskId: 'e1-test', decision, modelRoute: { providerId: 'agnes', providerName: 'Agnes AI', model: 'agnes-2.5-flash', local: false },
    sourcePath: source, outputDir: directory, helperPath: 'voice-helper.exe', approval: { action: 'paid' },
    onCheckpoint: (value) => checkpoints.push(value)
  })
  assert.deepEqual(calls, { plan: 1, image: 1, voice: 1, ffmpeg: 2 })
  assert.equal(result.outputs.length, 5, '补镜头、旁白、配音、音效和来源清单')
  assert.equal(result.aiAssetReceipt.artifacts.length, 4)
  assert.deepEqual(result.aiAssetReceipt.requestedKinds, decision.requestedKinds)
  assert.equal(result.aiAssetReceipt.sourceMediaUploaded, false)
  assert.ok(result.aiAssetReceipt.artifacts.every((item) => item.aiGenerated === true && /^[a-f0-9]{64}$/.test(item.sha256) && fs.existsSync(item.path)))
  assert.equal(result.aiAssetReceipt.artifacts.find((item) => item.kind === 'voice').generationMethod, 'ai-text+system-speech')
  assert.equal(result.aiAssetReceipt.artifacts.find((item) => item.kind === 'sound-effect').generationMethod, 'ai-designed+deterministic-synthesis')
  assert.deepEqual(fs.readFileSync(source), sourceBefore)
  assert.equal(checkpoints.at(-1).stage, 'artifact-written')
  const partial = checkpoints.find((item) => item.stage === 'sound-effect-written')
  fs.rmSync(result.aiAssetReceipt.manifest.path, { force: true })
  const callsBeforeRecovery = { ...calls }
  const recovered = await service.run({ taskId: 'e1-test', decision, modelRoute: { providerId: 'agnes', providerName: 'Agnes AI', model: 'agnes-2.5-flash', local: false }, sourcePath: source, outputDir: directory, helperPath: 'voice-helper.exe', approval: { action: 'paid' }, checkpoint: partial })
  assert.deepEqual(calls, callsBeforeRecovery, '部分成果恢复不得重复模型、生图、配音或ffmpeg步骤')
  assert.equal(recovered.aiAssetReceipt.recovery.resumedFromCheckpoint, true)
})

test('E1 artifact-written recovery reuses every output and performs zero repeated model or generation calls', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-e1-recovery-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'narration.txt'); const manifest = path.join(directory, 'manifest.json'); fs.writeFileSync(output, '已完成旁白'); fs.writeFileSync(manifest, '{}')
  const completed = { success: true, outputPath: output, outputs: [output, manifest], aiAssetReceipt: { schemaVersion: 1 } }
  const service = new AiAssetBundleService({ completePlan: async () => { throw new Error('恢复不应调用模型') }, generateImage: async () => { throw new Error('恢复不应生图') }, synthesizeVoice: async () => { throw new Error('恢复不应配音') }, frames: {} })
  const result = await service.run({ taskId: 'e1-recovery', decision: { schemaVersion: 1, kind: 'creative.asset-bundle', strategy: 'ai-generated-asset-bundle-v1', requestedKinds: ['narration'] }, checkpoint: { stage: 'artifact-written', result: completed }, outputDir: directory })
  assert.deepEqual(result, completed)
})

test('E1 quality is 100 only with paid approval, no source upload, exact kinds and hash-valid provenance', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-e1-quality-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const files = { shot: path.join(directory, 'shot.mp4'), narration: path.join(directory, 'narration.txt'), voice: path.join(directory, 'voice.wav'), 'sound-effect': path.join(directory, 'sfx.wav') }
  mediaFile(files.shot, 'mp4'); fs.writeFileSync(files.narration, '真实旁白内容'); mediaFile(files.voice, 'wav'); mediaFile(files['sound-effect'], 'wav')
  const crypto = require('node:crypto'); const artifact = (kind) => ({ kind, path: files[kind], bytes: fs.statSync(files[kind]).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(files[kind])).digest('hex'), aiGenerated: true, generationMethod: kind === 'voice' ? 'ai-text+system-speech' : kind === 'sound-effect' ? 'ai-designed+deterministic-synthesis' : kind === 'shot' ? 'ai-image+local-motion' : 'cloud-text' })
  const artifacts = ['shot', 'narration', 'voice', 'sound-effect'].map(artifact); const manifest = path.join(directory, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ artifacts }))
  const manifestHash = crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex')
  const result = { success: true, outputPath: files.shot, outputs: [...Object.values(files), manifest], aiAssetReceipt: { schemaVersion: 1, kind: 'agentplay.ai-asset-bundle-receipt', verdict: 'matched', approvalAction: 'paid', sourceMediaUploaded: false, requestedKinds: ['shot', 'narration', 'voice', 'sound-effect'], model: { providerId: 'agnes', model: 'agnes-2.5-flash', local: false }, artifacts, manifest: { path: manifest, bytes: fs.statSync(manifest).size, sha256: manifestHash }, recovery: { repeatedCloudCalls: 0 }, mediaProof: { shot: { durationSeconds: 3, width: 1280, height: 720 }, voice: { durationSeconds: 1, hasAudio: true, nonSilent: true, samplePeakDbfs: -3 }, soundEffect: { durationSeconds: 1, hasAudio: true, nonSilent: true, samplePeakDbfs: -3 } } } }
  const spec = { approval: { action: 'paid' }, decision: { requestedKinds: ['shot', 'narration', 'voice', 'sound-effect'] } }
  const passed = evaluateTaskResult('creative.asset-bundle', result, spec); assert.equal(passed.passed, true); assert.equal(passed.score, 100)
  const failed = evaluateTaskResult('creative.asset-bundle', { ...result, aiAssetReceipt: { ...result.aiAssetReceipt, sourceMediaUploaded: true } }, spec)
  assert.equal(failed.passed, false); assert.ok(failed.reasons.some((item) => item.code === 'AI_ASSET_SOURCE_UPLOAD_VIOLATION'))
})

test('E1 is wired through one persistent task, native approval, conversation, notification and installed acceptance', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8')
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'useMediaCreativeTasks.ts'), 'utf8')
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'agent-panel', 'usePersistentTaskRuntime.ts'), 'utf8')
  const notifications = fs.readFileSync(path.join(__dirname, '..', 'electron', 'task-notification-service.js'), 'utf8')
  const router = fs.readFileSync(path.join(__dirname, '..', 'electron', 'model-performance-router.js'), 'utf8')
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke-packaged-ai-assets-e1.mjs'), 'utf8')
  assert.match(main, /register\('creative\.asset-bundle'/)
  assert.match(main, /approval: \{ action: 'paid'/)
  assert.match(main, /sourceMediaUploaded: false/)
  assert.match(preload, /studio:asset-bundle-plan/); assert.match(preload, /studio:asset-bundle-run/)
  assert.match(renderer, /runAiAssetBundleTask/); assert.match(runtime, /creative\.asset-bundle/)
  assert.match(notifications, /creative\.asset-bundle/); assert.match(router, /creative\.asset-bundle/)
  for (const marker of ['preApprovalCalls', 'requestedKinds', 'sourceMediaUploaded', 'qualityScore', 'recoveryZeroCalls', 'aiGenerated']) assert.match(smoke, new RegExp(marker))
})
