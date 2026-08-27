const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { outputsStillExist } = require('./persistent-document-task')

const KINDS = Object.freeze(['shot', 'narration', 'voice', 'sound-effect'])
const SOUND_KINDS = new Set(['chime', 'whoosh', 'impact', 'ambience'])

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function fingerprint(filePath, fsImpl = fs) { const bytes = fsImpl.readFileSync(filePath); return { bytes: bytes.length, sha256: sha256(bytes) } }
function atomicText(filePath, value, fsImpl = fs) { const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`; fsImpl.writeFileSync(temp, value, 'utf8'); fsImpl.renameSync(temp, filePath) }
function safeJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && !('text' in value)) return value
  const text = String(value?.text || value || '')
  const body = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!body) throw new Error('AI素材规划没有返回JSON对象')
  try { return JSON.parse(body) } catch { throw new Error('AI素材规划JSON无法解析') }
}
function validatePlan(raw, decision) {
  const value = safeJson(raw); const requested = new Set(decision.requestedKinds || [])
  const narration = String(value.narration || '').trim().slice(0, 1200)
  const shotPrompt = String(value.shotPrompt || value.shot_prompt || '').trim().slice(0, 2000)
  const sound = value.soundEffect || value.sound_effect || {}
  const soundEffect = {
    kind: SOUND_KINDS.has(String(sound.kind || '')) ? String(sound.kind) : 'chime',
    label: String(sound.label || 'AI设计音效').trim().slice(0, 120) || 'AI设计音效',
    durationSeconds: Math.max(0.2, Math.min(8, Number(sound.durationSeconds || sound.duration_seconds) || Number(decision.soundEffect?.durationSeconds) || 1)),
    frequencyHz: Math.max(80, Math.min(2400, Number(sound.frequencyHz || sound.frequency_hz) || 880))
  }
  if (requested.has('shot') && shotPrompt.length < 8) throw new Error('补镜头提示词为空或过短')
  if ((requested.has('narration') || requested.has('voice')) && narration.length < 4) throw new Error('旁白内容为空或过短')
  return { schemaVersion: 1, strategy: 'ai-asset-plan-v1', narration, shotPrompt, soundEffect }
}
function sfxSource(plan) {
  const duration = Number(plan.durationSeconds).toFixed(3); const frequency = Math.round(Number(plan.frequencyHz))
  if (plan.kind === 'whoosh') return `anoisesrc=color=pink:duration=${duration}:amplitude=0.45`
  if (plan.kind === 'impact') return `sine=frequency=${Math.max(80, Math.round(frequency / 4))}:duration=${duration}`
  if (plan.kind === 'ambience') return `anoisesrc=color=brown:duration=${duration}:amplitude=0.25`
  return `sine=frequency=${frequency}:duration=${duration}`
}

class AiAssetBundleService {
  constructor({ completePlan, generateImage, synthesizeVoice, frames, fsImpl = fs } = {}) {
    if (typeof completePlan !== 'function' || typeof generateImage !== 'function' || typeof synthesizeVoice !== 'function' || !frames) throw new Error('AI素材包服务依赖不完整')
    this.completePlan = completePlan; this.generateImage = generateImage; this.synthesizeVoice = synthesizeVoice; this.frames = frames; this.fs = fsImpl
  }

  async run({ taskId, decision, modelRoute, sourcePath = '', outputDir, helperPath, approval, checkpoint = {}, signal, onCheckpoint = () => {}, status = () => {} } = {}) {
    if (checkpoint?.stage === 'artifact-written' && checkpoint.result && outputsStillExist(checkpoint.result)) return checkpoint.result
    const requestedKinds = Array.isArray(decision?.requestedKinds) ? decision.requestedKinds : []
    if (decision?.schemaVersion !== 1 || decision.kind !== 'creative.asset-bundle' || decision.strategy !== 'ai-generated-asset-bundle-v1' || !requestedKinds.length || requestedKinds.some((kind) => !KINDS.includes(kind))) throw new Error('AI素材包冻结决策无效')
    if (approval?.action !== 'paid') throw new Error('AI素材包缺少统一付费/上云审批')
    if (!modelRoute || modelRoute.local === true || !modelRoute.providerId || !modelRoute.model) throw new Error('AI素材包缺少冻结云端模型路由')
    const root = path.resolve(String(outputDir || '')); this.fs.mkdirSync(root, { recursive: true })
    if (!this.fs.statSync(root).isDirectory()) throw new Error('AI素材包输出目录不可用')
    const sourceBefore = sourcePath && this.fs.existsSync(sourcePath) ? fingerprint(sourcePath, this.fs) : null
    let plan = checkpoint.assetPlan
    if (!plan) {
      status('正在生成补镜头、旁白和音效的统一素材方案')
      plan = validatePlan(await this.completePlan({ decision, modelRoute, signal }), decision)
      onCheckpoint({ stage: 'asset-plan-written', assetPlan: plan, assetPlanSha256: sha256(JSON.stringify(plan)) })
    } else {
      plan = validatePlan(plan, decision)
    }
    const artifactPaths = { ...(checkpoint.artifactPaths || {}) }
    const intermediate = { ...(checkpoint.intermediate || {}) }
    const checkpointArtifacts = (stage) => onCheckpoint({ stage, assetPlan: plan, assetPlanSha256: sha256(JSON.stringify(plan)), artifactPaths, intermediate })

    if (requestedKinds.includes('shot') && !(artifactPaths.shot && this.fs.existsSync(artifactPaths.shot))) {
      status('正在生成补镜头关键画面')
      let imagePath = intermediate.shotImagePath
      if (!(imagePath && this.fs.existsSync(imagePath))) {
        const deterministicImage = path.join(root, `${taskId}-shot-source.png`)
        if (this.fs.existsSync(deterministicImage) && this.fs.statSync(deterministicImage).size > 0) imagePath = deterministicImage
        else { const image = await this.generateImage(modelRoute, { id: `${taskId}-shot-source`, prompt: plan.shotPrompt, ...(modelRoute.providerId === 'agnes' ? { model: 'agnes-image-2.1-flash' } : {}), size: '1280x720', outputDir: root, signal }); imagePath = image.outputPath }
        intermediate.shotImagePath = imagePath; intermediate.shotImageSha256 = fingerprint(imagePath, this.fs).sha256; checkpointArtifacts('shot-image-written')
      }
      status('正在把AI关键画面渲染成可剪辑补镜头')
      const outputPath = path.join(root, `${taskId}-补镜头.mp4`); const duration = Number(decision.shot?.durationSeconds) || 3; const frames = Math.max(24, Math.round(duration * 24))
      if (!(this.fs.existsSync(outputPath) && this.fs.statSync(outputPath).size > 1024)) await this.frames.run(['-hide_banner', '-nostdin', '-loop', '1', '-i', imagePath, '-vf', `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0015,1.06)':d=${frames}:s=1280x720:fps=24,format=yuv420p`, '-t', duration.toFixed(3), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart', '-y', outputPath], { timeoutMs: 300000, signal })
      artifactPaths.shot = outputPath; checkpointArtifacts('shot-written')
    }
    if (requestedKinds.includes('narration') && !(artifactPaths.narration && this.fs.existsSync(artifactPaths.narration))) {
      status('正在写出AI旁白')
      const outputPath = path.join(root, `${taskId}-旁白.txt`); if (!this.fs.existsSync(outputPath)) atomicText(outputPath, `${plan.narration}\n`, this.fs); artifactPaths.narration = outputPath; checkpointArtifacts('narration-written')
    }
    if (requestedKinds.includes('voice') && !(artifactPaths.voice && this.fs.existsSync(artifactPaths.voice))) {
      status('正在生成旁白配音')
      const voiceId = `${taskId}-配音`; const existingVoice = ['.wav', '.aiff'].map((ext) => path.join(root, `${voiceId}${ext}`)).find((item) => this.fs.existsSync(item) && this.fs.statSync(item).size >= 1000)
      const voice = existingVoice ? { outputPath: existingVoice, engine: path.extname(existingVoice) === '.aiff' ? 'macos-say' : 'system-speech-recovered' } : await this.synthesizeVoice({ id: voiceId, text: plan.narration, outputDir: root, helperPath, rate: 0, signal })
      artifactPaths.voice = voice.outputPath; intermediate.voiceEngine = voice.engine; checkpointArtifacts('voice-written')
    }
    if (requestedKinds.includes('sound-effect') && !(artifactPaths['sound-effect'] && this.fs.existsSync(artifactPaths['sound-effect']))) {
      status('正在合成AI设计音效')
      const outputPath = path.join(root, `${taskId}-音效.wav`); const duration = Number(plan.soundEffect.durationSeconds)
      if (!(this.fs.existsSync(outputPath) && this.fs.statSync(outputPath).size > 1000)) await this.frames.run(['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', sfxSource(plan.soundEffect), '-af', `afade=t=in:st=0:d=${Math.min(0.08, duration / 4).toFixed(3)},afade=t=out:st=${Math.max(0, duration - Math.min(0.25, duration / 2)).toFixed(3)}:d=${Math.min(0.25, duration / 2).toFixed(3)},volume=0.3`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', outputPath], { timeoutMs: 120000, signal })
      artifactPaths['sound-effect'] = outputPath; checkpointArtifacts('sound-effect-written')
    }

    const methods = { shot: 'ai-image+local-motion', narration: 'cloud-text', voice: 'ai-text+system-speech', 'sound-effect': 'ai-designed+deterministic-synthesis' }
    const artifacts = requestedKinds.map((kind) => {
      const filePath = path.resolve(String(artifactPaths[kind] || '')); if (!this.fs.existsSync(filePath) || !this.fs.statSync(filePath).isFile()) throw new Error(`缺少${kind}成果`)
      return { kind, path: filePath, ...fingerprint(filePath, this.fs), aiGenerated: true, generationMethod: methods[kind], providerId: modelRoute.providerId, model: modelRoute.model }
    })
    const mediaProof = {}
    if (artifactPaths.shot) mediaProof.shot = { durationSeconds: Number((await this.frames.probeDuration(artifactPaths.shot, { signal })).toFixed(3)), ...(await this.frames.probeDimensions(artifactPaths.shot, { signal })) }
    if (artifactPaths.voice) { const levels = typeof this.frames.probeAudioLevels === 'function' ? await this.frames.probeAudioLevels(artifactPaths.voice, { signal }) : null; mediaProof.voice = { durationSeconds: Number((await this.frames.probeDuration(artifactPaths.voice, { signal })).toFixed(3)), hasAudio: await this.frames.probeHasAudio(artifactPaths.voice, { signal }), samplePeakDbfs: levels?.samplePeakDbfs ?? null, nonSilent: Number(levels?.samplePeakDbfs) > -60 } }
    if (artifactPaths['sound-effect']) { const levels = typeof this.frames.probeAudioLevels === 'function' ? await this.frames.probeAudioLevels(artifactPaths['sound-effect'], { signal }) : null; mediaProof.soundEffect = { durationSeconds: Number((await this.frames.probeDuration(artifactPaths['sound-effect'], { signal })).toFixed(3)), hasAudio: await this.frames.probeHasAudio(artifactPaths['sound-effect'], { signal }), samplePeakDbfs: levels?.samplePeakDbfs ?? null, nonSilent: Number(levels?.samplePeakDbfs) > -60 } }
    if (sourceBefore) { const sourceAfter = fingerprint(sourcePath, this.fs); if (sourceAfter.sha256 !== sourceBefore.sha256 || sourceAfter.bytes !== sourceBefore.bytes) throw new Error('AI素材生成期间源视频发生变化') }
    const receiptCore = { schemaVersion: 1, kind: 'agentplay.ai-asset-bundle-receipt', verdict: 'matched', approvalAction: 'paid', sourceMediaUploaded: false, requestedKinds, model: { providerId: modelRoute.providerId, providerName: modelRoute.providerName || modelRoute.providerId, model: modelRoute.model, local: false }, artifacts, mediaProof, recovery: { repeatedCloudCalls: 0, resumedFromCheckpoint: Boolean(checkpoint.assetPlan || checkpoint.artifactPaths) }, ...(sourceBefore ? { source: { name: path.basename(sourcePath), ...sourceBefore } } : {}), ...(intermediate.shotImageSha256 ? { intermediate: { shotImageSha256: intermediate.shotImageSha256 } } : {}) }
    const manifestPath = path.join(root, `${taskId}-AI生成来源.json`); atomicText(manifestPath, `${JSON.stringify(receiptCore, null, 2)}\n`, this.fs)
    const aiAssetReceipt = { ...receiptCore, manifest: { path: manifestPath, ...fingerprint(manifestPath, this.fs) } }
    const outputs = [...artifacts.map((item) => item.path), manifestPath]
    const result = { success: true, outputPath: artifactPaths.shot || artifactPaths.voice || artifactPaths['sound-effect'] || artifactPaths.narration, outputs, aiAssetReceipt, summary: `已生成${requestedKinds.map((kind) => ({ shot: '补镜头', narration: '旁白', voice: '配音', 'sound-effect': '音效' })[kind]).join('、')}；${artifacts.length}项成果均带AI生成来源和SHA-256，源视频未上传、未覆盖` }
    onCheckpoint({ stage: 'artifact-written', assetPlan: plan, assetPlanSha256: sha256(JSON.stringify(plan)), artifactPaths, intermediate, result })
    return result
  }
}

module.exports = { AiAssetBundleService, validatePlan, sfxSource }
