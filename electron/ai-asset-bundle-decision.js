const path = require('node:path')

const CONSULTATION = /能不能|可不可以|可以吗|是否|怎么|如何|支不支持|\?|？/
const NEGATION = /不要|不用|无需|取消|别生成|别补|不需要/
const EXAMPLE = /例如|比如|假如|如果|举例/
const LOCAL_MEDIA_PATH = /(?:[A-Za-z]:)?[\\/][^\n，。；;]+\.(?:wav|mp3|m4a|aac|flac|ogg|mp4|mov|mkv|webm)/i

function portableBasename(value) { return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '' }
function secondsNear(text, noun, fallback) {
  const at = text.indexOf(noun)
  const nearby = at >= 0 ? text.slice(Math.max(0, at - 18), at + noun.length + 4) : text
  const values = [...nearby.matchAll(/(\d+(?:\.\d+)?)\s*秒/g)].map((item) => Number(item[1])).filter(Number.isFinite)
  return Math.max(0.2, Math.min(8, values.at(-1) || fallback))
}

function compileAiAssetBundleDecision({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!text || CONSULTATION.test(text) || NEGATION.test(text) || EXAMPLE.test(text)) return { matched: false }
  if (LOCAL_MEDIA_PATH.test(text) && !/(?:AI|生成|合成|创作)/i.test(text)) return { matched: false }
  const requestedKinds = []
  if (/(?:补|生成|创作|做)(?:一个|一段|一条|个|段|条)?[^，。；]{0,18}(?:镜头|画面|空镜|B\s*roll)/i.test(text)) requestedKinds.push('shot')
  if (/(?:生成|写|补|创作)[^，。；]{0,16}旁白|旁白[^，。；]{0,8}(?:文案|台词)/.test(text)) requestedKinds.push('narration')
  if (/(?:生成|合成|制作|配)[^，。；]{0,12}(?:配音|旁白声音)|(?:旁白|文案)[^，。；]{0,8}配音/.test(text)) requestedKinds.push('voice')
  if (/(?:AI|生成|合成|制作|补)[^，。；]{0,16}(?:音效|提示音|环境声|转场音)/i.test(text)) requestedKinds.push('sound-effect')
  if (!requestedKinds.length) return { matched: false }
  if (requestedKinds.includes('voice') && !requestedKinds.includes('narration')) requestedKinds.splice(requestedKinds.indexOf('voice'), 0, 'narration')
  const ordered = ['shot', 'narration', 'voice', 'sound-effect'].filter((kind) => requestedKinds.includes(kind))
  return {
    matched: true,
    decision: {
      schemaVersion: 1,
      kind: 'creative.asset-bundle',
      strategy: 'ai-generated-asset-bundle-v1',
      instruction: text,
      requestedKinds: ordered,
      ...(source ? { source: { path: source, name: portableBasename(source) || path.basename(source) } } : {}),
      shot: { durationSeconds: secondsNear(text, '镜头', 3), width: 1280, height: 720, motion: 'subtle-push' },
      soundEffect: { durationSeconds: secondsNear(text, /提示音/.test(text) ? '提示音' : '音效', 1) },
      safety: { approvalAction: 'paid', uploadSourceMedia: false, markAiGeneratedSource: true, overwrite: false },
      output: { overwrite: false, bundle: true, suffix: 'AI素材包' },
      verification: { requireProvenanceManifest: true, requireArtifactHashes: true, requireNoSourceUpload: true, requireRecoveryZeroRepeat: true }
    }
  }
}

module.exports = { compileAiAssetBundleDecision, secondsNear }
